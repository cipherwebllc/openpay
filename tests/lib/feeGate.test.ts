import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hold = vi.hoisted(() => ({
  enableBilling: true,
  feeCurrent: false,
  meterCount: 0,
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
vi.mock('@/lib/feeCurrent', () => ({
  isFeeCurrent: async () => hold.feeCurrent,
}));
vi.mock('@/lib/billingMeter', () => ({
  getMeteredCount: async () => hold.meterCount,
}));

import {
  shouldBlockGaslessRelay,
  previousPeriod,
  feeCoverageThrough,
  isGaslessRelayBlocked,
  RELAY_GATE_GRACE_DAYS,
} from '@/lib/feeGate';

const DAY = 86_400_000;
const base = {
  enabled: true,
  bypass: false,
  isFeePayment: false,
  feeCurrent: false,
  dayOfMonthUtc: 15,
  graceDays: RELAY_GATE_GRACE_DAYS,
  prevPeriodOwed: true,
};

describe('previousPeriod (UTC・年跨ぎ)', () => {
  it('月中 → 前月', () => {
    expect(previousPeriod(Date.UTC(2026, 6, 15))).toBe('2026-06');
  });
  it('1月 → 前年12月', () => {
    expect(previousPeriod(Date.UTC(2026, 0, 3))).toBe('2025-12');
  });
  it('月初 (1日) でも前月', () => {
    expect(previousPeriod(Date.UTC(2026, 7, 1))).toBe('2026-07');
  });
});

describe('feeCoverageThrough (P の2か月後月初 + 猶予・決定的)', () => {
  it('P の 2 か月後の月初 + 猶予日数', () => {
    expect(feeCoverageThrough('2026-05')).toBe(Date.UTC(2026, 6, 1) + RELAY_GATE_GRACE_DAYS * DAY);
  });
  it('年跨ぎ (11月→翌年1月 / 12月→翌年2月)', () => {
    expect(feeCoverageThrough('2026-11')).toBe(Date.UTC(2027, 0, 1) + RELAY_GATE_GRACE_DAYS * DAY);
    expect(feeCoverageThrough('2026-12')).toBe(Date.UTC(2027, 1, 1) + RELAY_GATE_GRACE_DAYS * DAY);
  });
  it('同一 period なら常に同値 (再付与で延長しない)', () => {
    expect(feeCoverageThrough('2026-06')).toBe(feeCoverageThrough('2026-06'));
  });
});

describe('shouldBlockGaslessRelay (判定マトリクス)', () => {
  it('全条件成立 → 遮断', () => {
    expect(shouldBlockGaslessRelay(base)).toBe(true);
  });
  it('billing OFF → 遮断しない', () => {
    expect(shouldBlockGaslessRelay({ ...base, enabled: false })).toBe(false);
  });
  it('bypass (アルファ) → 遮断しない', () => {
    expect(shouldBlockGaslessRelay({ ...base, bypass: true })).toBe(false);
  });
  it('利用料支払い tx → 遮断しない', () => {
    expect(shouldBlockGaslessRelay({ ...base, isFeePayment: true })).toBe(false);
  });
  it('支払い済み → 遮断しない', () => {
    expect(shouldBlockGaslessRelay({ ...base, feeCurrent: true })).toBe(false);
  });
  it('月初猶予内 (day <= grace) → 遮断しない', () => {
    expect(shouldBlockGaslessRelay({ ...base, dayOfMonthUtc: RELAY_GATE_GRACE_DAYS })).toBe(false);
  });
  it('前月に請求なし → 遮断しない', () => {
    expect(shouldBlockGaslessRelay({ ...base, prevPeriodOwed: false })).toBe(false);
  });
});

describe('isGaslessRelayBlocked (orchestrator)', () => {
  beforeEach(() => {
    hold.enableBilling = true;
    hold.feeCurrent = false;
    hold.meterCount = 10; // 前月に中継あり
    process.env.ALPHA_ENTITLEMENT_BYPASS = '0';
    process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2026-01'; // 全2026期間 1%
    delete process.env.OPENPAY_USAGE_FEE_BPS;
  });
  afterEach(() => {
    delete process.env.ALPHA_ENTITLEMENT_BYPASS;
    delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
  });

  const MERCHANT = '0x0000000000000000000000000000000000000abc';
  const JULY15 = Date.UTC(2026, 6, 15);
  const JULY3 = Date.UTC(2026, 6, 3);

  it('bypass ON → 遮断しない', async () => {
    process.env.ALPHA_ENTITLEMENT_BYPASS = '1';
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(false);
  });
  it('billing OFF → 遮断しない', async () => {
    hold.enableBilling = false;
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(false);
  });
  it('利用料支払い tx → 遮断しない', async () => {
    expect(await isGaslessRelayBlocked(MERCHANT, true, JULY15)).toBe(false);
  });
  it('支払い済み → 遮断しない', async () => {
    hold.feeCurrent = true;
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(false);
  });
  it('月初猶予内 → 遮断しない', async () => {
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY3)).toBe(false);
  });
  it('未pay・猶予超過・前月に中継あり → 遮断', async () => {
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(true);
  });
  it('未pay・猶予超過だが前月中継 0 件 → 遮断しない (grace)', async () => {
    hold.meterCount = 0;
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(false);
  });
});
