import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// メーター/マーカー/fee-current は KV を介すため、hold で差し替え可能にする。
// getMeteredCount は period 別に返せるよう関数で持つ (lookback の複数月を切り分けるため)。
const hold = vi.hoisted(() => ({
  enableBilling: true,
  feeCurrent: false,
  meterCountByPeriod: {} as Record<string, number>,
  meterCountDefault: 0,
  unpaidPeriods: [] as string[], // getUnpaidPeriods が返す未払い期間
  unpaidReadable: true, // false = KV 読み失敗 (fail-open テスト用)
  lastPaidPeriod: null as string | null,
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
  getFeeStatus: async () => ({
    current: hold.feeCurrent,
    expiresAt: null,
    lastPaidPeriod: hold.lastPaidPeriod,
    bypass: false,
  }),
  // fail-open: 読めない期間は未払い扱いにしない (= 候補から落とす)。
  getUnpaidPeriods: async (_merchant: string, periods: string[]) =>
    hold.unpaidReadable ? periods.filter((p) => hold.unpaidPeriods.includes(p)) : [],
}));
vi.mock('@/lib/billingMeter', () => ({
  getMeteredCount: async (period: string) =>
    period in hold.meterCountByPeriod
      ? hold.meterCountByPeriod[period]
      : hold.meterCountDefault,
}));

import {
  shouldBlockGaslessRelay,
  previousPeriod,
  feeCoverageThrough,
  isGaslessRelayBlocked,
  owedCandidatePeriods,
  RELAY_GATE_GRACE_DAYS,
  OWED_LOOKBACK_MONTHS,
} from '@/lib/feeGate';

const DAY = 86_400_000;
const base = {
  enabled: true,
  bypass: false,
  isFeePayment: false,
  feeCurrent: false,
  dayOfMonthUtc: 15,
  graceDays: RELAY_GATE_GRACE_DAYS,
  owedUnpaid: true,
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

describe('owedCandidatePeriods (lookback 内の閉じた期間列・新しい順)', () => {
  const JULY15 = Date.UTC(2026, 6, 15); // previousPeriod = 2026-06

  it('startPeriod が null → 空配列 (課金未点灯)', () => {
    expect(owedCandidatePeriods(JULY15, null)).toEqual([]);
  });

  it('startPeriod が未来 → 空配列 (まだ閉じた期間が無い)', () => {
    // start=2026-08 だが直近の閉じた期間は 2026-06 → 範囲なし
    expect(owedCandidatePeriods(JULY15, '2026-08')).toEqual([]);
  });

  it('startPeriod が直近 → 前月 1 件のみ (新しい順)', () => {
    expect(owedCandidatePeriods(JULY15, '2026-06')).toEqual(['2026-06']);
  });

  it('startPeriod 以降の全閉じた期間を新しい順で返す', () => {
    // start=2026-03、now=7月 → 閉じた期間 6,5,4,3 月
    expect(owedCandidatePeriods(JULY15, '2026-03')).toEqual([
      '2026-06',
      '2026-05',
      '2026-04',
      '2026-03',
    ]);
  });

  it('12 か月 lookback で下限が抑えられる (それより古い start は forgive)', () => {
    // start=2024-01 (古すぎ)・now=2026-07 → previousPeriod=2026-06 から 12 か月分
    const out = owedCandidatePeriods(JULY15, '2024-01');
    expect(out.length).toBe(OWED_LOOKBACK_MONTHS);
    expect(out[0]).toBe('2026-06'); // newest
    expect(out[out.length - 1]).toBe('2025-07'); // 12 か月前 (2025-07..2026-06)
  });

  it('年跨ぎで下限月を正しく桁下げする', () => {
    // now=2026-02-10 → previousPeriod=2026-01・lookback 12 → 2025-02..2026-01
    const out = owedCandidatePeriods(Date.UTC(2026, 1, 10), '2020-01');
    expect(out[0]).toBe('2026-01');
    expect(out[out.length - 1]).toBe('2025-02');
    expect(out.length).toBe(OWED_LOOKBACK_MONTHS);
  });
});

describe('shouldBlockGaslessRelay (判定マトリクス・owedUnpaid)', () => {
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
  it('lookback 内に未払い請求なし → 遮断しない', () => {
    expect(shouldBlockGaslessRelay({ ...base, owedUnpaid: false })).toBe(false);
  });
});

describe('isGaslessRelayBlocked (orchestrator・lookback 全期間)', () => {
  beforeEach(() => {
    hold.enableBilling = true;
    hold.feeCurrent = false;
    hold.meterCountByPeriod = {};
    hold.meterCountDefault = 10; // 既定: どの期間も中継あり
    hold.unpaidPeriods = [];
    hold.unpaidReadable = true;
    hold.lastPaidPeriod = null;
    process.env.ALPHA_ENTITLEMENT_BYPASS = '0';
    process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2026-01'; // 全2026期間 1%
    delete process.env.OPENPAY_USAGE_FEE_BPS;
  });
  afterEach(() => {
    delete process.env.ALPHA_ENTITLEMENT_BYPASS;
    delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
  });

  const MERCHANT = '0x0000000000000000000000000000000000000abc';
  const JULY15 = Date.UTC(2026, 6, 15); // previousPeriod=2026-06
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
  it('支払い済み (fee-current) → 遮断しない', async () => {
    hold.feeCurrent = true;
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(false);
  });
  it('月初猶予内 → 遮断しない', async () => {
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY3)).toBe(false);
  });

  it('前月に請求あり・全期間未払い・猶予超過 → 遮断', async () => {
    hold.unpaidPeriods = ['2026-06']; // 前月が未払い
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(true);
  });

  it('全期間 中継 0 件 → 遮断しない (請求なし=grace)', async () => {
    hold.meterCountDefault = 0;
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(false);
  });

  it('全請求期間が支払い済みマーカーあり → 遮断しない', async () => {
    hold.unpaidPeriods = []; // どの期間もマーカーあり = 未払いゼロ
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(false);
  });

  // --- 旧エスケープ (先月 relay 停止で古い未収がすり抜ける) が塞がったことの実証 ---
  it('M-1 未払い・M 中継ゼロ・M+1 で判定 → blocked (旧バグなら false になっていた)', async () => {
    // シナリオ: 2026-04 (M-1) に請求があり未払い。2026-05 (M) は中継ゼロ。2026-06 月中 (M+1) に判定。
    // 旧実装は previousPeriod(=2026-05) のみ見るため、05 が中継ゼロ → 「前月請求なし」で素通りした。
    // 新実装は lookback 内の 2026-04 の未払いを検出して遮断する。
    process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2026-04';
    hold.meterCountByPeriod = { '2026-05': 0, '2026-04': 10 }; // 05 は中継ゼロ・04 は請求あり
    hold.meterCountDefault = 0;
    hold.unpaidPeriods = ['2026-04']; // 04 が未払い
    const JUNE10 = Date.UTC(2026, 5, 10); // previousPeriod=2026-05
    expect(await isGaslessRelayBlocked(MERCHANT, false, JUNE10)).toBe(true);
  });

  it('lastPaidPeriod 後方互換: マーカー未導入で settle 済の直近期間は支払い済み扱い', async () => {
    // 前月 2026-06 だけが請求あり・getUnpaidPeriods は 06 を未払いと返すが、lastPaidPeriod=2026-06
    // (マーカー導入前に settle した) なら支払い済みとみなし遮断しない。
    hold.meterCountByPeriod = { '2026-06': 10 };
    hold.meterCountDefault = 0;
    hold.unpaidPeriods = ['2026-06'];
    hold.lastPaidPeriod = '2026-06';
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(false);
  });

  it('lastPaidPeriod が古い未収を救わない: 別の未払い期間が残れば遮断', async () => {
    process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2026-04';
    hold.meterCountByPeriod = { '2026-06': 10, '2026-04': 10 };
    hold.meterCountDefault = 0;
    hold.unpaidPeriods = ['2026-06', '2026-04'];
    hold.lastPaidPeriod = '2026-06'; // 06 は払ったが 04 が未収のまま
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(true);
  });

  it('マーカー読み失敗 (fail-open) → 未払い扱いにせず遮断しない', async () => {
    hold.meterCountByPeriod = { '2026-06': 10 };
    hold.meterCountDefault = 0;
    hold.unpaidReadable = false; // getUnpaidPeriods が KV 失敗で [] を返す
    expect(await isGaslessRelayBlocked(MERCHANT, false, JULY15)).toBe(false);
  });
});
