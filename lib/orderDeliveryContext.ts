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
    const url = new URL(context.webhook);
    return url.origin === origin && url.pathname === '/api/order/notify' &&
      url.searchParams.getAll('h').length === 1 && normalizeHandle(url.searchParams.get('h')!) === order.handle;
  } catch {
    // An invalid current callback cannot attribute a different checkout's saved payment here.
    return false;
  }
}
