// fee = max(amount * 1%, MIN_FEE) — JPYC: 15 JPYC, USDC: 0.1 USDC
//   include (内税): customer = amount,       merchant = amount - fee, op = fee
//   exclude (外税): customer = amount + fee, merchant = amount,       op = fee
import type { TokenSymbol } from './tokens';

export type FeeMode = 'include' | 'exclude';

const FEE_BPS = 100n; // 1.0%
const BPS_DENOM = 10_000n;

export const MIN_FEE: Record<TokenSymbol, bigint> = {
  jpyc: 15n * 10n ** 18n, // 15 JPYC (18 decimals)
  usdc: 100_000n,         // 0.1 USDC (6 decimals)
};

export function calcFee(amount: bigint, token: TokenSymbol): bigint {
  if (amount <= 0n) return 0n;
  const onePercent = (amount * FEE_BPS) / BPS_DENOM;
  const min = MIN_FEE[token];
  return onePercent > min ? onePercent : min;
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
