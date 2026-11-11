// 遠隔の注文: この会計をこのタブで払った記録 (lib/orderConfirmation.ts の rememberOrderPayment) を、リンクが受け付ける
// 全部のチェーンで探す。記録の鍵 (checkoutIntentContextFingerprint) はチェーンごとに違うので、Polygon で払った後に
// 同じリンクを開いて Kaia を選ぶと「払った」と分からず二重に払わせてしまう (plans/order-link-multichain.md・Fable P1)。

import type { Hex } from 'viem';
import type { ChainSlug } from './chains';
import { checkoutIntentContextFingerprint, orderLinkContextFingerprint } from './checkoutIntentContext';
import { rememberedOrderPayment, type RememberedOrderPayment } from './orderConfirmation';
import type { SettlementScreen } from './paymentFlowGuards/restoredSettlement';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from './tokens';
import { calcCheckoutPayable, type CheckoutParams } from './url/checkout';

/** この会計 (そのチェーンで払うとき) の記録の鍵。CheckoutForm の checkoutContextKey と同じ値。 */
export function orderPaymentContextKey(params: CheckoutParams, chain: ChainSlug): Hex {
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
 * レビュー H-S)。chain・token・会計の鍵・注文リンクの鍵は、リンクが受け付ける全部のチェーンの分を入れる (別のチェーンを
 * 選んだ画面で、同じ注文の支払いを別の会計としない)。額は合計 (値引き後・同じ token は全チェーンで同じ小数の桁)。
 * remoteOrder = 注文リンクの会計 (isRemoteOrderCheckout)・relayAlwaysBound = 受注を同一 origin の notify へ送る会計。
 */
export function checkoutSettlementScreen(
  params: CheckoutParams,
  remoteOrder: boolean,
  relayAlwaysBound: boolean,
): SettlementScreen {
  const current = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const chains = params.chains && params.chains.length >= 2 ? params.chains : [current];
  const deployments = chains.map((chain) => deploymentForSlug(params.token, chain));
  const contextKeys = chains.map((chain) => orderPaymentContextKey(params, chain));
  return {
    chainIds: deployments.map((deployment) => deployment.chainId),
    tokenAddresses: deployments.map((deployment) => deployment.address),
    merchant: params.to,
    amount: calcCheckoutPayable(params, deployments[0].decimals),
    // 上乗せの形 (受取 = 合計) になりうるのは事前注文でお客様の負担の URL だけ (lib/mobileOrderFee の mobileOrderGasMode・
    // 負担者が無い・お店の負担・店頭はお店の負担で 受取 + 利用料 = 合計)。flag・料率は払った後に変わるので見ない。
    customerFeeOnTop: params.feeKind === 'preorder' && params.feePayer === 'customer',
    contextKeys,
    orderLinkKeys: remoteOrder ? contextKeys.map((key) => orderLinkContextFingerprint(key, params)) : null,
    relayAlwaysBound,
  };
}
