// OpenPay 利用料 (a1): 月次・出来高連動の利用料を計算する純ロジック (client/server 両用)。
// 課金根拠は lib/billingMeter (relay route がサーバ権威で記録した「中継した」gasless 出来高)。
// 既存の「利用権 tier (basic/pro)」= lib/billing.ts とは **別系統** (あちらは固定額 tier・将来 Pro 用)。
// 設計は docs/plans/merchant-gasless-fee-a1.md (S2)。
//
// 料率: アルファ (点灯前) = 0% / ベータ以降 = USAGE_FEE_BPS_DEFAULT (=100 = 1%)。
// 「いつから 1% か」は OPENPAY_USAGE_FEE_START_PERIOD (env・'YYYY-MM') で制御し、未設定なら全期間
// 0% (安全側 = 既定 inert)。¥1 = 1 JPYC・decimals 18。値は wei (bigint) で扱い overflow を避ける。

export const USAGE_FEE_BPS_DEFAULT = 100; // 1%
export const BPS_DENOM = 10_000;

export type UsageInvoice = {
  period: string; // 'YYYY-MM'
  count: number; // 中継件数
  volumeWei: bigint; // 出来高合計 (wei)
  rateBps: number; // 適用料率 (bps; 100=1%)
  feeWei: bigint; // 請求額 (wei)
  free: boolean; // 無料 (料率 0 / 出来高 0)
};

// 出来高 × 料率 (floor)。負/0 bps・0 出来高は 0。請求は常に過少側 (floor) に倒す。
export function computeFeeWei(volumeWei: bigint, rateBps: number): bigint {
  if (rateBps <= 0 || volumeWei <= 0n) return 0n;
  return (volumeWei * BigInt(rateBps)) / BigInt(BPS_DENOM);
}

// period に適用する料率。startPeriod 未設定 or period < startPeriod → 0 (アルファ)。
// 'YYYY-MM' は辞書順比較がそのまま時系列順になる。
export function resolveUsageFeeBps(
  period: string,
  opts: { feeBps: number; startPeriod: string | null },
): number {
  if (!opts.startPeriod) return 0;
  if (period < opts.startPeriod) return 0;
  return Math.max(0, opts.feeBps);
}

// env から料率設定を読む (server)。既定 inert: startPeriod 未設定 → 全期間 0%。
// 点灯時に OPENPAY_USAGE_FEE_START_PERIOD='2026-07' を設定するとベータから 1% になる。
export function usageFeeConfig(): {
  feeBps: number;
  startPeriod: string | null;
} {
  const raw = process.env.OPENPAY_USAGE_FEE_BPS;
  const feeBps =
    raw && /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : USAGE_FEE_BPS_DEFAULT;
  const start = process.env.OPENPAY_USAGE_FEE_START_PERIOD;
  const startPeriod = start && /^\d{4}-\d{2}$/.test(start) ? start : null;
  return { feeBps, startPeriod };
}

// 純: メーター集計 (count/volume) + 料率 → インボイス。
export function buildUsageInvoice(input: {
  period: string;
  count: number;
  volumeWei: bigint;
  rateBps: number;
}): UsageInvoice {
  const feeWei = computeFeeWei(input.volumeWei, input.rateBps);
  return {
    period: input.period,
    count: input.count,
    volumeWei: input.volumeWei,
    rateBps: input.rateBps,
    feeWei,
    free: feeWei === 0n,
  };
}
