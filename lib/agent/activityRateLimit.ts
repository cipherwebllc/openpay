import 'server-only';

import { logger } from '@/lib/logger';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { anonymizeIp } from '@/lib/relay/relayRoute';

export const AGENT_ACTIVITY_RATE_LIMIT_MAX = 20;
export const AGENT_ACTIVITY_RATE_LIMIT_WINDOW_SEC = 60;

export async function checkAgentActivityRateLimit(req: Request): Promise<boolean> {
  const ip = clientIp(req);
  const allowed = await checkIpRateLimit(
    'agent-activity',
    hashIp(ip),
    AGENT_ACTIVITY_RATE_LIMIT_MAX,
    AGENT_ACTIVITY_RATE_LIMIT_WINDOW_SEC,
  );
  if (!allowed) {
    // 同じ送信元の連打が共有 API 枠へ波及するのを断つ。ログには生 IP を残さない。
    logger.warn('agent.activity.rate_limited', {
      ipPrefix: anonymizeIp(ip ?? ''),
    });
  }
  return allowed;
}
