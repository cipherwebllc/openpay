import 'server-only';

import { kvEval, kvExists } from '@/lib/kv';
import { licenseNftEnabled } from './config';
import { LICENSE_DUE_INDEX, LICENSE_HOLD_INDEX, LICENSE_OBLIGATION_INDEX } from './stock';
import { LICENSE_REGISTRATION_INDEX } from './product';

// 恒久 index を cursor 付きでページングする。due 消失で有償の発行義務を見失わない。
// 壊れた record は独立 quarantine に残し、隣の正常ジョブの復旧を止めない (削除/解放なし)。
const REBUILD =
  'local function kt(k) local t=redis.call("TYPE",k); if type(t)=="table" then return t.ok end; return t end; ' +
  'for _,i in ipairs({1,2,4}) do if kt(KEYS[i])~="none" and kt(KEYS[i])~="zset" then return -1 end end; ' +
  'if kt(KEYS[3])~="none" and kt(KEYS[3])~="string" then return -1 end; ' +
  'local offset=tonumber(redis.call("GET",KEYS[3]) or "0"); local size=tonumber(ARGV[1]); local now=tonumber(ARGV[2]); ' +
  'if not offset or offset<0 or offset~=math.floor(offset) or not size or size<1 or size>100 or not now then return -1 end; ' +
  'local members=redis.call("ZREVRANGE",KEYS[1],offset,offset+size-1); local due={}; local bad={}; ' +
  'for _,member in ipairs(members) do ' +
  'local key=ARGV[3]..member; local value=nil; ' +
  'if kt(key)=="string" then local ok,v=pcall(cjson.decode,redis.call("GET",key)); if ok and type(v)=="table" then value=v end end; ' +
  'if not value then bad[#bad+1]=member; ' +
  'elseif ARGV[4]~="hold" and redis.call("ZSCORE",KEYS[4],ARGV[4]..":"..member) then ' +
  'elseif ARGV[4]=="hold" then ' +
  'if value.state~="settled" and value.state~="quoted" and type(value.metadata)=="table" and value.metadata.productKind=="license" then due[#due+1]={member,now}; end; ' +
  'elseif value.alertPending or (value.status~="minted" and value.status~="needs_repair" and value.status~="registered") then ' +
  'local score=tonumber(value.nextAttemptAt); if score and score>=0 then due[#due+1]={ARGV[5]..member,score}; else bad[#bad+1]=member end; ' +
  'end; end; ' +
  'for _,d in ipairs(due) do if not redis.call("ZSCORE",KEYS[2],d[1]) then redis.call("ZADD",KEYS[2],d[2],d[1]) end end; ' +
  'for _,m in ipairs(bad) do redis.call("ZADD",KEYS[4],now,ARGV[4]..":"..m) end; ' +
  'local nextOffset=offset+#members; if #members<size then nextOffset=0 end; redis.call("SET",KEYS[3],tostring(nextOffset)); return #due; ';

export async function repairLicenseIndexes(now = Date.now(), limit = 50): Promise<boolean> {
  if (!licenseNftEnabled()) return true;
  // 巡る元の恒久 index が 3 つとも無い (ライセンスの購入・登録がまだ 1 件も無い) なら拾うものが無い。
  // 3 本の Lua は型の確かめと offset の書き戻しだけで 1 回 約 30 コマンドを使うので、EXISTS 1 コマンドで飛ばす
  // (2026-10-01 本番実測: 毎時の修復 run が 34 コマンド・商品ゼロのまま 1 日 約 800)。
  const sources = await kvExists([LICENSE_HOLD_INDEX, LICENSE_OBLIGATION_INDEX, LICENSE_REGISTRATION_INDEX]);
  if (!sources.ok) return false;
  if (sources.value === 0) return true;
  for (const [source, dest, prefix, kind, memberPrefix] of [
    [LICENSE_HOLD_INDEX, 'store:intent:pending', 'store:intent:', 'hold', ''],
    [LICENSE_OBLIGATION_INDEX, LICENSE_DUE_INDEX, 'store:license:ob:', 'mint', ''],
    [LICENSE_REGISTRATION_INDEX, LICENSE_DUE_INDEX, 'store:license:registration:', 'registration', 'registration:'],
  ]) {
    const r = await kvEval<number>(REBUILD, [source!, dest!, 'store:license:repair:' + kind, 'store:license:repair:quarantine'], [String(limit), String(now), prefix!, kind!, memberPrefix!]);
    // kvEval は Redis の値の形までしか確かめない。数でない応答 (nil・文字列・配列) は `< 0` が false になり修復済みと
    // 読まれるので、REBUILD が返す件数 (0 以上の整数) のときだけ成功にする (修復の失敗を cron の成功で隠す波及を断つ)。
    if (!r.ok || typeof r.value !== 'number' || r.value < 0) return false;
  }
  return true;
}
