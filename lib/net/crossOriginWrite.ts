import 'server-only';

// SIWE の cookie (SameSite=Lax) で認証する書き込み API の共通 CSRF 検査。
// Lax は別 site からの POST には cookie を付けないが、same-site (サブドメイン) からの POST には付ける。
// CORS ヘッダを出さないので、別 origin の DELETE/PATCH/PUT と application/json の POST は preflight で
// 止まる。残る穴 = same-site からの simple request (form / text/plain の fetch) を、ここで handler の先頭で断つ。
// cookie を使わない route (署名・支払い・Bearer で認証する route、無認証の公開の書き込み) には付けない。
import { NextResponse } from 'next/server';

export type CrossOriginWriteOptions = {
  /** 本文を JSON として読む route は true (Content-Type: application/json 必須・違えば 415)。本文を読まない route は false。 */
  json: boolean;
  /** json: true でも Content-Type ヘッダ自体が無い bodyless POST は通す (SIWE nonce/logout の既存 SDK・旧タブ互換)。 */
  allowMissingContentType?: boolean;
};

/**
 * 同一 origin からの書き込みかを判定する。
 * 1. Sec-Fetch-Site があれば same-origin だけを通す (same-site のサブドメイン・cross-site・none は拒否)。
 * 2. Sec-Fetch-Site が無い旧ブラウザは Origin を見る。あれば request URL の origin と完全一致が必要 ("null" も拒否)。
 * 3. どちらも無いのはブラウザ以外の client (SDK・curl・server 間)。cookie を自動では付けないので通す。
 * Sec-Fetch-Site を優先するのは、送り手の Referrer-Policy が no-referrer だと same-origin の POST でも
 * Origin が "null" になり、正規の操作まで止めてしまうため。
 */
export function isSameOriginWrite(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';
  const origin = req.headers.get('origin');
  if (origin !== null) return origin === new URL(req.url).origin;
  return true;
}

function rejected(error: string, status: number): NextResponse {
  // 拒否応答は利用者ごとの cookie に依存しうるので共有キャッシュに載せない。
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/**
 * 別 origin 発の書き込みが被害者の cookie で店・受取先・通知購読・セッションを書き換えるのを防ぐ。
 * 拒否なら 403 cross_site_request / 415 unsupported_media_type の NextResponse、通すなら null。
 * caller は handler の先頭 (flag OFF の 404 があればその直後・cookie と本文を読む前) で
 * `const csrf = rejectCrossOriginWrite(req, { json: true }); if (csrf) return csrf;` と使う。
 */
export function rejectCrossOriginWrite(
  req: Request,
  { json, allowMissingContentType = false }: CrossOriginWriteOptions,
): NextResponse | null {
  if (!isSameOriginWrite(req)) return rejected('cross_site_request', 403);
  if (!json) return null;
  const contentType = req.headers.get('content-type');
  // フォーム POST は Content-Type を必ず持つ。ヘッダごと無い bodyless POST だけを互換で通す。
  if (contentType === null && allowMissingContentType) return null;
  // text/plain 等の simple request で JSON の本文を通さない (preflight を経ない経路を JSON route から外す)。
  if (contentType?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return rejected('unsupported_media_type', 415);
  }
  return null;
}
