import 'server-only';

import { logger } from '@/lib/logger';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { anonymizeIp } from '@/lib/relay/relayRoute';

export const FACILITATOR_STATUS_RATE_LIMIT_MAX = 30;
export const FACILITATOR_STATUS_RATE_LIMIT_WINDOW_SEC = 60;

export async function checkFacilitatorStatusRateLimit(
  req: Request,
): Promise<boolean> {
  const ip = clientIp(req);
  const allowed = await checkIpRateLimit(
    'x402-status',
    hashIp(ip),
    FACILITATOR_STATUS_RATE_LIMIT_MAX,
    FACILITATOR_STATUS_RATE_LIMIT_WINDOW_SEC,
  );
  if (!allowed) {
    // 同じ送信元からの内部/公開 status poll が RPC 読取を共有して枯らす波及を断つ。
    logger.warn('x402.facilitator.status.rate_limited', {
      ipPrefix: anonymizeIp(ip ?? ''),
    });
  }
  return allowed;
}
