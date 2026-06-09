// @handle の KV 永続化 (server 専用)。lib/handle.ts の純関数を使い、handle 予約/更新/解放/
// 解決/所有一覧を提供する。名前の確保は kvSet(nx) で atomic (entitlement / fee verify と同じ流儀)。
//
// KV キー:
//   handle:{handle}            → serialized HandleRecord
//   wallet:handles:{owner}     → Redis list (所有 handle・上限管理 + "mine" 一覧)
//
// 所有 index は Redis list で持ち、追記は LPUSH・削除は LREM の**原子操作**にする
// (read-modify-write は同時 claim で取りこぼすため)。読み取りエラーは [] と区別して null を
// 返し、呼出側が中断する (上限チェックの bypass / index 破壊を防ぐ)。
// per-wallet 上限は count→claim の TOCTOU が残るが best-effort (handle 名の一意性は nx が権威)。

import {
  kvGet,
  kvSet,
  kvDel,
  kvLpush,
  kvLrange,
  kvLrem,
  kvEval,
  isKvConfigured,
} from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  parseHandleRecord,
  serializeHandleRecord,
  MAX_HANDLES_PER_WALLET,
  type HandleRecord,
  type PublishableTipConfig,
} from '@/lib/handle';

const handleKey = (handle: string) => `handle:${handle}`;
const ownerIndexKey = (owner: string) => `wallet:handles:${owner.toLowerCase()}`;

function sameOwner(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// 所有者一致時のみ record を置換する compare-and-set (更新)。read→write の隙に別 owner が
// 取り直した場合の上書きを防ぐ。戻り: 1=更新 / 0=owner 不一致 / -1=消失 / -2=malformed。
const CAS_UPDATE =
  "local c=redis.call('GET',KEYS[1]); if not c then return -1 end; " +
  'local ok,o=pcall(cjson.decode,c); if not ok then return -2 end; ' +
  "if string.lower(o.owner)~=string.lower(ARGV[1]) then return 0 end; " +
  "redis.call('SET',KEYS[1],ARGV[2]); return 1";

// 所有者一致時のみ削除する compare-and-set (解放)。同 owner の同時 DELETE + 別 owner の
// 取り直しが交錯しても、新 owner のレコードを消さない。戻り: 1/0/-1/-2 は CAS_UPDATE と同義。
const CAS_DELETE =
  "local c=redis.call('GET',KEYS[1]); if not c then return -1 end; " +
  'local ok,o=pcall(cjson.decode,c); if not ok then return -2 end; ' +
  "if string.lower(o.owner)~=string.lower(ARGV[1]) then return 0 end; " +
  "redis.call('DEL',KEYS[1]); return 1";

// handle 解決の結果。KV エラー (ok:false) を「未存在」(ok:true, record:null) と区別する。
// outage 中に @handle ページが 404 / availability が「空き」と誤答するのを防ぐため。
export type ResolveHandleResult =
  | { ok: true; record: HandleRecord | null }
  | { ok: false };

/** handle → 保存レコード。KV 未設定/未存在/malformed は {ok:true, record:null}。KV エラーは {ok:false}。 */
export async function resolveHandle(
  handle: string,
): Promise<ResolveHandleResult> {
  if (!isKvConfigured()) return { ok: true, record: null };
  const res = await kvGet(handleKey(handle));
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

export type ReserveStatus =
  | 'created'
  | 'updated'
  | 'taken'
  | 'limit'
  | 'kv_unavailable'
  | 'kv_error';

export interface ReserveResult {
  status: ReserveStatus;
  record?: HandleRecord;
}

/**
 * handle を予約 (新規) または更新 (所有者のみ)。
 * - 既存 & 別 owner → 'taken' / 既存 & 同 owner → 設定更新 ('updated'・createdAt 保持)。
 * - 新規 → 所有一覧の読み取り (null=KV エラーは中断) → 上限チェック → nx で atomic claim →
 *   LPUSH で index 原子追記。LPUSH 失敗時は claim を rollback (orphan 防止)。
 */
export async function reserveOrUpdateHandle(input: {
  handle: string;
  owner: string;
  config: PublishableTipConfig;
  nowMs: number;
}): Promise<ReserveResult> {
  if (!isKvConfigured()) return { status: 'kv_unavailable' };
  const { handle, owner, config, nowMs } = input;
  const key = handleKey(handle);

  const existingRes = await kvGet(key);
  if (!existingRes.ok) return { status: 'kv_error' };
  const existing = parseHandleRecord(existingRes.value);

  if (existing) {
    if (!sameOwner(existing.owner, owner)) return { status: 'taken' };
    const record: HandleRecord = {
      owner: existing.owner,
      config,
      createdAt: existing.createdAt,
      updatedAt: nowMs,
    };
    // 所有者一致を atomic に再確認してから置換 (read→write の隙に別 owner が取り直した
    // 場合の上書きを防ぐ)。
    const cas = await kvEval<number>(CAS_UPDATE, [key], [
      owner,
      serializeHandleRecord(record),
    ]);
    if (!cas.ok) return { status: 'kv_error' };
    if (cas.value === 1) return { status: 'updated', record };
    return { status: 'taken' }; // 0/-1/-2: read 後に owner が変わった/消えた
  }

  const owned = await listHandlesForOwner(owner);
  if (owned === null) return { status: 'kv_error' }; // 読み取り失敗を「空」と誤認しない
  if (owned.length >= MAX_HANDLES_PER_WALLET) return { status: 'limit' };

  const record: HandleRecord = {
    owner,
    config,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  const claim = await kvSet(key, serializeHandleRecord(record), { nx: true });
  if (!claim.ok) return { status: 'kv_error' };
  if (claim.value !== 'OK') return { status: 'taken' }; // nx 競合負け

  const idx = await kvLpush(ownerIndexKey(owner), handle);
  if (!idx.ok) {
    // claim を rollback。LPUSH が timeout-after-success だった場合に備え index からも
    // LREM (冪等: 未挿入なら 0 件削除)。stale entry が limit/一覧に残らないようにする。
    await kvDel(key);
    await kvLrem(ownerIndexKey(owner), handle);
    return { status: 'kv_error' };
  }
  return { status: 'created', record };
}

export type ReleaseStatus =
  | 'released'
  | 'not_found'
  | 'forbidden'
  | 'kv_unavailable'
  | 'kv_error';

/** handle を解放 (所有者のみ)。所有者一致を atomic に確認して削除し、index から LREM で除去。 */
export async function releaseHandle(input: {
  handle: string;
  owner: string;
}): Promise<ReleaseStatus> {
  if (!isKvConfigured()) return 'kv_unavailable';
  const { handle, owner } = input;

  // 所有者一致を atomic に確認して削除 (同 owner の二重 DELETE + 別 owner の取り直しが
  // 交錯しても新 owner のレコードを消さない)。1=削除 / 0=owner 不一致 / -1,-2=未存在。
  const cas = await kvEval<number>(CAS_DELETE, [handleKey(handle)], [owner]);
  if (!cas.ok) return 'kv_error';
  if (cas.value === 0) return 'forbidden';
  if (cas.value !== 1) return 'not_found';

  // handle は解放済み。index 除去は LREM (原子)。失敗しても released を返し、stale entry は
  // ログのみ (上限を over-count = 安全側 / 次回 op で自己修復)。
  const rem = await kvLrem(ownerIndexKey(owner), handle);
  if (!rem.ok) {
    logger.warn('handle.release.index_cleanup_failed', { handle });
  }
  return 'released';
}
