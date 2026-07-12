import 'server-only';

import { NextResponse } from 'next/server';
import { getAddress, isAddress, type Address } from 'viem';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { env } from '@/lib/env';
import { kvGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { isOrderTokenLike, orderTokenKey, orderTokenRevKey } from '@/lib/orderToken';

export type OrderFeedActor = { merchant: Address } | { response: NextResponse };

function invalidToken() {
  return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 401 });
}

function kvError() {
  return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 503 });
}

/**
 * feed/calls 共通の店側主体解決。優先順は店員トークン → SIWE。トークンは reverse lookup だけでなく
 * merchant の現行 token とも一致させ、rotate/revoke 済みを即時失効する。
 * 呼び出し前に isKvConfigured() を確認すること。
 */
export async function resolveOrderFeedMerchant(req: Request): Promise<OrderFeedActor> {
  if (env.enableOrderToken) {
    const token = req.headers.get('x-order-token');
    if (token) {
      if (!isOrderTokenLike(token)) return { response: invalidToken() };
      const rev = await kvGet(orderTokenRevKey(token));
      if (!rev.ok) {
        logger.warn('order.feed.kv_error', { reason: rev.reason, op: 'token_lookup' });
        return { response: kvError() };
      }
      if (!rev.value || !isAddress(rev.value)) return { response: invalidToken() };
      const merchant = getAddress(rev.value);
      const current = await kvGet(orderTokenKey(merchant));
      if (!current.ok) {
        logger.warn('order.feed.kv_error', { reason: current.reason, op: 'token_current' });
        return { response: kvError() };
      }
      if (current.value !== token) return { response: invalidToken() };
      return { merchant };
    }
  }
  const session = await requireSession();
  if (!session.ok) return { response: session.response };
  return { merchant: session.address };
}
