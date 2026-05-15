// 運営手数料 = amount * FEE_BPS / BPS_DENOM (両 token 共通で 1.0% 純プロポー
//   ショナル、最低手数料なし)。gas 肩代わり相当を OpenPay 利用手数料に bundle
//   して徴収する設計のため、フロアによる小額赤字防止は不要 — gas estimate
//   バッファが運営損益のクッションとして機能する。token 引数は将来の token
//   別レート差替の余地としてシグネチャに保持。
//
// fee model: 運営手数料は **常に店主負担** (SaaS / カード決済の販売手数料的な固定コスト)。
//   顧客には運営手数料を意識させず、見る金額は「請求金額 ± gas」のみ。
//   ネットワーク手数料は店主が gasMode で選択:
//     gas=customer: customer = amount + gas, merchant = amount - fee, op = fee + (sponsorship 時 gas)
//     gas=merchant: customer = amount,        merchant = amount - fee - gas, op = fee + (sponsorship 時 gas)
//
// gas 軸:
//   sponsorship (JPYC): 運営が POL gas を立替、運営は徴収した JPYC で別途精算 (off-chain)
//     → fee transfer に gasReimbursement (= gasQuote) を内包
//   erc20 paymaster (USDC): paymaster が顧客 USDC から actualGas を直接徴収
//     → fee transfer は fee のみ。merchant 側で gasQuote を控除して帳尻 (gas=merchant 時)
//
// 運営は両モードで fee + gas を確保 (赤字回避)。
// amount < fee + (gas=merchant ? gasQuote : 0) で merchant が 0 になるケースは
// PaymentForm 側で submit を block。
import type { Address } from 'viem';
import type { TokenSymbol } from './tokens';

export type GasMode = 'customer' | 'merchant';

const BPS_DENOM = 10_000n;

const FEE_BPS = 100n; // 1.0% (両 token 共通)

export function calcFee(amount: bigint, _token: TokenSymbol): bigint {
  if (amount <= 0n) return 0n;
  return (amount * FEE_BPS) / BPS_DENOM;
}

type Breakdown = {
  customerPays: bigint;
  merchantReceives: bigint;
  feeAmount: bigint;
};

// gasAmount は表示・計算共通の見積額 (両モードで意味を持つ)。
//   gasMode=customer: customer の支払額に上乗せ、merchant 控除には影響なし。
//   gasMode=merchant: customer の支払額には乗らず、merchant 控除に含まれる。
export function calcBreakdown(
  amount: bigint,
  token: TokenSymbol,
  gasMode: GasMode = 'customer',
  gasAmount: bigint = 0n,
): Breakdown {
  const fee = calcFee(amount, token);
  const merchantDeduction = fee + (gasMode === 'merchant' ? gasAmount : 0n);
  return {
    customerPays: gasMode === 'customer' ? amount + gasAmount : amount,
    merchantReceives:
      amount > merchantDeduction ? amount - merchantDeduction : 0n,
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
// - 端数 (整数除算で発生) は primary に集約
// - calcBreakdown が返す merchantReceives 全体を、% 比で割り振る
// - feeAmount は変わらず operator が受け取る
// - gasMode=merchant では gasAmount が merchant 全体から引かれた後の額を分配
type SplitBreakdownEntry = { to: Address; amount: bigint; percent: number };
type SplitBreakdown = {
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
  gasMode: GasMode = 'customer',
  gasAmount: bigint = 0n,
): SplitBreakdown {
  const base = calcBreakdown(amount, token, gasMode, gasAmount);
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
