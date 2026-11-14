import { parseOwnOrderNotifyUrl } from '@/lib/order/ownNotifyUrl';
import type { CanonicalOrder } from '@/lib/orderBind';
import type { RelayIntentMetadata } from '@/lib/paymentIntentStorage';

export type OrderDeliveryContext = {
  merchant: string;
  chainId: number;
  tokenAddress: string;
  webhook?: string;
  orderId?: string;
  totalValue: bigint;
};

// Match lib/handle's normalization without its storefront dependencies on first render.
const normalizeHandle = (raw: string) => raw.trim().replace(/^@+/, '').toLowerCase();

// Keep this matcher free of ABI/storage imports: CheckoutForm uses it on first render.
export function matchesOrderDeliveryContext(order: CanonicalOrder, context: OrderDeliveryContext, origin: string, intent: Pick<RelayIntentMetadata, 'merchantValue' | 'feeValue'>): boolean {
  if (context.chainId !== order.chainId ||
    context.merchant.toLowerCase() !== order.merchant.toLowerCase() ||
    context.tokenAddress.toLowerCase() !== order.tokenAddress.toLowerCase() ||
    (context.orderId !== undefined && context.orderId !== order.orderId) || !context.webhook) return false;
  try {
    if (BigInt(intent.merchantValue) + BigInt(intent.feeValue) !== context.totalValue) return false;
    // An invalid current callback cannot attribute a different checkout's saved payment here
    // (読めない URL は 'unreadable' = 自社でない)。`h` がちょうど 1 つで、正規化して保存した注文の handle と同じこと。
    // ほかの所との方針の差は lib/order/ownNotifyUrl.ts の冒頭の表。
    const webhook = parseOwnOrderNotifyUrl(context.webhook, origin);
    return webhook.kind === 'own' && webhook.handles.length === 1 && normalizeHandle(webhook.handles[0]) === order.handle;
  } catch {
    // 保存した額が数として読めない (BigInt が投げる) 記録を、この会計のものとして扱わない。
    return false;
  }
}
