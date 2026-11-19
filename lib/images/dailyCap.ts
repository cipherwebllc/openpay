import 'server-only';

import { isKvConfigured, kvIncr } from '@/lib/kv';
import { IMAGE_UPLOAD_DAILY_GLOBAL } from '@/lib/images/purpose';

// 全体の 1 日の回数 (UTC 日)。ほかの limiter (checkReadRateLimit・checkIpRateLimit) と違い **fail-closed**: KV が
// 無い・加算に失敗したときは「数えられない」を返し、route はアップロードを止める (503)。
// 止めてよい理由 (掟 13): 画像の欄は URL を貼っても使えるので、止めても商品・プロフの保存と決済には波及しない。一方で
// 通すと、ウォレットを作り直す・IP を替える人に Blob の書き込み (費用) を上限なしで許す。

const DAY_SEC = 86_400;

export type GlobalDailyCount = 'allowed' | 'limited' | 'unavailable';

/** UTC 日の窓が切り替わるまでの秒数 (Retry-After)。 */
export function secondsUntilNextUtcDay(nowMs = Date.now()): number {
  return DAY_SEC - (Math.floor(nowMs / 1000) % DAY_SEC);
}

export function imageUploadGlobalDailyKey(nowMs = Date.now()): string {
  return `images:upload:global:${Math.floor(nowMs / (DAY_SEC * 1000))}`;
}

/** 1 回分を数える。上限を超えたら limited、数えられなければ unavailable。 */
export async function countGlobalImageUpload(): Promise<GlobalDailyCount> {
  if (!isKvConfigured()) return 'unavailable';
  // 期限は窓 2 つ分 (checkReadRateLimit と同じ)。EXPIRE NX だけが落ちても INCR の数は返る (lib/kv の kvIncr)。
  const result = await kvIncr(imageUploadGlobalDailyKey(), { initialTtlSec: DAY_SEC * 2 });
  if (!result.ok) return 'unavailable';
  return result.value <= IMAGE_UPLOAD_DAILY_GLOBAL ? 'allowed' : 'limited';
}
