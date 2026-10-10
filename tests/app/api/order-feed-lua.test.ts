// @vitest-environment node
// 受注フィードの状態更新 (POST /api/order/feed の REPLACE_ELEM: LPOS + LSET) を本物の Lua で実行する (Lua 登録表の計画 PR-C)。
// order-feed.test.ts・orderPickup.flow.test.ts は kvEval を JS で模倣しているため、「位置を保ったまま置き換え、list の TTL を
// 消さない」ことと、同時更新で旧 raw が消えていれば 0 を返して読み直すことは CI で一度も実行されていなかった。route を実際に呼び、
// lib/kv.ts の実装ごと fake Upstash に繋ぐ。店側の認可だけを mock する。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { orderListKey, serializeOrder, ORDER_LIST_TTL_SEC, type StoredOrder } from '@/lib/orderRelay';

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TX = `0x${'b'.repeat(64)}`;
const LIST = orderListKey(MERCHANT);

const h = vi.hoisted(() => ({
  // EVAL の直前に毎回実行する (別端末の同時更新を Lua の手前に差し込む)。
  beforeEval: null as (() => void) | null,
  evals: 0,
  warn: vi.fn(),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableOrderRelay: true, enableOrderFulfillment: false } };
});
vi.mock('@/lib/orderFeedAuth', () => ({ resolveOrderFeedMerchant: async () => ({ merchant: MERCHANT }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } }));

import { POST } from '@/app/api/order/feed/route';

let store: FakeRedisStore;

function order(over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: 'target', items: [{ name: 'ブレンド', qty: 1, price: '500' }], table: 'テーブル 3', amount: '500000000000000000000',
    txHash: TX, chainId: 137, from: '', ts: 1_790_000_000_000, fulfilled: false, ...over,
  };
}
const other = (n: number) => serializeOrder(order({ orderId: `other-${n}`, txHash: `0x${String(n).repeat(64)}` }));
const fulfill = (fulfilled = true) => POST(new Request('http://localhost/api/order/feed', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ txHash: TX, fulfilled }),
}));
const orders = () => (store.lists.get(LIST) ?? []).map((raw) => JSON.parse(raw) as StoredOrder);

beforeEach(() => {
  store = createFakeRedisStore(1_790_000_000_000);
  h.beforeEval = null;
  h.evals = 0;
  h.warn.mockClear();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  const upstash = fakeUpstashFetch(store);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown[];
    if (body[0] === 'EVAL') {
      h.evals += 1;
      h.beforeEval?.();
    }
    return upstash(url, init);
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('REPLACE_ELEM (real Lua)', () => {
  it('対象の注文だけを同じ位置で置き換え、他の注文と list の TTL を変えない', async () => {
    store.lists.set(LIST, [other(1), serializeOrder(order()), other(2)]);
    store.setTtl(LIST, ORDER_LIST_TTL_SEC - 600);
    const res = await fulfill();
    expect(await res.json()).toEqual({ ok: true, updated: 1 });
    expect(store.lists.get(LIST)![0]).toBe(other(1));
    expect(store.lists.get(LIST)![2]).toBe(other(2));
    expect(orders()[1]).toEqual(order({ fulfilled: true }));
    expect(store.getTtl(LIST)).toBe(ORDER_LIST_TTL_SEC - 600);
    expect(h.evals).toBe(1);
  });

  it('1 件だけの list でもキーを消さずに置き換える (LREM + LPUSH と違い TTL が残る)・戻すのも同じ', async () => {
    store.lists.set(LIST, [serializeOrder(order())]);
    store.setTtl(LIST, 3_600);
    expect(await (await fulfill()).json()).toEqual({ ok: true, updated: 1 });
    expect(orders()).toEqual([order({ fulfilled: true })]);
    expect(store.getTtl(LIST)).toBe(3_600);
    expect(await (await fulfill(false)).json()).toEqual({ ok: true, updated: 1 });
    expect(orders()).toEqual([order()]);
    expect(store.getTtl(LIST)).toBe(3_600);
  });

  it('競合: Lua の直前に別端末が同じ注文を更新したら 0 → 読み直して、相手の更新を失わずに置き換える', async () => {
    store.lists.set(LIST, [other(1), serializeOrder(order()), other(2)]);
    store.setTtl(LIST, 3_600);
    h.beforeEval = () => {
      h.beforeEval = null;
      // 別端末がテーブル番号を直した (同じ注文の raw が置き換わる)。
      store.lists.get(LIST)![1] = serializeOrder(order({ table: 'テーブル 4' }));
    };
    expect(await (await fulfill()).json()).toEqual({ ok: true, updated: 1 });
    expect(h.evals).toBe(2);
    expect(orders()[1]).toEqual(order({ table: 'テーブル 4', fulfilled: true }));
    expect(orders()).toHaveLength(3);
    expect(store.getTtl(LIST)).toBe(3_600);
  });

  it('競合: 毎回 Lua の直前に書き換えられ続けたら 3 回で 409 conflict にし、相手の版を残す', async () => {
    store.lists.set(LIST, [serializeOrder(order())]);
    let n = 0;
    h.beforeEval = () => {
      n += 1;
      store.lists.set(LIST, [serializeOrder(order({ table: `テーブル ${10 + n}` }))]);
    };
    const res = await fulfill();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'conflict' });
    expect(h.evals).toBe(3);
    expect(orders()).toEqual([order({ table: 'テーブル 13' })]);
    expect(h.warn).toHaveBeenCalledWith('order.feed.conflict', { attempts: 3 });
  });
});
