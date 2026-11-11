// 遠隔の注文: この会計をこのタブで払った記録 (lib/orderConfirmation.ts の rememberOrderPayment) を、リンクが受け付ける
// 全部のチェーンで探す。記録の鍵 (checkoutIntentContextFingerprint) はチェーンごとに違うので、Polygon で払った後に
// 同じリンクを開いて Kaia を選ぶと「払った」と分からず二重に払わせてしまう (plans/order-link-multichain.md・Fable P1)。

import type { ChainSlug } from './chains';
import { checkoutIntentContextFingerprint } from './checkoutIntentContext';
import { rememberedOrderPayment, type RememberedOrderPayment } from './orderConfirmation';
import type { SettlementScreen } from './paymentFlowGuards/restoredSettlement';
import { counterpartSymbol, DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug, deploymentsForSymbol } from './tokens';
import { calcCheckoutPayable, type CheckoutParams } from './url/checkout';

/** この会計 (そのチェーンで払うとき) の記録の鍵。CheckoutForm の checkoutContextKey と同じ値。 */
export function orderPaymentContextKey(params: CheckoutParams, chain: ChainSlug): string {
  const deployment = deploymentForSlug(params.token, chain);
  return checkoutIntentContextFingerprint({
    params: { ...params, chain },
    chainId: deployment.chainId,
    tokenAddress: deployment.address,
    totalAtomic: calcCheckoutPayable(params, deployment.decimals).toString(),
  });
}

/** リンクが受け付けるチェーン (chains が 2 つ以上ならその全部・無ければ今の chain だけ) で、払った記録を探す。 */
export function findRememberedOrderPayment(
  params: CheckoutParams,
  now: number,
): { chain: ChainSlug; payment: RememberedOrderPayment } | null {
  const current = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const chains = params.chains && params.chains.length >= 2 ? params.chains : [current];
  for (const chain of chains) {
    const payment = rememberedOrderPayment(orderPaymentContextKey(params, chain), now);
    if (payment) return { chain, payment };
  }
  return null;
}

/**
 * この会計の形 (復元した支払いの確定がこの会計のものかの判定に渡す・lib/paymentFlowGuards/restoredSettlement・第 10 回
 * レビュー H-S)。URL で決まる受取先と額 (値引き後の合計) と、別の token の address だけを渡す。会計の鍵・注文リンクの鍵・
 * 受け付ける chain の組は渡さない (parser・指紋の入力・chain の flag が払った後に変わると、同じ支払いでも値がずれる)。
 */
export function checkoutSettlementScreen(params: CheckoutParams): SettlementScreen {
  const chain = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const own = deploymentsForSymbol(params.token).map((deployment) => deployment.address.toLowerCase());
  return {
    merchant: params.to,
    amount: calcCheckoutPayable(params, deploymentForSlug(params.token, chain).decimals),
    // 上乗せの形 (受取 = 合計) になりうるのは事前注文でお客様の負担の URL だけ (lib/mobileOrderFee の mobileOrderGasMode・
    // 負担者が無い・お店の負担・店頭はお店の負担で 受取 + 利用料 = 合計)。flag・料率は払った後に変わるので見ない。
    customerFeeOnTop: params.feeKind === 'preorder' && params.feePayer === 'customer',
    // 別の symbol の deployment の address。address の上書き (env) は形しか確かめず、symbol の間で重ならないことを強制しない
    // ので、この画面の symbol の今の address と重なるものは「どちらの token か決められない」= 除く (何の波及を断つか:
    // 別の token の設定の誤りで、この token の正当な支払いを別の支払いとすること)。除いた後に残る誤りは、別の token の上書きが
    // この token の今は表に無い昔の address と同じになる場合だけ (2 つの設定の誤りが重なる場合)。
    otherTokenAddresses: deploymentsForSymbol(counterpartSymbol(params.token))
      .map((deployment) => deployment.address)
      .filter((address) => !own.includes(address.toLowerCase())),
    contextKeyed: true,
  };
}
