// fee = max(amount * FEE_BPS[token], MIN_FEE[token])
//   JPYC (Polygon): 1.0% / 15 JPYC  — Polygon ガスは平常時 1〜3 JPY なのでフロア 15 で十分黒字
//   USDC (Base):    1.2% / 0.2 USDC — Base L1 calldata の高騰時にもフロアで赤字を出さないため厚め
//
//   include (内税): customer = amount,       merchant = amount - fee, op = fee
//   exclude (外税): customer = amount + fee, merchant = amount,       op = fee
import type { Address } from 'viem';
import type { TokenSymbol } from './tokens';

export type FeeMode = 'include' | 'exclude';

const BPS_DENOM = 10_000n;

export const FEE_BPS: Record<TokenSymbol, bigint> = {
  jpyc: 100n, // 1.0%
  usdc: 120n, // 1.2%
};

export const MIN_FEE: Record<TokenSymbol, bigint> = {
  jpyc: 15n * 10n ** 18n, // 15 JPYC (18 decimals)
  usdc: 200_000n,         // 0.2 USDC (6 decimals)
};

export function calcFee(amount: bigint, token: TokenSymbol): bigint {
  if (amount <= 0n) return 0n;
  const proportional = (amount * FEE_BPS[token]) / BPS_DENOM;
  const min = MIN_FEE[token];
  return proportional > min ? proportional : min;
}

export type Breakdown = {
  customerPays: bigint;
  merchantReceives: bigint;
  feeAmount: bigint;
};

export function calcBreakdown(
  amount: bigint,
  mode: FeeMode,
  token: TokenSymbol,
): Breakdown {
  const fee = calcFee(amount, token);

  if (mode === 'include') {
    // amount < fee なら merchant がマイナスになり得るので 0 でガード
    return {
      customerPays: amount,
      merchantReceives: amount > fee ? amount - fee : 0n,
      feeAmount: amount > fee ? fee : amount,
    };
  }

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
  mode: FeeMode,
  token: TokenSymbol,
  primary: Address,
  splits: ReadonlyArray<{ to: Address; percent: number }>,
): SplitBreakdown {
  const base = calcBreakdown(amount, mode, token);
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
