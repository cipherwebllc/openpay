// freee 連携の per-merchant KV ストア (`_` prefix で route 探索対象外)。
// すべて wallet (SIWE 検証済 checksum アドレス) で名前空間を切る。
//   freee:tok:{wallet}     → encrypted StoredToken envelope (access/refresh/expiresAt/companyId)
//   freee:refresh:{wallet} → refresh lease owner (TTL 30秒)
//   freee:meta:{wallet}    → { companyId, companyName }
//   freee:map:{wallet}     → FreeeMapping (companyId/accountItemId/taxCode)
//   freee:state:{state}    → OAuth state (JSON {wallet, returnTo}・TTL 10分)
//   freee:synced:{wallet}:{txOrId} → 同期済 deal id (冪等・runFreeeSync が claim/finalize)
import { randomUUID } from 'node:crypto';
import { kvGet, kvSet, kvDel, kvGetDel, kvSetNxGet, kvEval } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  decryptStoredToken,
  encryptStoredToken,
  getValidAccessToken,
  tokenNeedsRefresh,
  type FreeeEnv,
  type StoredToken,
} from '@/lib/freee';
import type { FreeeMapping, ClaimState } from '@/lib/freeeSync';

const STATE_TTL_SEC = 600;
const CLAIM_TTL_SEC = 300; // 'pending' claim が createDeal クラッシュで永久残留しない保険
const REFRESH_LOCK_TTL_SEC = 30; // 10s の HTTP deadline より長く、停止した worker のロックは解放する。

// 暗号文の snapshot と (refresh 時は) lock 所有者を同時に検証する。
// 遅れた refresh / 失効処理 / 壊れたレコードの掃除で、新しい連携を上書き・削除しない。
const TOKEN_CAS_SCRIPT = `
if #KEYS > 1 and redis.call('GET', KEYS[2]) ~= ARGV[3] then return 0 end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[2])
end
return 1
`;

function key(ns: string, id: string): string {
  return `freee:${ns}:${id}`;
}

async function getJson<T>(k: string): Promise<T | null> {
  const res = await kvGet(k);
  if (!res.ok || !res.value) return null;
  try {
    return JSON.parse(res.value) as T;
  } catch {
    return null;
  }
}

export async function getToken(wallet: string): Promise<StoredToken | null> {
  const walletLower = wallet.toLowerCase();
  const k = key('tok', walletLower);
  const res = await kvGet(k);
  if (!res.ok || !res.value) return null;
  const token = decryptStoredToken(walletLower, res.value);
  if (!token) {
    await kvEval(TOKEN_CAS_SCRIPT, [k], [res.value, '']);
    return null;
  }
  return token;
}

export async function setToken(wallet: string, token: StoredToken): Promise<void> {
  // 永続化失敗を飲み込むと、refresh ローテーションで新 refresh token を保存し損ねて
  // 次回失効=連携断になる。失敗は throw して caller (502 / errorRedirect) に伝える。
  const walletLower = wallet.toLowerCase();
  const res = await kvSet(key('tok', walletLower), encryptStoredToken(walletLower, token));
  if (!res.ok) throw new Error(`freee_token_persist_failed:${res.reason}`);
}

/** Refresh は wallet 単位の lease 内で再読取し、更新・失効とも CAS で確定する。 */
export async function getWalletAccessToken(
  env: FreeeEnv,
  wallet: string,
  expected: StoredToken,
): Promise<string> {
  if (!tokenNeedsRefresh(expected, Date.now())) return expected.access;
  const walletLower = wallet.toLowerCase();
  const tokenKey = key('tok', walletLower);
  const lockKey = key('refresh', walletLower);
  const lockId = randomUUID();
  const lock = await kvSet(lockKey, lockId, { nx: true, ttlSec: REFRESH_LOCK_TTL_SEC });
  if (!lock.ok) throw new Error('freee_token_lock_failed');
  // 並行リクエストで同じ refresh token を消費しない。busy は既存の 502 経路で再試行可能。
  if (lock.value === null) throw new Error('freee_token_refresh_busy');
  try {
    const snapshot = await kvGet(tokenKey);
    if (!snapshot.ok) throw new Error('freee_token_read_failed');
    const current = snapshot.value && decryptStoredToken(walletLower, snapshot.value);
    // 再連携で会社が変わった場合、旧 mapping を新しい access token で実行させない。
    if (!current || current.companyId !== expected.companyId) throw new Error('freee_token_changed');
    const replace = async (next: string) => {
      const result = await kvEval<number>(TOKEN_CAS_SCRIPT, [tokenKey, lockKey], [snapshot.value!, next, lockId]);
      if (!result.ok) throw new Error('freee_token_persist_failed');
      if (result.value !== 1) throw new Error('freee_token_changed');
    };
    try {
      return await getValidAccessToken(env, current, (next) => replace(encryptStoredToken(walletLower, next)));
    } catch (error) {
      // 既存の token endpoint 4xx による再連携導線を維持する。
      // 通信障害・保存失敗は連携解除へ波及させない。
      if (error instanceof Error && /^freee_token_http_4\d\d$/.test(error.message)) await replace('');
      throw error;
    }
  } finally {
    const released = await kvEval(TOKEN_CAS_SCRIPT, [lockKey], [lockId, '']);
    // 後始末の KV 障害で、保存済みの rotation を失敗扱いにしない。lease は TTL で切れる。
    if (!released.ok) logger.warn('freee.token_lock_release_failed', { reason: released.reason });
  }
}

export type FreeeMeta = { companyId: number; companyName: string };

export function getMeta(wallet: string): Promise<FreeeMeta | null> {
  return getJson<FreeeMeta>(key('meta', wallet.toLowerCase()));
}

export async function setMeta(wallet: string, meta: FreeeMeta): Promise<void> {
  const res = await kvSet(key('meta', wallet.toLowerCase()), JSON.stringify(meta));
  if (!res.ok) throw new Error(`freee_meta_persist_failed:${res.reason}`);
}

export function getMapping(wallet: string): Promise<FreeeMapping | null> {
  return getJson<FreeeMapping>(key('map', wallet.toLowerCase()));
}

export async function setMapping(
  wallet: string,
  mapping: FreeeMapping,
): Promise<boolean> {
  const res = await kvSet(key('map', wallet.toLowerCase()), JSON.stringify(mapping));
  return res.ok && res.value === 'OK';
}

/** 会社(事業所)切替時など、旧会社の ID を指す mapping を無効化する。 */
export async function delMapping(wallet: string): Promise<boolean> {
  const res = await kvDel(key('map', wallet.toLowerCase()));
  // value=0 は既に mapping が無い正常系。削除コマンドが成功したことだけを要求する。
  return res.ok;
}

export async function setState(
  state: string,
  value: { wallet: string; returnTo: string },
): Promise<boolean> {
  const res = await kvSet(key('state', state), JSON.stringify(value), {
    nx: true,
    ttlSec: STATE_TTL_SEC,
  });
  return res.ok && res.value === 'OK';
}

/** state を atomic に消費 (1 回限り)。GETDEL で取得と削除を一括し、並行 callback での
 *  二重消費 (TOCTOU) を防ぐ。 */
export async function consumeState(
  state: string,
): Promise<{ wallet: string; returnTo: string } | null> {
  const res = await kvGetDel(key('state', state));
  if (!res.ok || !res.value) return null;
  try {
    return JSON.parse(res.value) as { wallet: string; returnTo: string };
  } catch {
    return null;
  }
}

// --- runFreeeSync 用の冪等 claim/finalize/release (SET NX GET + TTL pending) ---

// SET NX GET で原子化 (昇格 race 根絶): NX 失敗と GET の間に finalizeSync が
// 'pending'→dealId へ昇格すると done を in-flight と誤判定する race があった。
// SET key value EX ttl NX GET は成功(キー新設)なら null、既存なら旧値を 1 round-trip で返す。
export async function claimSync(syncKey: string): Promise<ClaimState> {
  const res = await kvSetNxGet(syncKey, 'pending', CLAIM_TTL_SEC);
  if (!res.ok) return { kind: 'in-flight' }; // KV 失敗は従来どおり安全側 (skip)
  if (res.value === null) return { kind: 'fresh' };
  if (res.value === 'pending') return { kind: 'in-flight' };
  const dealId = Number(res.value);
  return Number.isFinite(dealId) ? { kind: 'done', dealId } : { kind: 'in-flight' };
}

/** 同期成功を確定 (dealId を TTL 無しで恒久保存)。**書込成功時のみ true**。
 *  false の場合 caller は synced 扱いにしてはならない (claim は pending TTL のまま残し、
 *  TTL 内の二重 createDeal を防ぐ + 結果を error として露出する)。 */
export async function finalizeSync(syncKey: string, dealId: number): Promise<boolean> {
  const res = await kvSet(syncKey, String(dealId));
  return res.ok && res.value === 'OK';
}

export async function releaseSync(syncKey: string): Promise<void> {
  await kvDel(syncKey);
}
