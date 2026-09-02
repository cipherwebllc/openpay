import 'server-only';

import { safeEqual } from '@/lib/net/safeEqual';

/**
 * Vercel Cron からの呼び出しであることの検証 (`Authorization: Bearer <CRON_SECRET>`)。
 *
 * CRON_SECRET は server route だけが直接読む秘密なので、client 共有の `lib/env.ts` には載せず
 * ここで process.env を読む。未設定なら false = 401 (fail-closed: 秘密が無い環境で cron を
 * 開けない)。比較は timing-safe (`lib/net/safeEqual`)。
 *
 * 呼出側は `if (!requireCronAuth(req)) return 401` の 1 形だけを使い、cron route 間で
 * auth 判定が drift しないようにする。
 */
export function requireCronAuth(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return false;
  return safeEqual(authHeader, `Bearer ${cronSecret}`);
}
