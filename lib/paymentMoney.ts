// 決済の money/gas/fee 導出を route 駆動の純関数に切り出した単一情報源 (Phase 1.2)。
// CheckoutForm / PaymentForm / TipForm に散在していた effectiveGas / relayGasEquiv /
// effectiveGasAmount / breakdown / gasReimbursement / networkFeeEquivalent / minimumAmount を
// PaymentRoute (Phase 1.1) を引数に取る純関数へ集約し、経路追加時に「お金の式が経路ごとにずれる」
// のを型 + 真理値表テストで不可能にする。
//
// ⚠️ これは **最高感度の挙動不変リファクタ**。返す wei 値・boolean は現行 CheckoutForm の inline 式と
// **byte 単位で一致**しなければならない (実際に「請求される額」「表示される額」「会計記録される額」を
// 触るため)。新ポリシーは一切入れない (同じ短絡・同じ優先順位・同じ ?? 既定)。
//
// 純度: React/hook/env 読みを持たず、route + 解決済みの数値/フラグだけを受ける。env 依存の量
//   (recover 手数料 recoverFeeValue / paymaster gas quote) は **解決済みの値** を引数で受け取り、
//   ここで再解決しない (= テスト mock が引き続き経路と額を駆動でき、判定が二重定義にならない)。
//
// route だけからは導出できない軸 (現行コードと同じ):
//   - isJpyc: deployment.symbol==='jpyc'。gasless/pimlico route は JPYC sponsorship でも USDC erc20
//     でもありうる (route だけでは判別不能) ため明示入力。
//   - paymasterMode: gasReimbursement の sponsorship 判定に必要 (route と独立)。
//   - gasAmount / relayGasEquiv: paymaster quote と recover 手数料の解決済み値。

import {
  calcBreakdown,
  type Breakdown,
  type GasMode,
  type PayMode,
} from './fee';
import type { PaymasterMode } from './tokens';
import {
  isCircleRoute,
  isRecoverRoute,
  isRelayRoute,
  isStandardRoute,
  type PaymentRoute,
} from './paymentRoute';
import type { TokenSymbol } from './tokens';

/**
 * 現行 `effectiveGas`: recover は店舗吸収固定 (merchant)、それ以外は URL 由来の gasMode
 * (省略時 customer)。確定モデル (2026-06-12): JPYC recover は gasMode=merchant 強制で、
 * 旧 QR が gas=customer を載せていても無視する。
 *
 * 現行 CheckoutForm:
 *   `const effectiveGas = useRecover ? 'merchant' : (params.gas ?? 'customer');`
 */
export function effectiveGasMode(
  route: PaymentRoute,
  paramsGas: GasMode | undefined,
): GasMode {
  return isRecoverRoute(route) ? 'merchant' : (paramsGas ?? 'customer');
}

/**
 * 現行 `isMerchantGas`: 非 standard かつ effectiveGas==='merchant' (= 店舗が gas を吸収する)。
 *
 * 現行 CheckoutForm:
 *   `const isMerchantGas = !isStandard && effectiveGas === 'merchant';`
 */
export function isMerchantGasAbsorb(
  route: PaymentRoute,
  gasMode: GasMode,
): boolean {
  return !isStandardRoute(route) && gasMode === 'merchant';
}

/**
 * 現行 `effectiveMode`: standard route なら 'standard'、それ以外は呼出側の params.mode をそのまま。
 * calcBreakdown へ渡す PayMode を route から正規化する。
 *
 * 現行 CheckoutForm:
 *   `const effectiveMode = isStandard ? 'standard' : params.mode;`
 *
 * 注: 非 standard route のとき params.mode は 'gasless' (CheckoutForm の params.mode は
 * 'gasless'|'standard'|undefined だが、standard なら上の分岐で 'standard' を返すため、
 * ここに来る paramsMode は実質 'gasless' か undefined)。undefined は calcBreakdown の
 * 既定 'gasless' に倒れる (現行と同一・PayMode|undefined をそのまま透過させる)。
 */
export function effectivePayMode(
  route: PaymentRoute,
  paramsMode: PayMode | undefined,
): PayMode | undefined {
  return isStandardRoute(route) ? 'standard' : paramsMode;
}

/**
 * breakdown/会計に使う gas 相当額。relay は固定の回収額 (recover=回収手数料 / free=0)、JPYC 非 relay は
 * 0 (ガス無料化・OpenPay 全額負担)、それ以外 (USDC) は paymaster quote の gasAmount。
 *
 * 現行 CheckoutForm:
 *   ```
 *   const effectiveGasAmount = useRelay
 *     ? relayGasEquiv
 *     : isJpyc
 *       ? 0n
 *       : gasAmount;
 *   ```
 * 短絡順 (useRelay → isJpyc → gasAmount) を厳密に保つ。relay は quote を持たないため relayGasEquiv で
 * 切替える。relayGasEquiv は呼出側で `useRecover ? recoverFeeValue(totalWei, effectiveGas) : 0n` と
 * して解決した値 (recover=回収手数料・free=0)。gasAmount は `!isStandard ? activeQuote.data?.gasAmount
 * : undefined` で、未取得時は undefined のまま返る (現行どおり・breakdown 側で ?? 0n)。
 */
export function effectiveGasAmount(
  route: PaymentRoute,
  inputs: {
    isJpyc: boolean;
    /** recover 時の回収額 (= 利用料)。free / 非 relay では 0n。呼出側が recoverFeeValue で解決。 */
    relayGasEquiv: bigint;
    /** paymaster quote の gasAmount。standard / 未取得は undefined。 */
    gasAmount: bigint | undefined;
  },
): bigint | undefined {
  if (isRelayRoute(route)) return inputs.relayGasEquiv;
  if (inputs.isJpyc) return 0n;
  return inputs.gasAmount;
}

/**
 * 決済 breakdown (顧客支払 / 店主受取 / 利用手数料)。calcBreakdown を route 由来の effectiveMode /
 * effectiveGas / effectiveGasAmount で呼ぶ薄いラッパ。
 *
 * 現行 CheckoutForm:
 *   ```
 *   const breakdown = calcBreakdown(
 *     totalWei, params.token, effectiveMode, effectiveGas, effectiveGasAmount ?? 0n,
 *   );
 *   ```
 * effectiveGasAmount が undefined のとき 0n に倒すのは現行どおり (gas 未取得 = breakdown 上は 0)。
 */
export function paymentBreakdown(inputs: {
  totalWei: bigint;
  token: TokenSymbol;
  payMode: PayMode | undefined;
  gasMode: GasMode;
  effectiveGasAmount: bigint | undefined;
}): Breakdown {
  return calcBreakdown(
    inputs.totalWei,
    inputs.token,
    inputs.payMode,
    inputs.gasMode,
    inputs.effectiveGasAmount ?? 0n,
  );
}

/**
 * 現行 `gasReimbursement`: useBatchPayment が実 on-chain で feeReceiver へ加算送金する gas 立替回収額。
 * JPYC ガス無料化で JPYC は常に 0 (OpenPay 全額負担)、USDC mainnet erc20 も 0 (paymaster が顧客 USDC
 * から直接徴収)。残る testnet USDC sponsorship fallback (非 circle・非 JPYC・sponsorship) のみ回収。
 *
 * 現行 CheckoutForm:
 *   ```
 *   const gasReimbursement =
 *     !isJpyc && !isCircle && paymasterMode === 'sponsorship'
 *       ? (gasAmount ?? 0n)
 *       : 0n;
 *   ```
 * gasAmount (paymaster quote) を使う点に注意 (effectiveGasAmount ではない・JPYC は分岐前に弾かれるため
 * 同値だが式の同一性のため gasAmount を受ける)。
 */
export function gasReimbursementValue(
  route: PaymentRoute,
  inputs: {
    isJpyc: boolean;
    paymasterMode: PaymasterMode;
    gasAmount: bigint | undefined;
  },
): bigint {
  return !inputs.isJpyc &&
    !isCircleRoute(route) &&
    inputs.paymasterMode === 'sponsorship'
    ? (inputs.gasAmount ?? 0n)
    : 0n;
}

/**
 * 現行 `networkFeeEquivalent`: 会計分離用のネットワーク手数料相当額 (on-chain transfer とは別の記録)。
 * 非 standard かつ非 circle の gasless 経路は effectiveGasAmount を計上 (JPYC relay=回収額/0 or
 * sponsorship=立替回収 / USDC erc20=paymaster 徴収分)。circle は receipt 由来額を使うため null、
 * standard も null。
 *
 * 現行 CheckoutForm:
 *   ```
 *   const networkFeeEquivalent =
 *     !isStandard && !isCircle ? (effectiveGasAmount ?? 0n) : null;
 *   ```
 */
export function networkFeeEquivalentValue(
  route: PaymentRoute,
  effectiveGasAmt: bigint | undefined,
): bigint | null {
  return !isStandardRoute(route) && !isCircleRoute(route)
    ? (effectiveGasAmt ?? 0n)
    : null;
}

/**
 * 現行 `minimumAmountWei`: merchant underflow エラー文言に出す最小必要額。利用手数料 + (店舗吸収なら
 * gas 相当額)。fee=0 の現状では gas=merchant のとき effectiveGasAmount、それ以外は 0n。
 *
 * 現行 CheckoutForm:
 *   ```
 *   const minimumAmountWei =
 *     breakdown.feeAmount + (isMerchantGas ? (effectiveGasAmount ?? 0n) : 0n);
 *   ```
 */
export function minimumAmountWei(inputs: {
  feeAmount: bigint;
  isMerchantGas: boolean;
  effectiveGasAmount: bigint | undefined;
}): bigint {
  return (
    inputs.feeAmount +
    (inputs.isMerchantGas ? (inputs.effectiveGasAmount ?? 0n) : 0n)
  );
}
