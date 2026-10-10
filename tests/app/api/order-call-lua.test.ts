// @vitest-environment node
// 顧客のスタッフ呼び出し (POST /api/order/call の COMMIT_CALL) と店側の呼出消し込み (POST /api/order/calls の REMOVE_CALL) を
// 本物の Lua で実行する (Lua 登録表の計画 PR-C)。order-call.test.ts・order-calls.test.ts は kvEval を JS で模倣しているため、
// 3 種の拒否 (cooldown・order_limit・velocity) の順と「拒否ではどのキーも変えない」こと・同時呼出の SET NX・
// 一覧の切り詰めと TTL・消し込みの全重複削除は CI で一度も実行されていなかった。route を実際に呼び、lib/kv.ts の実装ごと
// fake Upstash に繋ぐ。handle 解決・IP 制限・店側の認可だけを mock する。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { callListKey, orderListKey, serializeOrder, ORDER_CALL_LIST_MAX, ORDER_CALL_LIST_TTL_SEC, type StoredOrder } from '@/lib/orderRelay';

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TX = `0x${'a'.repeat(64)}`;
const CALLS = callListKey(MERCHANT);
const COOLDOWN = 'order:call:cooldown:coffee:12';
const ORDER_COUNT = `order:call:count:order:${MERCHANT.toLowerCase()}:ORDER1:${TX}`;
const HANDLE_COUNT = 'order:call:count:handle:coffee';

const h = vi.hoisted(() => ({ seq: 0 }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableOrderCall: true, enableShopLive: false } };
});
vi.mock('@/lib/handleStore', () => ({
  resolveHandle: async () => ({
    ok: true,
    record: { config: { to: MERCHANT }, storefront: { dineIn: true, acceptingOrders: true } },
  }),
}));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '203.0.113.1', hashIpBucket: () => 'hash' }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: async () => true }));
vi.mock('@/lib/id', () => ({ randomId: () => `call-${++h.seq}` }));
vi.mock('@/lib/orderFeedAuth', () => ({ resolveOrderFeedMerchant: async () => ({ merchant: MERCHANT }) }));

import { POST as callPOST } from '@/app/api/order/call/route';
import { POST as callsPOST } from '@/app/api/order/calls/route';

let store: FakeRedisStore;

function order(over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: 'ORDER1', items: [], table: 'テーブル 12', amount: '1000000000000000000', txHash: TX, chainId: 137,
    from: '', ts: Date.now() - 60_000, fulfilled: false, ...over,
  };
}
const callRequest = (over: Record<string, unknown> = {}) => new Request('http://localhost/api/order/call', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ h: 'coffee', table: '12', orderId: 'ORDER1', txHash: TX, ...over }),
});
const doneRequest = (id: string) => new Request('http://localhost/api/order/calls', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, done: true }),
});
const calls = () => (store.lists.get(CALLS) ?? []).map((raw) => JSON.parse(raw) as { id: string; table: string });
const snapshot = () => JSON.stringify(store.keys().sort().map((key) => [
  key, store.strings.get(key) ?? store.lists.get(key) ?? null, store.getTtl(key),
]));

beforeEach(() => {
  h.seq = 0;
  store = createFakeRedisStore(1_790_000_000_000);
  store.lists.set(orderListKey(MERCHANT), [serializeOrder(order())]);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(fakeUpstashFetch(store)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('COMMIT_CALL (real Lua)', () => {
  it('許可時は cooldown・注文と handle の回数・呼出一覧を 1 EVAL でまとめて書き、それぞれに TTL を付ける', async () => {
    const res = await callPOST(callRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; call: { id: string } };
    expect(body).toMatchObject({ ok: true, call: { id: 'call-1', handle: 'coffee', table: '12' } });
    expect(calls()).toEqual([body.call]);
    expect(store.getTtl(CALLS)).toBe(ORDER_CALL_LIST_TTL_SEC);
    expect(store.strings.get(COOLDOWN)).toBe('1');
    expect(store.getTtl(COOLDOWN)).toBe(30);
    expect(store.strings.get(ORDER_COUNT)).toBe('1');
    expect(store.getTtl(ORDER_COUNT)).toBe(2 * 60 * 60);
    expect(store.strings.get(HANDLE_COUNT)).toBe('1');
    expect(store.getTtl(HANDLE_COUNT)).toBe(5 * 60);
  });

  it('cooldown: 同じ table の 30 秒以内の再呼出は 429 cooldown で、どのキーも変えない。30 秒後は通る', async () => {
    await callPOST(callRequest());
    const before = snapshot();
    const res = await callPOST(callRequest());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'cooldown' });
    expect(snapshot()).toBe(before);
    store.advance(30_000);
    expect((await callPOST(callRequest())).status).toBe(200);
    expect(store.strings.get(ORDER_COUNT)).toBe('2');
    expect(calls().map((call) => call.id)).toEqual(['call-3', 'call-1']);
  });

  it.each([
    ['order_limit', ORDER_COUNT, '5'],
    ['velocity', HANDLE_COUNT, '10'],
  ])('%s: 回数が上限に達していれば 429 で、cooldown・回数・一覧のどれも変えない', async (reason, key, value) => {
    store.strings.set(key, value);
    const before = snapshot();
    const res = await callPOST(callRequest());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: reason });
    expect(snapshot()).toBe(before);
    // 上限の 1 つ手前なら通る (>= で比べる)。
    store.strings.set(key, String(Number(value) - 1));
    expect((await callPOST(callRequest())).status).toBe(200);
    expect(store.strings.get(key)).toBe(value);
  });

  it('拒否の優先順は cooldown → order_limit → velocity', async () => {
    store.strings.set(ORDER_COUNT, '5');
    store.strings.set(HANDLE_COUNT, '10');
    expect(await (await callPOST(callRequest())).json()).toEqual({ ok: false, error: 'order_limit' });
    store.strings.set(COOLDOWN, '1');
    expect(await (await callPOST(callRequest())).json()).toEqual({ ok: false, error: 'cooldown' });
    store.delete(COOLDOWN);
    store.strings.set(ORDER_COUNT, '0');
    expect(await (await callPOST(callRequest())).json()).toEqual({ ok: false, error: 'velocity' });
  });

  it('競合: 同じ table の同時呼出は 1 件だけ通り、回数も一覧も 1 件分しか増えない', async () => {
    const responses = await Promise.all([1, 2, 3].map(() => callPOST(callRequest())));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 429, 429]);
    expect(store.strings.get(ORDER_COUNT)).toBe('1');
    expect(store.strings.get(HANDLE_COUNT)).toBe('1');
    expect(calls()).toHaveLength(1);
  });

  it(`呼出一覧は新しい順に ${ORDER_CALL_LIST_MAX} 件で切り詰める`, async () => {
    const old = Array.from({ length: ORDER_CALL_LIST_MAX }, (_, i) => JSON.stringify({ id: `old-${i}`, handle: 'coffee', table: '1', ts: 1 }));
    store.lists.set(CALLS, [...old]);
    expect((await callPOST(callRequest())).status).toBe(200);
    expect(calls().map((call) => call.id)).toEqual(['call-1', ...old.slice(0, -1).map((raw) => JSON.parse(raw).id)]);
  });
});

describe('REMOVE_CALL (real Lua)', () => {
  const row = (id: unknown, table = '1') => JSON.stringify({ id, handle: 'coffee', table, ts: 1 });

  it('id が一致する行を重複も含めて全部消し、他の行と読めない行は残して、消した件数を返す', async () => {
    store.lists.set(CALLS, [row('a'), row('b'), 'not-json', row('a', '2'), row(7)]);
    store.setTtl(CALLS, 600);
    const res = await callsPOST(doneRequest('a'));
    expect(await res.json()).toEqual({ ok: true, removed: 2 });
    expect(store.lists.get(CALLS)).toEqual([row('b'), 'not-json', row(7)]);
    expect(store.getTtl(CALLS)).toBe(600);
  });

  it('冪等: 無い id は 0 件で何も変えず、最後の行を消せば一覧のキーも無くなる', async () => {
    store.lists.set(CALLS, [row('a')]);
    expect(await (await callsPOST(doneRequest('zz'))).json()).toEqual({ ok: true, removed: 0 });
    expect(store.lists.get(CALLS)).toEqual([row('a')]);
    expect(await (await callsPOST(doneRequest('a'))).json()).toEqual({ ok: true, removed: 1 });
    expect(await (await callsPOST(doneRequest('a'))).json()).toEqual({ ok: true, removed: 0 });
    expect(store.keys()).not.toContain(CALLS);
  });

  it('COMMIT_CALL で入った呼出を、その id で消し込める (2 つの Lua の行の形が一致する)', async () => {
    const body = await (await callPOST(callRequest())).json() as { call: { id: string } };
    expect(await (await callsPOST(doneRequest(body.call.id))).json()).toEqual({ ok: true, removed: 1 });
    expect(calls()).toEqual([]);
  });
});
