// freee 連携の per-merchant KV ストア (`_` prefix で route 探索対象外)。
// すべて wallet (SIWE 検証済 checksum アドレス) で名前空間を切る。
//   freee:tok:{wallet}     → encrypted StoredToken envelope (access/refresh/expiresAt/companyId)
//   freee:meta:{wallet}    → { companyId, companyName }
//   freee:map:{wallet}     → FreeeMapping (companyId/accountItemId/taxCode)
//   freee:state:{state}    → OAuth state (JSON {wallet, returnTo}・TTL 10分)
//   freee:synced:{wallet}:{txOrId} → 同期済 deal id (冪等・runFreeeSync が claim/finalize)
import { kvGet, kvSet, kvDel, kvGetDel, kvSetNxGet } from '@/lib/kv';
import {
  decryptStoredToken,
  encryptStoredToken,
  type StoredToken,
} from '@/lib/freee';
import type { FreeeMapping, ClaimState } from '@/lib/freeeSync';

const STATE_TTL_SEC = 600;
const CLAIM_TTL_SEC = 300; // 'pending' claim が createDeal クラッシュで永久残留しない保険

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
    await kvDel(k);
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

/** 連携解除/再連携用に token を破棄 (refresh 失効時に呼び status を not-connected に倒す)。 */
export async function delToken(wallet: string): Promise<void> {
  await kvDel(key('tok', wallet.toLowerCase()));
}

export type FreeeMeta = { companyId: number; companyName: string };

export function getMeta(wallet: string): Promise<FreeeMeta | null> {
  return getJson<FreeeMeta>(key('meta', wallet.toLowerCase()));
}

export async function setMeta(wallet: string, meta: FreeeMeta): Promise<void> {
  await kvSet(key('meta', wallet.toLowerCase()), JSON.stringify(meta));
}

export function getMapping(wallet: string): Promise<FreeeMapping | null> {
  return getJson<FreeeMapping>(key('map', wallet.toLowerCase()));
}

export async function setMapping(wallet: string, mapping: FreeeMapping): Promise<void> {
  await kvSet(key('map', wallet.toLowerCase()), JSON.stringify(mapping));
}

/** 会社(事業所)切替時など、旧会社の ID を指す mapping を無効化する。 */
export async function delMapping(wallet: string): Promise<void> {
  await kvDel(key('map', wallet.toLowerCase()));
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
