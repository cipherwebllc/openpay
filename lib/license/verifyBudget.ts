import 'server-only';

import { randomUUID } from 'node:crypto';
import { kvEval } from '@/lib/kv';

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
  await kvEval(RELEASE, [KEY], [token]);
}
