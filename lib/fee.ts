// OpenPay 利用手数料 = amount * FEE_BPS / BPS_DENOM (両 token 共通、最低手数料なし)。
// Phase 1 (alpha 期間中): FEE_BPS_GASLESS / FEE_BPS_STANDARD は 0n (手数料を徴収しない)。
// 関数 signature / return shape は維持し、calcFee は常に 0n を返す。Phase 2 で
// 課金モデル (月額固定 / 利用権販売など、決済額に連動しない方式) を検討予定。
//
// 決済モードは 2 種類で、gas 取り扱いが異なる:
//   - gasless:  OpenPay が gas を肩代わり
//               + 店主が gasMode で選択するネットワーク手数料見積 (顧客 / 店主負担)
//   - standard: 顧客 wallet が自前で gas 負担、OpenPay は gas に touch しないため
//               gasMode は irrelevant
//
// gasless / gasMode の breakdown (fee=0 なので merchant = amount - gasDeduction のみ):
//   gas=customer: customer = amount + gas, merchant = amount
//   gas=merchant: customer = amount,        merchant = amount - gas
// gas 内訳 (gasless のみ):
//   sponsorship (JPYC): 運営が POL gas 立替 (Phase 1 では運営が吸収する純費用)
//   erc20 paymaster (USDC): paymaster が顧客 USDC から actualGas 直接徴収
import type { Address } from 'viem';
import type { TokenSymbol } from './tokens';

export type GasMode = 'customer' | 'merchant';

// 決済モード (詳細は file header を参照)。lib/url.ts の PayParams.mode と同期。
export type PayMode = 'gasless' | 'standard';

const BPS_DENOM = 10_000n;

// Phase 1 (alpha 期間中): 両モードとも 0n。Phase 2 で課金モデルを再検討する際は
// 定数だけを書き換えれば downstream は自然に追従する (calcFee → 0n、各 hook の
// `fee > 0` ガードが自然に dead path から復活)。
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
