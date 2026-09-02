import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 秘密 (bearer token / cron secret 等) の定数時間比較。
 *
 * 素の `!==` は最初の不一致 byte で早期 return するため、比較時間から秘密の前方一致長が
 * 漏れる。sha256 digest 同士を timingSafeEqual に渡すことで、長さの違いでも例外にならず
 * (timingSafeEqual は長さ不一致で throw する) 常に固定長の比較になる。
 *
 * auth 境界の唯一の実装 (payment-log admin・cron)。分岐が drift しないようここへ集約する。
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
