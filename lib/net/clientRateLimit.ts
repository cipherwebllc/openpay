import 'server-only';

import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit, checkReadRateLimit } from '@/lib/relay/relayGuards';
import { anonymizeIp } from '@/lib/relay/relayRoute';

// 利用者 IP の limiter を「どの鍵戦略か」が名前で分かる形にした薄い wrapper。
// 呼び出しごとの現行の鍵・窓・名前空間・IP 不明時の扱いをそのまま保つ (R6b)。
// 戦略を寄せる (鍵を変える) と本番のカウンタがリセットされるので、統一は B-R6 で別に判断する。
// 鍵と応答は tests/app/api/limiter-strategy-pinning.test.ts が KV の境界で固定している。
// IP の解決と HMAC (と警告 flag) は lib/net/ipHash だけが持つ。ここでは複製しない。

/**
 * ip-bucket 戦略: 鍵 `iprl:v1:<scope>:<HMAC(IPv4 /32・IPv6 /64)>`、INCR の初回 TTL = 窓。
 * IP 不明・IP_HASH_SECRET 欠落は KV に触れず許可する (共有 bucket に寄せない)。
 * `checkIpRateLimit(scope, hashIpBucket(clientIp(req)), max, windowSec)` と同じ呼び出し。
 */
export function checkClientIpBucketRateLimit(
  req: Request,
  scope: string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  return checkIpRateLimit(scope, hashIpBucket(clientIp(req)), max, windowSec);
}

/**
 * ip-prefix 戦略: 鍵 `rl:read:<keyFor(匿名化 prefix)>:<floor(now/窓)>` (IPv4 /24・IPv6 /64 の生 prefix)、
 * 時計に揃えた固定窓。IP 不明は共有の 'unknown' bucket に数え、IP_HASH_SECRET は使わない。
 * `checkReadRateLimit(keyFor(anonymizeIp(clientIp(req) ?? '')), max, windowSec)` と同じ呼び出し。
 */
export function checkClientIpPrefixRateLimit(
  req: Request,
  keyFor: (ipPrefix: string) => string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  const ipPrefix = anonymizeIp(clientIp(req) ?? '');
  return checkReadRateLimit(keyFor(ipPrefix), max, windowSec);
}
