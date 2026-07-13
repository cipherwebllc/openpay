// @handle の KV 永続化 (server 専用)。lib/handle.ts の純関数を使い、handle 予約/更新/解放/
// 解決/所有一覧を提供する。名前の確保と wallet 上限は単一 EVAL で atomic に判定する。
//
// KV キー:
//   handle:{handle}            → serialized HandleRecord
//   wallet:handles:{owner}     → Redis list (所有 handle・上限管理 + "mine" 一覧)
//   shops:agent-index          → Shops API 掲載 handle の一意 list (最大 500)
//   shops:summary:{handle}     → 検索用 materialized JSON
//
// 所有 index は Redis list で持ち、claim/release Lua 内の LPUSH/LREM で handle record と一緒に
// 更新する。読み取りエラーは [] と区別して null を返し、呼出側が中断する。

import {
  kvGet,
  kvLrange,
  kvEval,
  isKvConfigured,
} from '@/lib/kv';
import {
  parseHandleRecord,
  serializeHandleRecord,
  MAX_HANDLES_PER_WALLET,
  type HandleRecord,
  type HandleTipConfig,
  type HandleProfile,
} from '@/lib/handle';
import type { StorefrontParts } from '@/lib/mobileOrder';
import { shopLiveKey } from '@/lib/shopLive';

const handleKey = (handle: string) => `handle:${handle}`;
const ownerIndexKey = (owner: string) => `wallet:handles:${owner.toLowerCase()}`;
export const AGENT_SHOP_INDEX_KEY = 'shops:agent-index';
export const AGENT_SHOP_INDEX_MAX = 500;
export const agentShopSummaryKey = (handle: string) => `shops:summary:${handle}`;

function sameOwner(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Shops API 掲載 index + 検索 summary の同期処理。handle record の保存と同じ Lua に前置して、
// opt-in/opt-out・profile-only 更新・同時更新で別スナップショットが混ざらないようにする。
// 価格は decimal string のまま比較し、18 decimals を Number 化して丸めない。
// 戻り: 1=掲載同期済み/未掲載 cleanup 済み、2=index 満杯で掲載だけ拒否 (record 保存は成功)。
const AGENT_LISTING_LUA =
  "local function decparts(v) local d=string.find(v,'.',1,true); " +
  "local i=d and string.sub(v,1,d-1) or v; local f=d and string.sub(v,d+1) or ''; " +
  "i=string.gsub(i,'^0+',''); if i=='' then i='0' end; f=string.gsub(f,'0+$',''); return i,f end; " +
  'local function declt(a,b) local ai,af=decparts(a); local bi,bf=decparts(b); ' +
  'if string.len(ai)~=string.len(bi) then return string.len(ai)<string.len(bi) end; ' +
  'if ai~=bi then return ai<bi end; local n=math.max(string.len(af),string.len(bf)); ' +
  "af=af..string.rep('0',n-string.len(af)); bf=bf..string.rep('0',n-string.len(bf)); return af<bf end; " +
  'local function syncagent(r,h,cleanup) local idx=\'' + AGENT_SHOP_INDEX_KEY + "'; " +
  "local sk='shops:summary:'..h; local sf=r.storefront; " +
  "if type(sf)~='table' or sf.agentListing~=true then if cleanup then redis.call( 'LREM',idx,0,h); redis.call( 'DEL',sk) end; return 1 end; " +
  "local members=redis.call( 'LRANGE',idx,0,-1); local found=false; " +
  'for _,v in ipairs(members) do if v==h then found=true; break end end; ' +
  'if not found and #members>=' + AGENT_SHOP_INDEX_MAX + " then redis.call( 'DEL',sk); return 2 end; " +
  "redis.call( 'LREM',idx,0,h); redis.call( 'LPUSH',idx,h); " +
  "local name=sf.shopName; if type(name)~='string' or name=='' then name=r.config and r.config.name end; " +
  "if type(name)~='string' or name=='' then name='@'..h end; " +
  'local itemids={}; for i=1,#sf.menu do itemids[i]=sf.menu[i].id end; ' +
  'local minp=sf.menu[1].price; local maxp=minp; for i=2,#sf.menu do local p=sf.menu[i].price; ' +
  'if declt(p,minp) then minp=p end; if declt(maxp,p) then maxp=p end end; ' +
  'local s={handle=h,name=name,mode=sf.mode,dineIn=sf.dineIn==true,acceptingOrders=sf.acceptingOrders~=false,chain=sf.chain,' +
  'menu={itemCount=#sf.menu,minPrice=minp,maxPrice=maxp,itemIds=itemids},' +
  'chains=sf.chains or {sf.chain},updatedAt=r.updatedAt}; ' +
  'if sf.tagline then s.tagline=sf.tagline end; if sf.address then s.address=sf.address end; ' +
  'if sf.openFrom then s.openFrom=sf.openFrom end; if sf.lastOrder then s.lastOrder=sf.lastOrder end; ' +
  'if sf.minLeadMinutes then s.minLeadMinutes=sf.minLeadMinutes end; ' +
  "redis.call( 'SET',sk,cjson.encode(s)); return 1 end; ";

// 所有者と読込時 updatedAt が一致するときだけ record を置換する compare-and-set (更新)。
// 戻り: 1=更新 / 2=更新したが掲載 index 満杯 / 0=owner 不一致 / -1=消失 /
// -2=malformed / -3=updatedAt 競合。
const CAS_UPDATE =
  AGENT_LISTING_LUA +
  "local c=redis.call('GET',KEYS[1]); if not c then return -1 end; " +
  'local ok,o=pcall(cjson.decode,c); if not ok then return -2 end; ' +
  "if string.lower(o.owner)~=string.lower(ARGV[1]) then return 0 end; " +
  "if type(o.updatedAt)~='number' or o.updatedAt~=tonumber(ARGV[2]) then return -3 end; " +
  "local cleanup=type(o.storefront)=='table' and o.storefront.agentListing==true; " +
  'local nok,n=pcall(cjson.decode,ARGV[3]); if not nok then return -2 end; ' +
  "redis.call('SET',KEYS[1],ARGV[3]); return syncagent(n,string.sub(KEYS[1],8),cleanup)";

// 新規 claim の存在確認・所有数上限・保存・index 追記・旧 live 状態の失効を単一 EVAL にする。
// 戻り: 1=作成 / 2=作成したが掲載 index 満杯 / 0=既存 handle / -2=所有数上限。
const CLAIM_HANDLE =
  AGENT_LISTING_LUA +
  "if redis.call('GET',KEYS[1]) then return 0 end; " +
  "if redis.call('LLEN',KEYS[2])>=tonumber(ARGV[3]) then return -2 end; " +
  'local ok,n=pcall(cjson.decode,ARGV[1]); if not ok then return -3 end; ' +
  "redis.call('SET',KEYS[1],ARGV[1]); " +
  "redis.call('LPUSH',KEYS[2],ARGV[2]); " +
  "redis.call('DEL',KEYS[3]); return syncagent(n,ARGV[2],true)";

// 所有者一致時のみ handle・所有 index・live 状態・Shops API 掲載をまとめて削除する compare-and-delete。
// 同 owner の同時 DELETE + 別 owner の取り直しが交錯しても、新 owner のレコードを消さない。
// 戻り: 1=削除 / 0=owner 不一致 / -1=消失 / -2=malformed。
const RELEASE_HANDLE =
  "local c=redis.call('GET',KEYS[1]); if not c then return -1 end; " +
  'local ok,o=pcall(cjson.decode,c); if not ok then return -2 end; ' +
  "if type(o)~='table' or type(o.owner)~='string' then return -2 end; " +
  "if string.lower(o.owner)~=string.lower(ARGV[1]) then return 0 end; " +
  "redis.call('DEL',KEYS[1]); redis.call('LREM',KEYS[2],0,ARGV[2]); " +
  "redis.call('DEL',KEYS[3]); redis.call('LREM','" + AGENT_SHOP_INDEX_KEY + "',0,ARGV[2]); " +
  "redis.call('DEL','shops:summary:'..ARGV[2]); return 1";

// handle 解決の結果。KV エラー (ok:false) を「未存在」(ok:true, record:null) と区別する。
// outage 中に @handle ページが 404 / availability が「空き」と誤答するのを防ぐため。
export type ResolveHandleResult =
  | { ok: true; record: HandleRecord | null }
  | { ok: false };

/** handle → 保存レコード。未存在/malformed は {ok:true, record:null}。KV 未設定/エラーは {ok:false}
 *  (「未設定」を「未存在」と誤魔化さない — outage 中に 404/空きと誤答するのを防ぐ)。 */
export async function resolveHandle(
  handle: string,
): Promise<ResolveHandleResult> {
  const res = await kvGet(handleKey(handle)); // 未設定なら call() が {ok:false,'unconfigured'}
  if (!res.ok) return { ok: false };
  return { ok: true, record: parseHandleRecord(res.value) };
}

/**
 * owner が保有する handle 名一覧。**KV エラーは null** を返し「空」と区別する
 * (呼出側は null で中断し、上限の bypass / index 破壊を防ぐ)。空リストは [] (ok)。
 */
export async function listHandlesForOwner(
  owner: string,
): Promise<string[] | null> {
  if (!isKvConfigured()) return null;
  const res = await kvLrange(ownerIndexKey(owner), 0, -1);
  if (!res.ok) return null;
  const list = (res.value ?? []).filter(
    (x): x is string => typeof x === 'string',
  );
  return Array.from(new Set(list)); // 防御的 dedup (通常フローでは重複しない)
}

export interface OwnedHandle {
  handle: string;
  record: HandleRecord;
}

/**
 * owner が保有する handle を **保存レコード込み**で返す (編集 UI の prefill 用)。
 * 名前一覧 → 各 handle の record 取得 (最大 MAX_HANDLES_PER_WALLET=3 件なので N+1 許容)。
 * **KV エラーは null** を返し「空」と区別する (listHandlesForOwner と同じ流儀)。index に
 * 名前はあるが record が消えている/壊れている entry は黙ってスキップ (self-heal は別 op)。
 */
export async function listHandleRecordsForOwner(
  owner: string,
): Promise<OwnedHandle[] | null> {
  const names = await listHandlesForOwner(owner);
  if (names === null) return null;
  // 各 handle の record 取得は独立なので並列化 (上限 3 件・直列 N+1 を 1 ラウンドに潰す)。
  const results = await Promise.all(names.map((h) => kvGet(handleKey(h))));
  const out: OwnedHandle[] = [];
  for (let i = 0; i < names.length; i++) {
    const res = results[i];
    if (!res.ok) return null; // 取得失敗は「空」と誤認しない
    const record = parseHandleRecord(res.value);
    // owner を再確認: 過去の stale index が別 wallet の record を指しても他人の handle を
    // 編集対象として返さない。
    if (record && sameOwner(record.owner, owner)) out.push({ handle: names[i], record });
  }
  return out;
}

export type ReserveStatus =
  | 'created'
  | 'updated'
  | 'conflict'
  | 'taken'
  | 'limit'
  | 'kv_unavailable'
  | 'kv_error';

export type ReserveResult =
  | {
      status: 'created' | 'updated';
      record: HandleRecord;
      listing?: 'index_full';
    }
  | {
      status: Exclude<ReserveStatus, 'created' | 'updated'>;
      record?: never;
    };

/**
 * handle を予約 (新規) または更新 (所有者のみ)。
 * - 既存 & 別 owner → 'taken' / 既存 & 同 owner + updatedAt 一致 → 設定更新。
 * - 既存 & 同 owner でも expectedUpdatedAt 欠落/不一致 → 'conflict'。
 * - 新規 → EVAL で存在確認・所有数上限・保存・index 追記・旧 live 状態失効を atomic に行う。
 */
export async function reserveOrUpdateHandle(input: {
  handle: string;
  owner: string;
  config: HandleTipConfig;
  profile?: HandleProfile;
  // storefront の三状態: undefined = 変更しない / null = 削除 / object = 置換。
  // (StorefrontParts は menu≥1 ゆえ「空オブジェクトでクリア」が表現できないため null を使う。)
  storefront?: StorefrontParts | null;
  // 既存更新の読込 baseline。新規 claim では不要 (claim Lua が名前の一意性を守る)。
  expectedUpdatedAt?: number;
  nowMs: number;
}): Promise<ReserveResult> {
  if (!isKvConfigured()) return { status: 'kv_unavailable' };
  const {
    handle,
    owner,
    config,
    profile,
    storefront,
    expectedUpdatedAt,
    nowMs,
  } = input;
  const key = handleKey(handle);
  // profile の三状態: undefined = 「変更しない」(update は既存を保持・新規は無し)、
  // object = 置換 (空 {} は明示クリア)。config だけ更新する client が link-in-bio を
  // 不意に消さないため (omit と explicit-empty を区別)。
  const profileProvided = profile !== undefined;
  const cleanedProfile =
    profileProvided && Object.keys(profile).length > 0 ? profile : undefined;
  const storefrontProvided = storefront !== undefined;

  const existingRes = await kvGet(key);
  if (!existingRes.ok) return { status: 'kv_error' };
  const existing = parseHandleRecord(existingRes.value);

  if (existing) {
    if (!sameOwner(existing.owner, owner)) return { status: 'taken' };
    // 古い client の expectedUpdatedAt 欠落も安全側で拒否する。初回 GET と CAS の二段で
    // stale write を止め、config.to を含む全置換 payload の巻き戻りを防ぐ。
    if (expectedUpdatedAt !== existing.updatedAt) return { status: 'conflict' };
    // 高度 tip メタ (message/thanks/thanksUrl/webhook) は現行 UI が管理しない。新 config が
    // 省略していれば既存値を保持する (旧 Tip タブ / API 由来の設定を update で消さない)。
    // builder が明示送信した値があればそれを優先 (= 将来 UI を足したときに上書き可能)。
    const mergedConfig: HandleTipConfig = {
      ...config,
      message: config.message ?? existing.config.message,
      thanks: config.thanks ?? existing.config.thanks,
      thanksUrl: config.thanksUrl ?? existing.config.thanksUrl,
      webhook: config.webhook ?? existing.config.webhook,
    };
    // omit (undefined) なら既存 profile を保持、provided なら置換 (空はクリア)。
    const nextProfile = profileProvided ? cleanedProfile : existing.profile;
    // storefront も同様: undefined=保持 / null=クリア / object=置換。
    const nextStorefront = storefrontProvided ? (storefront ?? undefined) : existing.storefront;
    const record: HandleRecord = {
      owner: existing.owner,
      config: mergedConfig,
      ...(nextProfile ? { profile: nextProfile } : {}),
      ...(nextStorefront ? { storefront: nextStorefront } : {}),
      createdAt: existing.createdAt,
      updatedAt: Math.max(nowMs, existing.updatedAt + 1),
    };
    // 所有者 + baseline を atomic に再確認してから置換。updatedAt は serialize 前に確定し、
    // 成功時に同じ値を次の baseline として呼出側へ返す。
    const cas = await kvEval<number>(CAS_UPDATE, [key], [
      owner,
      String(expectedUpdatedAt),
      serializeHandleRecord(record),
    ]);
    if (!cas.ok) return { status: 'kv_error' };
    if (cas.value === 1) return { status: 'updated', record };
    if (cas.value === 2) return { status: 'updated', record, listing: 'index_full' };
    if (cas.value === -3) return { status: 'conflict' };
    return { status: 'taken' }; // 0/-1/-2: read 後に owner が変わった/消えた
  }

  const record: HandleRecord = {
    owner,
    config,
    ...(cleanedProfile ? { profile: cleanedProfile } : {}),
    ...(storefront ? { storefront } : {}),
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  const claim = await kvEval<number>(
    CLAIM_HANDLE,
    [key, ownerIndexKey(owner), shopLiveKey(handle)],
    [serializeHandleRecord(record), handle, String(MAX_HANDLES_PER_WALLET)],
  );
  if (!claim.ok) return { status: 'kv_error' };
  if (claim.value === 1) return { status: 'created', record };
  if (claim.value === 2) return { status: 'created', record, listing: 'index_full' };
  if (claim.value === -2) {
    // Lua の上限判定は raw LLEN。過去に残った stale/重複は Set dedup する
    // listHandlesForOwner より多く数え、実一覧が上限未満でも limit になり得る。既存分の
    // lazy repair は別途とし、今後の stale は release Lua の LREM で増やさない。
    return { status: 'limit' };
  }
  return { status: 'taken' }; // 0: EVAL 前に別 claim が確保
}

export type ReleaseStatus =
  | 'released'
  | 'not_found'
  | 'forbidden'
  | 'kv_unavailable'
  | 'kv_error';

/** handle を解放 (所有者のみ)。所有者確認と handle/index/live の削除を atomic に行う。 */
export async function releaseHandle(input: {
  handle: string;
  owner: string;
}): Promise<ReleaseStatus> {
  if (!isKvConfigured()) return 'kv_unavailable';
  const { handle, owner } = input;

  // 解放直前の shop:live PATCH が release 後の retry で live key を再作成する狭い race は残る。
  // 完全に閉じるには不変の所有世代 claimId が必要だが、schema 追加は今回の E1 では見送る。
  // 所有者一致を atomic に確認し、handle・index・live をまとめて削除する。
  const cas = await kvEval<number>(
    RELEASE_HANDLE,
    [handleKey(handle), ownerIndexKey(owner), shopLiveKey(handle)],
    [owner, handle],
  );
  if (!cas.ok) return 'kv_error';
  if (cas.value === 0) return 'forbidden';
  if (cas.value !== 1) return 'not_found';
  return 'released';
}
