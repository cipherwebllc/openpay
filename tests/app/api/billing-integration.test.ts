// a1 OpenPay 利用料の統合テスト。kv (in-memory fake)・RPC 照合・SIWE・env のみ境界でモックし、
// billingMeter / usageFee / feeCurrent / feeGate / settle route は **実コードを通す**。
// meter → invoice → gate(遮断) → settle(支払い) → fee-current → gate(解除) の一連を、KV 実状態と
// 実際の請求額で検証する。並行 settle の冪等性 (二重検証/二重付与なし) も実行する。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const afterHarness = vi.hoisted(() => ({
  after: vi.fn(),
  callbacks: [] as Array<() => unknown>,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: ResponseInit = {}) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
      }),
  },
  after: (callback: () => unknown) => {
    afterHarness.after(callback);
    afterHarness.callbacks.push(callback);
  },
}));

// --- in-memory KV (nx / list / ttl-noop を実装。最下層境界のみ差し替え) ---
const { kvMod, store } = vi.hoisted(() => {
  const vals = new Map<string, string>();
  const lists = new Map<string, string[]>();
  // billing settle の promote (ロック→結果昇格・value が 'r:' で始まる SET) だけを失敗させるフック。
  // settle の「promote 失敗 → ロック失効 → 同 txHash 再提出」シナリオの再現に使う。
  const failPromote = { on: false };
  const kvMod = {
    isKvConfigured: () => true,
    kvGet: async (k: string) => ({ ok: true as const, value: vals.has(k) ? vals.get(k)! : null }),
    kvSet: async (k: string, v: string, opts: { nx?: boolean; ttlSec?: number } = {}) => {
      if (
        failPromote.on &&
        k.startsWith('billing:settled:') &&
        v.startsWith('r:')
      ) {
        return { ok: false as const, reason: 'unconfigured' as const };
      }
      if (opts.nx && vals.has(k)) return { ok: true as const, value: null };
      vals.set(k, v);
      return { ok: true as const, value: 'OK' as const };
    },
    kvDel: async (k: string) => ({ ok: true as const, value: vals.delete(k) ? 1 : 0 }),
    kvGetDel: async (k: string) => {
      const v = vals.has(k) ? vals.get(k)! : null;
      vals.delete(k);
      return { ok: true as const, value: v };
    },
    kvLpush: async (k: string, v: string) => {
      const l = lists.get(k) ?? [];
      l.unshift(v);
      lists.set(k, l);
      return { ok: true as const, value: l.length };
    },
    kvLrange: async (k: string, start: number, stop: number) => {
      const l = lists.get(k) ?? [];
      const end = stop === -1 ? l.length : stop + 1;
      return { ok: true as const, value: l.slice(start, end) };
    },
    kvLlen: async (k: string) => ({ ok: true as const, value: (lists.get(k) ?? []).length }),
    kvLtrim: async (k: string, start: number, stop: number) => {
      lists.set(k, (lists.get(k) ?? []).slice(start, stop + 1));
      return { ok: true as const, value: 'OK' as const };
    },
    kvExpire: async () => ({ ok: true as const, value: 1 }),
  };
  return { kvMod, store: { vals, lists, failPromote } };
});
vi.mock('@/lib/kv', () => kvMod);

const FEE_RECEIVER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MERCHANT_ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
// 注: vi.mock ファクトリは hoist されるため、トップレベル定数を参照せずリテラルを直接書く。
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () => ({
    ok: true as const,
    address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
  }),
}));

const verifyFn = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ ok: true } | { ok: false; reason: string }> => ({
      ok: true,
    }),
  ),
);
vi.mock('@/lib/feeVerify', () => ({ verifyJpycFeeOnChain: verifyFn }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      enableBilling: true,
      enableUsageFee: true,
      feeReceiverConfigured: true,
    },
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { recordRelayedVolume, loadUsageInvoice } from '@/lib/billingMeter';
import { isFeeCurrent } from '@/lib/feeCurrent';
import { isGaslessRelayBlocked, previousPeriod } from '@/lib/feeGate';
import { POST as settlePOST } from '@/app/api/billing/settle/route';

const JPYC = 10n ** 18n;
const AMOY = 80002;
const MERCHANT = MERCHANT_ADDR as `0x${string}`;
const TX = `0x${'a'.repeat(64)}`;

function settleReq(body: unknown): Request {
  return new Request('http://localhost/api/billing/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function flushAfterTasks(): Promise<void> {
  while (afterHarness.callbacks.length > 0) {
    const callbacks = afterHarness.callbacks.splice(0);
    await Promise.all(
      callbacks.map((callback) => Promise.resolve().then(callback)),
    );
  }
}

// settle はサーバ側で previousPeriod(Date.now()) を使う。それに揃えて出来高を記録する。
const now = Date.now();
const duePeriod = previousPeriod(now);
const [dy, dm] = duePeriod.split('-').map(Number);
const tsInDue = Date.UTC(dy, dm - 1, 15); // duePeriod 内のタイムスタンプ
const gateNow = Date.UTC(dy, dm, 15); // duePeriod の翌月 15 日 (previousPeriod=duePeriod・猶予超過)

beforeEach(() => {
  afterHarness.after.mockClear();
  afterHarness.callbacks.splice(0);
  store.vals.clear();
  store.lists.clear();
  store.failPromote.on = false;
  verifyFn.mockClear();
  verifyFn.mockResolvedValue({ ok: true });
  process.env.ALPHA_ENTITLEMENT_BYPASS = '0'; // 徴収運用
  process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2020-01'; // 全期間 1%
  delete process.env.OPENPAY_USAGE_FEE_BPS;
});

describe('a1 統合: meter → invoice → gate → settle → fee-current (全実コード)', () => {
  it('実 KV を通して 出来高記録→請求額算出→遮断→清算→解除 が一貫する', async () => {
    // 1. 2 件の中継を記録 (実 recordRelayedVolume → in-memory KV)。
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 4_000n * JPYC, nowMs: tsInDue });
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 6_000n * JPYC, nowMs: tsInDue });

    // 2. 実 loadUsageInvoice が KV を読み、実際の出来高 × 1% を算出する。
    const inv = await loadUsageInvoice(duePeriod, MERCHANT);
    expect(inv.count).toBe(2);
    expect(inv.volumeWei).toBe(10_000n * JPYC);
    expect(inv.feeWei).toBe(100n * JPYC); // 1%
    expect(inv.free).toBe(false);

    // 3. 支払い前: 前月に請求あり・未払い・猶予超過 → 実 gate が遮断する。
    expect(await isFeeCurrent(MERCHANT, gateNow)).toBe(false);
    expect(await isGaslessRelayBlocked(MERCHANT, false, gateNow)).toBe(true);

    // 4. 清算 (実 settle route)。RPC 照合のみモック ok。
    const res = await settlePOST(settleReq({ txHash: TX, chainId: AMOY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.feeWei).toBe((100n * JPYC).toString());
    expect(body.period).toBe(duePeriod);
    expect(verifyFn).toHaveBeenCalledTimes(1);

    // 5. 実 grantFeeCurrent が KV に書き、実 isFeeCurrent が current を返す。
    expect(await isFeeCurrent(MERCHANT, gateNow)).toBe(true);

    // 6. 支払い後: 実 gate は遮断しない。
    expect(await isGaslessRelayBlocked(MERCHANT, false, gateNow)).toBe(false);
  });

  it('利用料支払い tx (to=FEE_RECEIVER) は未払いでも gate を通る (実 gate)', async () => {
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 5_000n * JPYC, nowMs: tsInDue });
    // 顧客決済は遮断されるが…
    expect(await isGaslessRelayBlocked(MERCHANT, false, gateNow)).toBe(true);
    // 利用料支払い (isFeePayment=true) は常に通す (払えないと詰む)。
    expect(await isGaslessRelayBlocked(MERCHANT, true, gateNow)).toBe(false);
  });

  it('請求 0 (前月出来高なし) → settle は nothingDue・付与しない (実コード)', async () => {
    const res = await settlePOST(settleReq({ chainId: AMOY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, nothingDue: true, feeWei: '0' });
    expect(verifyFn).not.toHaveBeenCalled();
    expect(await isFeeCurrent(MERCHANT, gateNow)).toBe(false); // 付与されない
  });

  it('同 txHash の並行 settle: 検証/付与は一度だけ (実 nx ロック・冪等)', async () => {
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 10_000n * JPYC, nowMs: tsInDue });
    const [r1, r2] = await Promise.all([
      settlePOST(settleReq({ txHash: TX, chainId: AMOY })),
      settlePOST(settleReq({ txHash: TX, chainId: AMOY })),
    ]);
    const bodies = [await r1.json(), await r2.json()];
    // RPC 照合は同 txHash につき一度だけ (二重検証・二重付与なし)。
    expect(verifyFn).toHaveBeenCalledTimes(1);
    // 片方は新規清算 (feeWei あり)、もう片方は 409 か replay。新規清算はちょうど 1 件。
    const fresh = bodies.filter((b) => b.ok && b.feeWei && !b.replay);
    expect(fresh).toHaveLength(1);
    expect(await isFeeCurrent(MERCHANT, gateNow)).toBe(true);
  });

  it('検証失敗 → 422・付与されず・同 txHash を正しい tx で再提出できる (ロック解放)', async () => {
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 10_000n * JPYC, nowMs: tsInDue });
    verifyFn.mockResolvedValueOnce({ ok: false, reason: 'amount_too_low' });
    const res1 = await settlePOST(settleReq({ txHash: TX, chainId: AMOY }));
    expect(res1.status).toBe(422);
    expect(await isFeeCurrent(MERCHANT, gateNow)).toBe(false);
    // ロックが解放され、再検証 (ok) で付与される。
    const res2 = await settlePOST(settleReq({ txHash: TX, chainId: AMOY }));
    expect(res2.status).toBe(200);
    expect(await isFeeCurrent(MERCHANT, gateNow)).toBe(true);
  });

  it('決定的 expiry: 同 txHash 再提出 (replay) で満了が延びない (実コード)', async () => {
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 10_000n * JPYC, nowMs: tsInDue });
    const a = await (await settlePOST(settleReq({ txHash: TX, chainId: AMOY }))).json();
    const b = await (await settlePOST(settleReq({ txHash: TX, chainId: AMOY }))).json();
    // 2 回目は replay で同じ expiresAt (延長されない)。
    expect(b.replay).toBe(true);
    expect(b.expiresAt).toBe(a.expiresAt);
    expect(afterHarness.after).toHaveBeenCalledTimes(1);
    await flushAfterTasks();
  });

  it('settle 成功で収益台帳 (billing:revenue) に1件記録・replay で二重計上しない', async () => {
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 10_000n * JPYC, nowMs: tsInDue });
    await settlePOST(settleReq({ txHash: TX, chainId: AMOY }));
    const ledger = () => store.lists.get('billing:revenue') ?? [];
    expect(ledger()).toHaveLength(1);
    const ev = JSON.parse(ledger()[0]);
    expect(ev.v).toBe((100n * JPYC).toString()); // 10,000 × 1%
    expect(ev.p).toBe(duePeriod);
    expect(ev.h).toBe(TX);
    expect(ev.m).toBe(MERCHANT.toLowerCase());
    // replay (同 txHash 再清算) → 台帳に二重計上しない (初回成功時のみ記録)。
    await settlePOST(settleReq({ txHash: TX, chainId: AMOY }));
    expect(afterHarness.after).toHaveBeenCalledTimes(1);
    await flushAfterTasks();
    expect(ledger()).toHaveLength(1);
  });

  it('promote 失敗 → ロック失効後の同 txHash 再提出でも 台帳 LPUSH は合計1回 (feeRevenue 冪等)', async () => {
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 10_000n * JPYC, nowMs: tsInDue });
    const ledger = () => store.lists.get('billing:revenue') ?? [];
    const lockKey = `billing:settled:${AMOY}:${TX.toLowerCase()}`;

    // 1回目: promote (ロック→結果昇格) を失敗させる。台帳記録 (recordFeeRevenue) は走り 1 件入る。
    // promote 失敗でロックは短命 LOCK_MARKER ('pending') のまま残る。
    store.failPromote.on = true;
    const r1 = await settlePOST(settleReq({ txHash: TX, chainId: AMOY }));
    expect(r1.status).toBe(200); // promote 失敗は warn のみで決済成立 (route 不変)
    expect(ledger()).toHaveLength(1);
    expect(store.vals.get(lockKey)).toBe('pending'); // 結果へ昇格できていない

    // ロックの TTL 失効をシミュレート (in-memory mock は TTL を持たないため明示削除)。
    store.vals.delete(lockKey);

    // 2回目: promote は正常に戻す。claim を取り直し verify/grant (冪等) を経て recordFeeRevenue 再実行。
    // feeRevenue 側の txHash マーカーが既に立っているので LPUSH はスキップされ、台帳は合計 1 件のまま。
    store.failPromote.on = false;
    const r2 = await settlePOST(settleReq({ txHash: TX, chainId: AMOY }));
    expect(r2.status).toBe(200);
    expect(ledger()).toHaveLength(1); // 二重計上なし
  });
});
