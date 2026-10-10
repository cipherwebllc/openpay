// @vitest-environment node
// POST /api/order/notify の手数料 claim の Lua (STORE_ORDER_WITH_INLINE_FEE_CLAIM・RECONCILE_FEE) を本物の Lua で実行する
// (第 7 回レビュー C5・F10)。order-notify.test.ts は kvEval を JS で模倣しているため、Lua の LPUSH→SET→LSET の順・
// LPOS の位置維持・claim 衝突時の未収版保存は CI で一度も実行されていなかった。ここでは route を実際に呼び、
// lib/kv.ts の実装ごと fake Upstash (tests/_helpers/redisLua) に繋ぐ。on-chain 検証・handle・rate limit だけを mock する。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';

const JPYC = 10n ** 18n;
const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CUSTOMER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TXHASH = `0x${'a'.repeat(64)}`;
const FEE_TXHASH = `0x${'f'.repeat(64)}`;
const LIST = `order:list:${MERCHANT.toLowerCase()}`;

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  tasks: [] as (() => unknown)[],
  // 次の EVAL の直前に 1 回だけ実行する (別 request の同時更新を Lua の手前に差し込む)。
  beforeEval: null as ((script: string) => void) | null,
  // EVAL の応答の差し替え (kvEval の契約は Redis の値の形まで・script ごとの意味は呼出側が確かめる)。
  // run() を呼べば本物の Lua を実行した結果、呼ばなければ Lua を走らせずに返した値がそのまま {result} で届く。
  reply: null as ((script: string, run: () => Promise<unknown>) => Promise<unknown>) | null,
  evals: [] as string[],
  warn: vi.fn(),
  verify: null as unknown,
  feePair: null as unknown,
}));

vi.mock('next/server', async (original) => ({
  ...await original<typeof import('next/server')>(),
  after: (task: () => unknown) => { h.tasks.push(task); },
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    isMainnet: false,
    env: {
      ...actual.env,
      enableOrderRelay: true,
      enableOrderPickup: false,
      enablePushNotify: false,
      enableMobileOrderFee: true,
      feeReceiver: '0x1111111111111111111111111111111111111111',
      feeReceiverConfigured: true,
    },
  };
});
vi.mock('viem', async (importOriginal) => ({
  ...await importOriginal<typeof import('viem')>(),
  createPublicClient: () => ({ getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }) }),
}));
vi.mock('@/lib/feeVerify', () => ({
  verifyJpycTransferToOnChain: async () => h.verify,
  verifyJpycStandardFeePairOnChain: async () => h.feePair,
}));
vi.mock('@/lib/relay/forwarderConfig', async (original) => ({
  ...await original<typeof import('@/lib/relay/forwarderConfig')>(),
  configuredJpycForwarderFor: () => null,
}));
vi.mock('@/lib/handleStore', () => ({
  resolveHandle: async () => ({
    ok: true,
    record: { config: { to: MERCHANT }, storefront: { chain: 'polygon', mode: 'preorder', feePayer: 'merchant' } },
  }),
}));
vi.mock('@/lib/relay/relayGuards', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/relay/relayGuards')>(),
  checkRateLimit: async () => true,
  checkReadRateLimit: async () => true,
}));
vi.mock('@/lib/metrics', () => ({ recordMetric: vi.fn(), recordMetricAfterResponse: vi.fn() }));
vi.mock('@/lib/push/notify', () => ({ notifyPaymentReceived: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } }));

import { POST } from '@/app/api/order/notify/route';

function req(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/order/notify?h=alice', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
    body: JSON.stringify({
      token: 'jpyc', txHash: TXHASH, merchant: MERCHANT, chainId: 80002,
      items: [{ name: 'ブレンド', qty: 2, price: '500' }], description: 'テーブル 5', from: CUSTOMER, orderId: 'oid-1',
      ...body,
    }),
  });
}

// 先に merchant leg だけ確定し、手数料が未収の注文 (order-notify.test.ts の partialOrderRaw と同じ形)。
function partialOrderRaw(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    orderId: 'order-aaaa', items: [{ name: 'ブレンド', qty: 2, price: '500' }], table: 'テーブル 5',
    amount: (970n * JPYC).toString(), txHash: TXHASH, chainId: 80002, from: CUSTOMER, ts: 1_700_000_000_000,
    fulfilled: false, feeUncollected: true,
    feeExpectedAmount: (30n * JPYC - 1n).toString(), feeExpectedAmountAlt: (30n * JPYC).toString(),
    ...over,
  });
}

const reconcileEvals = () => h.evals.filter((script) => script.includes("redis.call('LPOS'")).length;
const orders = () => (h.store!.lists.get(LIST) ?? []).map((raw) => JSON.parse(raw) as Record<string, unknown>);

async function drain() {
  for (const task of h.tasks.splice(0)) await task();
}

// 受注済み (done) の注文に、別 tx の手数料を後から届ける (重複通知 → after() で reconcile)。
function seedPartialOrder() {
  h.store!.lists.set(LIST, [JSON.stringify({ orderId: 'newer', txHash: `0x${'1'.repeat(64)}` }), partialOrderRaw(),
    JSON.stringify({ orderId: 'older', txHash: `0x${'2'.repeat(64)}` })]);
  h.store!.setTtl(LIST, 3600);
  h.store!.strings.set(`order:used:80002:${TXHASH}`, 'done');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  vi.stubEnv('ENABLE_ORDER_BIND_ENFORCE', 'false');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  h.store = createFakeRedisStore(Date.now());
  h.tasks = [];
  h.beforeEval = null;
  h.reply = null;
  h.evals = [];
  h.warn.mockClear();
  h.verify = { ok: true, value: 970n * JPYC, merchantSource: CUSTOMER, sameSourceFeeValue: 30n * JPYC, blockNumber: 123n, receiptLogs: [] };
  h.feePair = { ok: true, value: 30n * JPYC, blockNumber: 2n, receiptLogs: [] };
  const upstash = fakeUpstashFetch(h.store);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown[];
    if (body[0] === 'EVAL') h.evals.push(String(body[1]));
    if (body[0] === 'EVAL' && h.beforeEval) {
      const hook = h.beforeEval;
      h.beforeEval = null;
      hook(String(body[1]));
    }
    if (body[0] === 'EVAL' && h.reply) {
      const run = async () => ((await (await upstash(url, init)).json()) as { result?: unknown }).result;
      return Response.json({ result: await h.reply(String(body[1]), run) });
    }
    return upstash(url, init);
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('STORE_ORDER_WITH_INLINE_FEE_CLAIM (real Lua)', () => {
  it('同じ receipt の手数料は徴収済み版で保存し、その tx を用途横断で恒久 claim する', async () => {
    const res = await POST(req({}));
    expect(await res.json()).toEqual({ ok: true, orderId: 'oid-1' });
    expect(orders()).toHaveLength(1);
    expect(orders()[0]).toMatchObject({ orderId: 'oid-1', amount: (970n * JPYC).toString() });
    expect(orders()[0]).not.toHaveProperty('feeUncollected');
    expect(h.store!.strings.get(`payment:claimed:80002:${TXHASH}`)).toBe('r:order');
    expect(h.store!.getTtl(`payment:claimed:80002:${TXHASH}`)).toBe(-1);
  });

  it('冪等: 同じ tx の再通知は duplicate で、注文も claim も増えない', async () => {
    await POST(req({}));
    expect(await (await POST(req({}))).json()).toEqual({ ok: true, duplicate: true });
    await drain();
    expect(orders()).toHaveLength(1);
    expect(h.store!.strings.get(`payment:claimed:80002:${TXHASH}`)).toBe('r:order');
  });

  it.each([
    ['既存の global claim (別用途)', `payment:claimed:80002:${TXHASH}`, 'r:pro'],
    ['global claim 導入前の billing 清算', `billing:settled:80002:${TXHASH}`, '1'],
  ])('競合: %s があれば未収版を保存し、claim は書き換えない', async (_name, key, value) => {
    h.store!.strings.set(key, value);
    expect((await POST(req({}))).status).toBe(200);
    expect(orders()).toHaveLength(1);
    expect(orders()[0]).toMatchObject({ feeUncollected: true, feeExpectedAmount: (30n * JPYC - 1n).toString() });
    expect(h.store!.strings.get(key)).toBe(value);
    if (!key.startsWith('payment:')) expect(h.store!.strings.has(`payment:claimed:80002:${TXHASH}`)).toBe(false);
  });

  // kvEval は Redis の値の形までしか確かめない。0 / 1 以外 (ここでは Lua を走らせない nil) を保存済みと読むと、受注 0 件のまま
  // 200 と done マーカーを返し、再送も duplicate になって復旧できない。
  it('想定外の応答 (nil) は保存済みにせず 503・pending クレームを戻し、再送で 1 件だけ保存する', async () => {
    h.reply = async (script, run) => script.includes('local claimed=0') ? null : run();
    const res = await POST(req({}));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_error' });
    expect(orders()).toEqual([]);
    expect(h.store!.strings.has(`order:used:80002:${TXHASH}`)).toBe(false);
    h.reply = null;
    expect(await (await POST(req({}))).json()).toEqual({ ok: true, orderId: 'oid-1' });
    expect(orders()).toHaveLength(1);
  });
});

describe('RECONCILE_FEE (real Lua)', () => {
  it('後から届いた手数料 tx で未収を解除する。注文の位置と list の TTL は変えず、手数料 tx を claim する', async () => {
    seedPartialOrder();
    expect(await (await POST(req({ feeTxHash: FEE_TXHASH }))).json()).toEqual({ ok: true, duplicate: true });
    await drain();
    expect(orders().map((order) => order.orderId)).toEqual(['newer', 'order-aaaa', 'older']);
    expect(orders()[1]).not.toHaveProperty('feeUncollected');
    expect(orders()[1]).not.toHaveProperty('feeExpectedAmount');
    expect(h.store!.getTtl(LIST)).toBe(3600);
    expect(h.store!.strings.get(`payment:claimed:80002:${FEE_TXHASH}`)).toBe('r:order');
    expect(reconcileEvals()).toBe(1);
  });

  it('冪等・競合: その手数料 tx が既に別用途で claim 済みなら -1 で、未収のまま残す (二重充当しない)', async () => {
    seedPartialOrder();
    h.store!.strings.set(`payment:claimed:80002:${FEE_TXHASH}`, 'r:csvpass');
    await POST(req({ feeTxHash: FEE_TXHASH }));
    await drain();
    expect(orders()[1]).toEqual(JSON.parse(partialOrderRaw()));
    expect(h.store!.strings.get(`payment:claimed:80002:${FEE_TXHASH}`)).toBe('r:csvpass');
    expect(h.warn).toHaveBeenCalledWith('order.notify.fee_reconcile_replay', expect.objectContaining({ chainId: 80002 }));
    expect(reconcileEvals()).toBe(1);
  });

  it('競合: Lua の直前に受注ボードが同じ注文を更新したら 0 → 読み直して、ボードの更新を失わずに解除する', async () => {
    seedPartialOrder();
    h.beforeEval = () => {
      // 店員が「提供済み」にした (同じ注文の raw が置き換わる)。
      h.store!.lists.get(LIST)![1] = partialOrderRaw({ fulfilled: true });
    };
    await POST(req({ feeTxHash: FEE_TXHASH }));
    await drain();
    expect(orders()[1]).toMatchObject({ orderId: 'order-aaaa', fulfilled: true });
    expect(orders()[1]).not.toHaveProperty('feeUncollected');
    expect(h.store!.strings.get(`payment:claimed:80002:${FEE_TXHASH}`)).toBe('r:order');
    expect(reconcileEvals()).toBe(2);
  });
});
