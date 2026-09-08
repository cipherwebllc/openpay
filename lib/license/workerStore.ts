import 'server-only';

import { kvEval, kvGet } from '@/lib/kv';
import { LICENSE_DUE_INDEX } from './stock';
import { licenseJobKey, parseLicenseJob, type LicenseJob } from './jobs';

export const LICENSE_WORKER_LOCK = 'store:license:worker:lock';
export const LICENSE_ACTIVE_SUBMISSION = 'store:license:worker:active';

// lock + 原本 CAS + 恒久送信枠を同時に更新する。期限切れ worker の保存/nonce 再利用を隔離。
// Redis の途中エラーは rollback しないため、型と全引数を最初の write より前に確認する。
export const LICENSE_JOB_CAS =
  'local function kt(k) local t=redis.call("TYPE",k); if type(t)=="table" then return t.ok end; return t end; ' +
  'for _,i in ipairs({1,2,4}) do local t=kt(KEYS[i]); if t~="none" and t~="string" then return -1 end end; ' +
  'local t=kt(KEYS[3]); if t~="none" and t~="zset" then return -1 end; ' +
  'if redis.call("GET",KEYS[1])~=ARGV[1] or redis.call("GET",KEYS[2])~=ARGV[2] then return 0 end; ' +
  'local ok,v=pcall(cjson.decode,ARGV[3]); if not ok or type(v)~="table" or type(v.lease)~="table" or v.lease.token~=ARGV[1] then return -1 end; ' +
  'if type(v.nextAttemptAt)~="number" or v.nextAttemptAt<0 then return -1 end; ' +
  'local active=redis.call("GET",KEYS[4]); ' +
  'if ARGV[5]=="take" and active and active~=ARGV[4] then return 0 end; ' +
  'if ARGV[5]~="take" and ARGV[5]~="release" and ARGV[5]~="keep" then return -1 end; ' +
  'redis.call("SET",KEYS[2],ARGV[3]); ' +
  'if ARGV[5]=="take" then redis.call("SET",KEYS[4],ARGV[4]); elseif ARGV[5]=="release" and active==ARGV[4] then redis.call("DEL",KEYS[4]); end; ' +
  'if (v.status=="minted" or v.status=="registered" or v.status=="needs_repair") and not v.alertPending then redis.call("ZREM",KEYS[3],ARGV[4]); ' +
  'else redis.call("ZADD",KEYS[3],v.nextAttemptAt,ARGV[4]); end; return 1; ';

const DUE =
  'local t=redis.call("TYPE",KEYS[1]); if type(t)=="table" then t=t.ok end; ' +
  'if t~="none" and t~="zset" then return {"__storage__"} end; ' +
  'return redis.call("ZRANGEBYSCORE",KEYS[1],"-inf",ARGV[1],"LIMIT",0,20); ';

const QUARANTINE =
  'if redis.call("GET",KEYS[1])~=ARGV[1] then return 0 end; ' +
  'for _,i in ipairs({2,3}) do local t=redis.call("TYPE",KEYS[i]); if type(t)=="table" then t=t.ok end; if t~="none" and t~="zset" then return -1 end end; ' +
  'local now=tonumber(ARGV[4]); if not now then return -1 end; ' +
  'redis.call("ZADD",KEYS[3],now,ARGV[3]); redis.call("ZREM",KEYS[2],ARGV[2]); return 1; ';

export async function quarantineLicenseJob(member: string, token: string): Promise<void> {
  const marker = member.startsWith('registration:') ? member : 'mint:' + member;
  await kvEval(QUARANTINE, [LICENSE_WORKER_LOCK, LICENSE_DUE_INDEX, 'store:license:repair:quarantine'], [token, member, marker, String(Date.now())]);
}

export async function licenseDueMembers(now: number): Promise<string[] | 'storage'> {
  const result = await kvEval<string[]>(DUE, [LICENSE_DUE_INDEX], [String(now)]);
  if (!result.ok || !Array.isArray(result.value) || result.value.some((m) => typeof m !== 'string' || !licenseJobKey(m))) return 'storage';
  return result.value;
}

export async function readLicenseJob(member: string): Promise<{ job: LicenseJob; raw: string } | 'storage' | 'corrupt'> {
  const key = licenseJobKey(member);
  if (!key) return 'corrupt';
  const result = await kvGet(key);
  if (!result.ok) return 'storage';
  const job = parseLicenseJob(result.value);
  if (!job || (job.kind === 'mint' ? job.paymentKey !== member : 'registration:' + job.productId !== member)) return 'corrupt';
  return { job, raw: result.value! };
}

export async function saveLicenseJob(member: string, raw: string, job: LicenseJob, token: string, lane: 'take' | 'keep' | 'release' = 'keep'): Promise<boolean> {
  const key = licenseJobKey(member);
  if (!key) return false;
  const result = await kvEval<number>(LICENSE_JOB_CAS, [LICENSE_WORKER_LOCK, key, LICENSE_DUE_INDEX, LICENSE_ACTIVE_SUBMISSION],
    [token, raw, JSON.stringify(job), member, lane]);
  return result.ok && result.value === 1;
}
