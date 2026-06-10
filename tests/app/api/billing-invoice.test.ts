import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

const JPYC = 10n ** 18n;

const hold = vi.hoisted(() => ({
  enableBilling: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  meterVolume: 10_000n * 10n ** 18n,
  meterCount: 10,
  // period 別に出来高を返せるようにする (owed 一覧の複数月テスト用)。null=既定 meterVolume。
  volumeByPeriod: null as Record<string, bigint> | null,
  unpaidPeriods: [] as string[], // getUnpaidPeriods が返す未払い期間
  fee: {
    current: true,
    expiresAt: 999_000 as number | null,
    lastPaidPeriod: '2026-06' as string | null,
    bypass: false,
  },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableBilling() {
        return hold.enableBilling;
      },
      get enableUsageFee() {
        return hold.enableBilling;
      },
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    hold.session.ok
      ? hold.session
      : {
          ok: false,
          response: NextResponse.json(
            { ok: false, error: 'unauthenticated' },
            { status: 401 },
          ),
        },
}));
// meterPeriod は実体維持 (route が使う)・loadUsageInvoice (export) のみ差し替え。feeWei = 出来高 × 1%。
vi.mock('@/lib/billingMeter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billingMeter')>()),
  loadUsageInvoice: async (period: string) => {
    const volume = hold.volumeByPeriod
      ? (hold.volumeByPeriod[period] ?? 0n)
      : hold.meterVolume;
    const feeWei = volume / 100n;
    return {
      period,
      count: hold.meterCount,
      volumeWei: volume,
      rateBps: feeWei === 0n ? 0 : 100,
      feeWei,
      free: feeWei === 0n,
    };
  },
}));
vi.mock('@/lib/feeCurrent', () => ({
  getFeeStatus: async () => hold.fee,
  // isGaslessRelayBlocked (delinquent 算出) が使う。fee.current に合わせる。
  isFeeCurrent: async () => hold.fee.current,
  getUnpaidPeriods: async (_merchant: string, periods: string[]) =>
    periods.filter((p) => hold.unpaidPeriods.includes(p)),
}));

import { GET } from '@/app/api/billing/invoice/route';

const NOW = Date.UTC(2026, 6, 15); // 2026-07-15 → previousPeriod = 2026-06

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW); // route 内 Date.now() を固定 (owed 範囲を決定的に)
  hold.enableBilling = true;
  hold.session = { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' };
  hold.meterVolume = 10_000n * JPYC;
  hold.meterCount = 10;
  hold.volumeByPeriod = null;
  hold.unpaidPeriods = [];
  hold.fee = { current: true, expiresAt: 999_000, lastPaidPeriod: '2026-06', bypass: false };
  // 既定では課金未点灯 (owed=空) のままにし、owed テストで明示的に点灯する。
  delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
});

describe('GET /api/billing/invoice', () => {
  it('billing OFF → 404', async () => {
    hold.enableBilling = false;
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false, response: null };
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('due/current の請求額 (出来高×1%) と fee 状況を返す', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.feeCurrent).toBe(true);
    expect(json.expiresAt).toBe(999_000);
    // 10,000 JPYC × 1% = 100 JPYC (due=前月・current=当月、いずれも同 mock volume)。
    expect(json.due.feeWei).toBe((100n * JPYC).toString());
    expect(json.due.rateBps).toBe(100);
    expect(json.due.count).toBe(10);
    expect(json.current.feeWei).toBe((100n * JPYC).toString());
    expect(json.due.period).toMatch(/^\d{4}-\d{2}$/);
    expect(json.current.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('出来高 0 → due.free true・feeWei 0', async () => {
    hold.meterVolume = 0n;
    hold.meterCount = 0;
    const res = await GET();
    const json = await res.json();
    expect(json.due.free).toBe(true);
    expect(json.due.feeWei).toBe('0');
  });

  it('bypass (アルファ) を素通しで返す', async () => {
    hold.fee = { current: true, expiresAt: null, lastPaidPeriod: null, bypass: true };
    const res = await GET();
    const json = await res.json();
    expect(json.bypass).toBe(true);
  });

  describe('owed 一覧 (未払いの請求期間・新しい順)', () => {
    it('課金未点灯 (startPeriod なし) → owed 空', async () => {
      const res = await GET();
      const json = await res.json();
      expect(json.owed).toEqual([]);
    });

    it('複数月の未払いを新しい順で返し、支払い済み/lastPaidPeriod/0円を除外', async () => {
      process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2026-03';
      hold.fee = { current: false, expiresAt: null, lastPaidPeriod: '2026-04', bypass: false };
      // 候補 (lookback 内・閉じた期間) = 2026-06,05,04,03。
      hold.volumeByPeriod = {
        '2026-06': 10_000n * JPYC, // 請求あり・未払い → owed
        '2026-05': 0n, // 0 円 → 除外
        '2026-04': 10_000n * JPYC, // 請求あり・未払いだが lastPaidPeriod → 除外
        '2026-03': 5_000n * JPYC, // 請求あり・未払い → owed
      };
      hold.unpaidPeriods = ['2026-06', '2026-04', '2026-03']; // 05 は 0円なので問われない
      const res = await GET();
      const json = await res.json();
      const periods = (json.owed as { period: string }[]).map((o) => o.period);
      expect(periods).toEqual(['2026-06', '2026-03']); // 新しい順・05/04 除外
      expect(json.owed[0].feeWei).toBe((100n * JPYC).toString()); // 10,000 × 1%
      expect(json.owed[1].feeWei).toBe((50n * JPYC).toString()); // 5,000 × 1%
    });

    it('支払い済みマーカーありの期間は owed から除外', async () => {
      process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2026-05';
      hold.fee = { current: false, expiresAt: null, lastPaidPeriod: null, bypass: false };
      hold.volumeByPeriod = { '2026-06': 10_000n * JPYC, '2026-05': 10_000n * JPYC };
      hold.unpaidPeriods = ['2026-05']; // 06 はマーカーあり (支払い済み) → 除外
      const res = await GET();
      const json = await res.json();
      expect((json.owed as { period: string }[]).map((o) => o.period)).toEqual(['2026-05']);
    });
  });
});
