// 遠隔の注文: この会計をこのタブで払った記録 (lib/orderConfirmation.ts の rememberOrderPayment) を、リンクが受け付ける
// 全部のチェーンで探す。記録の鍵 (checkoutIntentContextFingerprint) はチェーンごとに違うので、Polygon で払った後に
// 同じリンクを開いて Kaia を選ぶと「払った」と分からず二重に払わせてしまう (plans/order-link-multichain.md・Fable P1)。

import type { ChainSlug } from './chains';
import { checkoutIntentContextFingerprint } from './checkoutIntentContext';
import { rememberedOrderPayment, type RememberedOrderPayment } from './orderConfirmation';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from './tokens';
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
