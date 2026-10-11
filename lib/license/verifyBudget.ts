import 'server-only';

import { randomUUID } from 'node:crypto';
import { kvEval } from '@/lib/kv';
import { logger } from '@/lib/logger';

const KEY = 'store:license:verify:rpc';
// インスタンスを跨ぐ RPC 同時実行上限。失効済み枠だけ回収し、crash による占有を隔離する。
export const LICENSE_VERIFY_BUDGET =
  'local t=redis.call("TYPE",KEYS[1]); if type(t)=="table" then t=t.ok end; ' +
  'if t~="none" and t~="zset" then return -1 end; ' +
  'local now=tonumber(ARGV[1]); if not now then return -1 end; ' +
  'local expired=redis.call("ZRANGEBYSCORE",KEYS[1],"-inf",now); for _,v in ipairs(expired) do redis.call("ZREM",KEYS[1],v) end; ' +
  'local active=redis.call("ZREVRANGE",KEYS[1],0,7); if #active>=8 then return 0 end; ' +
  'redis.call("ZADD",KEYS[1],now+60000,ARGV[2]); redis.call("EXPIRE",KEYS[1],70); return 1; ';
const RELEASE = 'return redis.call("ZREM",KEYS[1],ARGV[1]); ';

export async function acquireLicenseVerifyBudget(): Promise<string | null> {
  const token = randomUUID();
  const result = await kvEval<number>(LICENSE_VERIFY_BUDGET, [KEY], [String(Date.now()), token]);
  // 集計枠の障害時に無制限 RPC を開始しない。呼出側は権利 unknown として返す。
  return result.ok && result.value === 1 ? token : null;
}

export async function releaseLicenseVerifyBudget(token: string): Promise<void> {
  warnUnlessBudgetReleased('license.verify_budget_release_failed', await kvEval<number>(RELEASE, [KEY], [token]));
}

/**
 * 枠の返却 (RELEASE = ZREM) の応答を確かめ、返せなかったときだけ warn を残す。1 = 返した。0 = 枠に無い (60 秒 lease が
 * 返却より先に失効して回収された = 処理が lease より長く、その間は同時実行の上限が効いていなかった)。KV 障害・想定外の
 * 応答は、枠が lease の失効まで残る (その間は枠が 1 つ減る)。
 * 掟 13: 投げない・挙動を変えない。返却の失敗を呼出側の権利の応答・配信へ波及させない (枠は lease の失効で回収される)。
 */
export function warnUnlessBudgetReleased(event: string, result: { ok: true; value: unknown } | { ok: false; reason: string }): void {
  if (result.ok && result.value === 1) return;
  if (!result.ok) logger.warn(event, { outcome: 'storage', reason: result.reason });
  else logger.warn(event, { outcome: result.value === 0 ? 'not_held' : 'unexpected_reply' });
}
