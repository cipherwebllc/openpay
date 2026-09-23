import 'server-only';

import { logger } from '@/lib/logger';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { anonymizeIp } from '@/lib/relay/relayRoute';

export const AGENT_ACTIVITY_RATE_LIMIT_MAX = 20;
export const AGENT_ACTIVITY_RATE_LIMIT_WINDOW_SEC = 60;
// 分単位の上限だけだと 20 回/分 × 1,440 分 = 28,800 回で、API キー全体の日次予算 (30,000) を 1 つの送信元が
// ほぼ使い切れる。人の閲覧は 1 表示あたり 1〜4 回 (入金後の再取得を含む) なので、1 日 300 回で十分余る。
export const AGENT_ACTIVITY_DAILY_RATE_LIMIT_MAX = 300;
export const AGENT_ACTIVITY_DAILY_RATE_LIMIT_WINDOW_SEC = 24 * 60 * 60;

// 拒否のたびに warn を出すと、無認証の公開 endpoint では攻撃者が Sentry のイベント量を決められる。
// プロセス内で 1 分に 1 回だけ記録する (lib/net/ipHash.ts の一度きり警告と同じ考え方)。
let lastWarnedAtMs = 0;

function warnRateLimited(ip: string | null, window: 'minute' | 'day'): void {
  const now = Date.now();
  if (now - lastWarnedAtMs < 60_000) return;
  lastWarnedAtMs = now;
  // ログには生 IP を残さない。
  logger.warn('agent.activity.rate_limited', {
    ipPrefix: anonymizeIp(ip ?? ''),
    window,
  });
}

export async function checkAgentActivityRateLimit(req: Request): Promise<boolean> {
  const ip = clientIp(req);
  const hashed = hashIpBucket(ip);
  // 同じ送信元の連打が共有 API 枠へ波及するのを断つ (どちらも KV 障害時は fail-open = checkIpRateLimit の仕様)。
  const minuteAllowed = await checkIpRateLimit(
    'agent-activity',
    hashed,
    AGENT_ACTIVITY_RATE_LIMIT_MAX,
    AGENT_ACTIVITY_RATE_LIMIT_WINDOW_SEC,
  );
  if (!minuteAllowed) {
    warnRateLimited(ip, 'minute');
    return false;
  }
  const dayAllowed = await checkIpRateLimit(
    'agent-activity-day',
    hashed,
    AGENT_ACTIVITY_DAILY_RATE_LIMIT_MAX,
    AGENT_ACTIVITY_DAILY_RATE_LIMIT_WINDOW_SEC,
  );
  if (!dayAllowed) warnRateLimited(ip, 'day');
  return dayAllowed;
}
