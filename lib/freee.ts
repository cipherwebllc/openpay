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
