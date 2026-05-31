// OpenPay 利用手数料 = amount * FEE_BPS / BPS_DENOM (両 token 共通、最低手数料なし)。
// 決済手数料は alpha / 将来とも 0% (FEE_BPS_* = 0n で calcFee は常に 0n を返す)。収益化は
// 周辺機能の月額固定 / 利用権販売など決済額非連動モデルで、決済フローを通さない
// (= この per-tx 手数料は復活させない)。feeAmount を 0 で記録し続けるのは「利用手数料 0」
// の会計証跡 + 既存スキーマ継続のため。
//
// 決済モードは 2 種類で gas 取り扱いが異なる:
//   gasless  — OpenPay が gas を肩代わり、店主が gasMode で負担者を選ぶ
//   standard — 顧客 wallet が自前で gas 負担、gasMode は irrelevant
//
// gasless / gasMode の breakdown (fee=0 想定):
//   gas=customer: customer = amount + gas, merchant = amount
//   gas=merchant: customer = amount,        merchant = amount - gas
// gas 内訳 (gasless のみ):
//   sponsorship (JPYC): 運営が POL gas を立替え、顧客が同額相当を JPYC で負担する (案A:
//     gasMode=customer は請求に上乗せ / gasMode=merchant は着金から控除)。運営は立替分を
//     回収し利益 0 (= 肩代わりではなく立替・回収)。会計上はネットワーク手数料相当額として
//     networkFeeEquivalent に分離記録する。
//   erc20 paymaster (USDC): paymaster が顧客 USDC から actualGas を直接徴収
import type { Address } from 'viem';
import type { TokenSymbol } from './tokens';

export type GasMode = 'customer' | 'merchant';

// 決済モード (詳細は file header を参照)。lib/url.ts の PayParams.mode と同期。
export type PayMode = 'gasless' | 'standard';

const BPS_DENOM = 10_000n;

export const FEE_BPS_GASLESS = 0n;
export const FEE_BPS_STANDARD = 0n;

export function calcFee(
  amount: bigint,
  _token: TokenSymbol,
  mode: PayMode,
): bigint {
  if (amount <= 0n) return 0n;
  const bps = mode === 'standard' ? FEE_BPS_STANDARD : FEE_BPS_GASLESS;
  return (amount * bps) / BPS_DENOM;
}

type Breakdown = {
  customerPays: bigint;
  merchantReceives: bigint;
  feeAmount: bigint;
};

// gasAmount は表示・計算共通の見積額。
//   gasless / gasMode=customer: customer の支払額に上乗せ、merchant 控除には影響なし。
//   gasless / gasMode=merchant: customer の支払額には乗らず、merchant 控除に含まれる。
//   standard: gasAmount は無視 (OpenPay 側で gas に touch しないため)。customer は
//             amount のみを supply、ネットワーク手数料はウォレットが独自に算定して支払う。
export function calcBreakdown(
  amount: bigint,
  token: TokenSymbol,
  mode: PayMode = 'gasless',
  gasMode: GasMode = 'customer',
  gasAmount: bigint = 0n,
): Breakdown {
  const fee = calcFee(amount, token, mode);
  if (mode === 'standard') {
    // standard mode では gasAmount を OpenPay の breakdown に組み込まない。
    // customer = amount (wallet が gas を別建てで請求)、merchant = amount - fee。
    const a = amount > 0n ? amount : 0n;
    return {
      customerPays: a,
      merchantReceives: a > fee ? a - fee : 0n,
      feeAmount: fee,
    };
  }
  const merchantDeduction = fee + (gasMode === 'merchant' ? gasAmount : 0n);
  return {
    customerPays: gasMode === 'customer' ? amount + gasAmount : amount,
    merchantReceives:
      amount > merchantDeduction ? amount - merchantDeduction : 0n,
    feeAmount: fee,
  };
}

// 複数受取人 (split) の breakdown。
// - primary は残余 % (100 - sum(split percents))
// - 端数 (整数除算で発生) は primary に集約
// - calcBreakdown が返す merchantReceives 全体を、% 比で割り振る
// - feeAmount は変わらず operator が受け取る
// - gasMode=merchant では gasAmount が merchant 全体から引かれた後の額を分配 (gasless 時のみ)
// - standard mode では gasAmount は無視 (merchant 全体 = amount - fee)
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
  mode: PayMode = 'gasless',
  gasMode: GasMode = 'customer',
  gasAmount: bigint = 0n,
): SplitBreakdown {
  const base = calcBreakdown(amount, token, mode, gasMode, gasAmount);
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
