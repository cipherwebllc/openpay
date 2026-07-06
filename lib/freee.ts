// freee OAuth2 + 会計 API の薄いサーバ専用クライアント。
//
// secret 衛生: FREEE_CLIENT_SECRET は server 専用 (NEXT_PUBLIC_ にしない・本モジュールは
// route からのみ import)。ログ/レスポンスに secret や token を出さない。
//
// token: access は 6h・refresh は**使うたびローテーション** (新 refresh を必ず再保存しないと
// 次回失効)。getValidAccessToken が期限近接で refresh→persist→新 access を返す。
//
// ⚠️ 未検証 (実プラン freee 実行でのみ確定): 以下の **req/resp 形は freee API ドキュメント想定**で
// あり、unit/統合テストは fetch をモックして「この想定形をパースできるか」を検証しているに過ぎない
// (= 想定が間違っていれば素通りで [] / throw になる)。OAuth(token 交換)は実機で疎通確認済だが、
// 会計 API は未到達:
//   - getCompanies の `companies[].display_name`、getAccountItems の `account_items[]`
//   - getTaxCodes は `/taxes/codes` (全マスタ)。事業所別 `/taxes/companies/{id}` が正しい可能性あり
//   - createDeal の `{deal:{id}}` レスポンス形・`type:'income'` payload
// プラン有効な freee で実取込検証するまで、これらは「動くはず」止まり (memory:freee-oauth-siwe-entitlement)。

// P2-P: server 専用モジュール (FREEE_CLIENT_SECRET / FREEE_TOKEN_ENC_KEY を扱う)。'use client' から
// 誤って import されると build で気づけるよう、他の secret モジュール (lib/push/server 等) と同様に
// server-only で閉じる。
import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { FreeeDealBody } from './freeeSync';

const AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const API_BASE = 'https://api.freee.co.jp/api/1';

export type FreeeEnv = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** server env が揃っていれば返す。未設定 (どれか欠落) は null → route は 503 freee_not_configured。 */
export function freeeEnv(): FreeeEnv | null {
  const clientId = process.env.FREEE_CLIENT_ID;
  const clientSecret = process.env.FREEE_CLIENT_SECRET;
  const redirectUri = process.env.FREEE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/** KV `freee:tok:{wallet}` に保存する token レコード。 */
export type StoredToken = {
  access: string;
  refresh: string;
  expiresAt: number; // ms epoch
  companyId: number | null;
};

export type FreeeTokenEnvelope = {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  tag: string;
  ct: string;
};

function freeeTokenEncryptionKey(): Buffer {
  const raw = process.env.FREEE_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      'FREEE_TOKEN_ENC_KEY missing: set a 32-byte hex or base64 key for freee token encryption',
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'FREEE_TOKEN_ENC_KEY invalid: must decode to exactly 32 bytes (64-char hex or base64)',
    );
  }
  return key;
}

function tokenAad(walletLower: string): Buffer {
  return Buffer.from(`freee:tok:${walletLower}:v1`, 'utf8');
}

function isTokenEnvelope(value: unknown): value is FreeeTokenEnvelope {
  const o = value as Partial<FreeeTokenEnvelope>;
  return (
    !!o &&
    o.v === 1 &&
    o.alg === 'A256GCM' &&
    typeof o.iv === 'string' &&
    typeof o.tag === 'string' &&
    typeof o.ct === 'string'
  );
}

function parseStoredToken(value: string): StoredToken | null {
  try {
    const o = JSON.parse(value) as Partial<StoredToken>;
    if (
      typeof o.access === 'string' &&
      typeof o.refresh === 'string' &&
      typeof o.expiresAt === 'number' &&
      Number.isFinite(o.expiresAt) &&
      (typeof o.companyId === 'number' || o.companyId === null)
    ) {
      return {
        access: o.access,
        refresh: o.refresh,
        expiresAt: o.expiresAt,
        companyId: o.companyId,
      };
    }
  } catch {
    /* unusable token */
  }
  return null;
}

export function encryptStoredToken(wallet: string, token: StoredToken): string {
  const walletLower = wallet.toLowerCase();
  const key = freeeTokenEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(tokenAad(walletLower));
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(token), 'utf8'),
    cipher.final(),
  ]);
  const envelope: FreeeTokenEnvelope = {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(envelope);
}

export function decryptStoredToken(wallet: string, value: string): StoredToken | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isTokenEnvelope(envelope)) return null;

  const key = freeeTokenEncryptionKey();
  try {
    const walletLower = wallet.toLowerCase();
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ct = Buffer.from(envelope.ct, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(tokenAad(walletLower));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    return parseStoredToken(plaintext);
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(env: FreeeEnv, state: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.clientId);
  u.searchParams.set('redirect_uri', env.redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'select_company');
  return u.toString();
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  company_id?: number;
};

async function requestToken(
  env: FreeeEnv,
  params: Record<string, string>,
  nowMs: number,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    client_id: env.clientId,
    client_secret: env.clientSecret,
    ...params,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`freee_token_http_${res.status}`);
  }
  const json = (await res.json()) as TokenResponse;
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: nowMs + json.expires_in * 1000,
    companyId: typeof json.company_id === 'number' ? json.company_id : null,
  };
}

export function exchangeCode(
  env: FreeeEnv,
  code: string,
  nowMs: number = Date.now(),
): Promise<StoredToken> {
  return requestToken(
    env,
    { grant_type: 'authorization_code', code, redirect_uri: env.redirectUri },
    nowMs,
  );
}

export function refreshAccessToken(
  env: FreeeEnv,
  refresh: string,
  nowMs: number = Date.now(),
): Promise<StoredToken> {
  return requestToken(
    env,
    { grant_type: 'refresh_token', refresh_token: refresh },
    nowMs,
  );
}

/** 期限まで skew (既定 60s) を切っていれば refresh が必要。 */
export function tokenNeedsRefresh(
  stored: StoredToken,
  nowMs: number,
  skewMs = 60_000,
): boolean {
  return stored.expiresAt - nowMs <= skewMs;
}

/**
 * 有効な access token を返す。期限近接なら refresh して **新 token を persist** (rotation を
 * 取りこぼさない)。companyId は refresh 応答に無ければ既存値を引き継ぐ。
 */
export async function getValidAccessToken(
  env: FreeeEnv,
  stored: StoredToken,
  persist: (next: StoredToken) => Promise<void>,
  nowMs: number = Date.now(),
): Promise<string> {
  if (!tokenNeedsRefresh(stored, nowMs)) return stored.access;
  const refreshed = await refreshAccessToken(env, stored.refresh, nowMs);
  const next: StoredToken = {
    ...refreshed,
    companyId: refreshed.companyId ?? stored.companyId,
  };
  await persist(next);
  return next.access;
}

async function freeeApi<T>(
  path: string,
  access: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${access}`,
      Accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`freee_api_http_${res.status}`);
  }
  return (await res.json()) as T;
}

export type FreeeCompany = { id: number; name: string };
export type FreeeAccountItem = { id: number; name: string };
export type FreeeTaxCode = { code: number; name: string };

export async function getCompanies(access: string): Promise<FreeeCompany[]> {
  const json = await freeeApi<{ companies?: Array<{ id: number; display_name?: string; name?: string }> }>(
    '/companies',
    access,
  );
  return (json.companies ?? []).map((c) => ({
    id: c.id,
    name: c.display_name ?? c.name ?? String(c.id),
  }));
}

export async function getAccountItems(
  access: string,
  companyId: number,
): Promise<FreeeAccountItem[]> {
  const json = await freeeApi<{ account_items?: Array<{ id: number; name: string }> }>(
    `/account_items?company_id=${companyId}`,
    access,
  );
  return (json.account_items ?? []).map((a) => ({ id: a.id, name: a.name }));
}

export async function getTaxCodes(access: string): Promise<FreeeTaxCode[]> {
  const json = await freeeApi<{ taxes?: Array<{ code: number; name: string }> }>(
    '/taxes/codes',
    access,
  );
  return (json.taxes ?? []).map((t) => ({ code: t.code, name: t.name }));
}

/** 取引(収入) を作成し deal id を返す。 */
export async function createDeal(
  access: string,
  body: FreeeDealBody,
): Promise<number> {
  const json = await freeeApi<{ deal?: { id: number } }>('/deals', access, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!json.deal || typeof json.deal.id !== 'number') {
    throw new Error('freee_deal_no_id');
  }
  return json.deal.id;
}
