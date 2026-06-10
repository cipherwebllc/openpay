// 収益台帳 + 期間照合を **実コード + in-memory KV** で検証する。billingMeter (索引/出来高) と
// feeRevenue (台帳/集計/照合) を実際に通し、reconciliation が「請求 vs 入金」を正しく突合するか確認。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { kvMod, store, spies } = vi.hoisted(() => {
  const vals = new Map<string, string>();
  const lists = new Map<string, string[]>();
  // 個別 op を観測/制御するためのフック (テストで lpush 回数や kvSet 失敗を注入する)。
  const lpush = vi.fn();
  const failSet = { on: false };
  const kvMod = {
    isKvConfigured: () => true,
    kvGet: async (k: string) => ({ ok: true as const, value: vals.has(k) ? vals.get(k)! : null }),
    kvSet: async (k: string, v: string, opts: { nx?: boolean } = {}) => {
      if (failSet.on) return { ok: false as const, reason: 'unconfigured' as const };
      if (opts.nx && vals.has(k)) return { ok: true as const, value: null };
      vals.set(k, v);
      return { ok: true as const, value: 'OK' as const };
    },
    kvLpush: async (k: string, v: string) => {
      lpush(k, v);
      const l = lists.get(k) ?? [];
      l.unshift(v);
      lists.set(k, l);
      return { ok: true as const, value: l.length };
    },
    kvLrange: async (k: string, start: number, stop: number) => {
      const l = lists.get(k) ?? [];
      return { ok: true as const, value: l.slice(start, stop === -1 ? l.length : stop + 1) };
    },
    kvLlen: async (k: string) => ({ ok: true as const, value: (lists.get(k) ?? []).length }),
    kvLtrim: async (k: string, start: number, stop: number) => {
      lists.set(k, (lists.get(k) ?? []).slice(start, stop + 1));
      return { ok: true as const, value: 'OK' as const };
    },
    kvExpire: async () => ({ ok: true as const, value: 1 }),
  };
  return { kvMod, store: { vals, lists }, spies: { lpush, failSet } };
});
vi.mock('@/lib/kv', () => kvMod);
const loggerMod = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/logger', () => loggerMod);

import { recordRelayedVolume } from '@/lib/billingMeter';
import {
  recordFeeRevenue,
  getFeeRevenueEvents,
  summarizeRevenue,
  loadReconciliation,
} from '@/lib/feeRevenue';

const JPYC = 10n ** 18n;
const AMOY = 80002;
const A = '0x000000000000000000000000000000000000000a' as `0x${string}`;
const B = '0x000000000000000000000000000000000000000b' as `0x${string}`;
const JUN = Date.UTC(2026, 5, 15); // 2026-06
const JUL3 = Date.UTC(2026, 6, 3); // 入金: 2026-07-03

beforeEach(() => {
  store.vals.clear();
  store.lists.clear();
  spies.lpush.mockClear();
  spies.failSet.on = false;
  loggerMod.logger.info.mockClear();
  loggerMod.logger.warn.mockClear();
  process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2020-01'; // 全期間 1%
  delete process.env.OPENPAY_USAGE_FEE_BPS;
});
afterEach(() => {
  delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
});

describe('feeRevenue 台帳 + 集計', () => {
  it('record→get は新しい順・summarize は合計/期間別を出す', async () => {
    await recordFeeRevenue({ merchant: A, period: '2026-06', feeWei: 100n * JPYC, chainId: AMOY, txHash: '0x1', paidAtMs: JUL3 });
    await recordFeeRevenue({ merchant: B, period: '2026-06', feeWei: 50n * JPYC, chainId: AMOY, txHash: '0x2', paidAtMs: JUL3 });
    const events = await getFeeRevenueEvents();
    expect(events).toHaveLength(2);
    expect(events[0].h).toBe('0x2'); // LPUSH 先頭=最新
    const s = summarizeRevenue(events);
    expect(s.totalWei).toBe(150n * JPYC);
    expect(s.count).toBe(2);
    expect(s.byBilledPeriod[0]).toMatchObject({ period: '2026-06', count: 2, feeWei: 150n * JPYC });
  });
});

describe('feeRevenue txHash 冪等 (promote 失敗→再提出の二重計上防止)', () => {
  const TX = `0x${'1'.repeat(64)}` as `0x${string}`;

  it('初回呼出: NX マーカー成功 → LPUSH が1回走る', async () => {
    await recordFeeRevenue({ merchant: A, period: '2026-06', feeWei: 100n * JPYC, chainId: AMOY, txHash: TX, paidAtMs: JUL3 });
    expect(spies.lpush).toHaveBeenCalledTimes(1);
    expect(spies.lpush).toHaveBeenCalledWith('billing:revenue', expect.any(String));
    // マーカーが txHash 単位 (lowercase) で立っている。
    expect(store.vals.get(`billing:revenue:recorded:${AMOY}:${TX.toLowerCase()}`)).toBe('1');
  });

  it('同 (chainId, txHash) の2回目: マーカー記録済み → LPUSH しない (duplicate_skip)', async () => {
    await recordFeeRevenue({ merchant: A, period: '2026-06', feeWei: 100n * JPYC, chainId: AMOY, txHash: TX, paidAtMs: JUL3 });
    await recordFeeRevenue({ merchant: A, period: '2026-06', feeWei: 100n * JPYC, chainId: AMOY, txHash: TX, paidAtMs: JUL3 });
    expect(spies.lpush).toHaveBeenCalledTimes(1); // 2回目はスキップ
    expect((store.lists.get('billing:revenue') ?? []).length).toBe(1);
    expect(loggerMod.logger.info).toHaveBeenCalledWith(
      'billing.revenue.duplicate_skip',
      expect.objectContaining({ chainId: AMOY, txHash: TX }),
    );
  });

  it('txHash 大文字小文字違いの2回目も同様にスキップ (lowercase 正規化)', async () => {
    const lower = `0x${'a'.repeat(64)}` as `0x${string}`;
    const upper = `0x${'A'.repeat(64)}` as `0x${string}`;
    await recordFeeRevenue({ merchant: A, period: '2026-06', feeWei: 100n * JPYC, chainId: AMOY, txHash: lower, paidAtMs: JUL3 });
    await recordFeeRevenue({ merchant: A, period: '2026-06', feeWei: 100n * JPYC, chainId: AMOY, txHash: upper, paidAtMs: JUL3 });
    expect(spies.lpush).toHaveBeenCalledTimes(1); // 同一 txHash 扱い
  });

  it('マーカー kvSet 失敗 (!ok): LPUSH しない + warn (台帳欠落=安全側)', async () => {
    spies.failSet.on = true;
    await recordFeeRevenue({ merchant: A, period: '2026-06', feeWei: 100n * JPYC, chainId: AMOY, txHash: TX, paidAtMs: JUL3 });
    expect(spies.lpush).not.toHaveBeenCalled();
    expect(loggerMod.logger.warn).toHaveBeenCalledWith(
      'billing.revenue.marker_failed',
      expect.objectContaining({ reason: 'unconfigured' }),
    );
  });
});

describe('feeRevenue 照合 (請求 vs 入金・実 billingMeter 索引)', () => {
  it('請求した2店主のうち1店主のみ入金 → 未払いが識別される', async () => {
    // 2026-06 に A・B 両方が中継 (索引 + メーターに乗る)。
    await recordRelayedVolume({ chainId: AMOY, merchant: A, value: 10_000n * JPYC, nowMs: JUN });
    await recordRelayedVolume({ chainId: AMOY, merchant: B, value: 4_000n * JPYC, nowMs: JUN });
    // A だけ清算 (入金) — feeWei = 10,000 × 1% = 100。
    await recordFeeRevenue({ merchant: A, period: '2026-06', feeWei: 100n * JPYC, chainId: AMOY, txHash: '0xA', paidAtMs: JUL3 });

    const events = await getFeeRevenueEvents();
    const recon = await loadReconciliation('2026-06', events);

    expect(recon).toHaveLength(2);
    const rowA = recon.find((r) => r.merchant === A.toLowerCase())!;
    const rowB = recon.find((r) => r.merchant === B.toLowerCase())!;
    expect(rowA.billedFeeWei).toBe(100n * JPYC); // 10,000 × 1%
    expect(rowA.paid).toBe(true);
    expect(rowA.txHash).toBe('0xA');
    expect(rowB.billedFeeWei).toBe(40n * JPYC); // 4,000 × 1%
    expect(rowB.paid).toBe(false); // 未入金
    // 未払いが先頭 (取りこぼし目視のため)。
    expect(recon[0].paid).toBe(false);
  });

  it('中継初回のみ索引に入る (重複 push しない)', async () => {
    await recordRelayedVolume({ chainId: AMOY, merchant: A, value: 1_000n * JPYC, nowMs: JUN });
    await recordRelayedVolume({ chainId: AMOY, merchant: A, value: 2_000n * JPYC, nowMs: JUN });
    const events = await getFeeRevenueEvents();
    const recon = await loadReconciliation('2026-06', events);
    expect(recon).toHaveLength(1); // A は1回だけ
    expect(recon[0].billedFeeWei).toBe(30n * JPYC); // (1,000+2,000) × 1%
  });
});
