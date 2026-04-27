// 運営手数料 = max(amount * FEE_BPS, MIN_FEE[token])
//   両 token 共通で 1.0% の純マージン。MIN_FEE は token decimals に応じて分岐。
//   JPYC: 5 JPYC (18 decimals) / USDC: 0.05 USDC (6 decimals)
//
// fee model: customer = amount + fee + gasQuote (税抜き表示一本)
//   merchant = amount, op = fee。gas は別軸で UI/見積し、submit 時に
//   sponsorship では fee transfer に内包、erc20 では paymaster が顧客から直接徴収。
import type { Address } from 'viem';
import type { TokenSymbol } from './tokens';

const BPS_DENOM = 10_000n;

export const FEE_BPS = 100n; // 1.0% (両 token 共通)

export const MIN_FEE: Record<TokenSymbol, bigint> = {
  jpyc: 5n * 10n ** 18n, // 5 JPYC (18 decimals)
  usdc: 50_000n,         // 0.05 USDC (6 decimals)
};

export function calcFee(amount: bigint, token: TokenSymbol): bigint {
  if (amount <= 0n) return 0n;
  const proportional = (amount * FEE_BPS) / BPS_DENOM;
  const min = MIN_FEE[token];
  return proportional > min ? proportional : min;
}

// 運営手数料の単純計算。gas はこの軸の責務外 (useGasQuote* 系で別管理)。
export type Breakdown = {
  customerPays: bigint;
  merchantReceives: bigint;
  feeAmount: bigint;
};

export function calcBreakdown(
  amount: bigint,
  token: TokenSymbol,
): Breakdown {
  const fee = calcFee(amount, token);
  return {
    customerPays: amount + fee,
    merchantReceives: amount,
    feeAmount: fee,
  };
}

// 直接送金 (mode=direct): 顧客がガス代を負担し、運営手数料は徴収しない。
// breakdown は customer = merchant = amount, fee = 0。
export function calcDirectBreakdown(amount: bigint): Breakdown {
  const a = amount > 0n ? amount : 0n;
  return { customerPays: a, merchantReceives: a, feeAmount: 0n };
}

// 複数受取人 (split) の breakdown。
// - primary は残余 % (100 - sum(split percents))
// - 端数 (整数除算で発生) は primary に集約 (最も大きな分配先で吸収)
// - 既存の calcBreakdown が返す merchantReceives 全体を、% 比で割り振る
// - feeAmount は変わらず operator が受け取る
export type SplitBreakdownEntry = { to: Address; amount: bigint; percent: number };
export type SplitBreakdown = {
  customerPays: bigint;
  feeAmount: bigint;
  // 配列の index 0 が primary (to)、以降が split entries の順
  recipients: SplitBreakdownEntry[];
};

export function calcSplitBreakdown(
  amount: bigint,
  token: TokenSymbol,
  primary: Address,
  splits: ReadonlyArray<{ to: Address; percent: number }>,
): SplitBreakdown {
  const base = calcBreakdown(amount, token);
  const totalForRecipients = base.merchantReceives;

  // primary の % は残余
  const splitSum = splits.reduce((acc, s) => acc + s.percent, 0);
  const primaryPercent = 100 - splitSum;

  const splitAmounts = splits.map((s) => ({
    to: s.to,
    amount: (totalForRecipients * BigInt(s.percent)) / 100n,
    percent: s.percent,
  }));
  const distributed = splitAmounts.reduce((acc, s) => acc + s.amount, 0n);
  const primaryAmount = totalForRecipients - distributed; // 端数を含む残り

  return {
    customerPays: base.customerPays,
    feeAmount: base.feeAmount,
    recipients: [
      { to: primary, amount: primaryAmount, percent: primaryPercent },
      ...splitAmounts,
    ],
  };
}
