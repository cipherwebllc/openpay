// Service Worker (public/sw.js) の fetch 介入対象を判定する純関数群。
//
// ⚠️ sw.js は静的配信 (バンドル無し・ES import 不可) のため、同じ規則を public/sw.js 内に
// **ミラー実装** している。この module が「介入してよいパターン」の単一情報源であり、
// tests/lib/offlineSwRoutes.test.ts が narrow 性 (API/POST/クロスオリジン・/pay 等の決済
// 経路には絶対に介入しない) を担保する。ここを変えたら public/sw.js の decideOfflineFetch
// 相当ロジックも必ず揃えること。
//
// 介入は 3 パターンのみ:
//   1. 同一オリジン GET `/_next/static/*` (content-hash 済 immutable) → cache-first
//   2. `mode === 'navigate'` かつ pathname が `/{ja|en}/create` (末尾スラッシュ許容) → network-first
//   3. 2 の失敗時フォールバックとして precache 済 offline.html
// それ以外 (POST / API / クロスオリジン / /pay / /scan / /checkout 等) は passthrough (素通し)。

export const OFFLINE_CREATE_PATH_RE = /^\/(?:ja|en)\/create\/?$/;

/** `/_next/static/*` (Next.js の content-hash 済 immutable アセット) か。 */
export function isStaticAssetPath(pathname: string): boolean {
  return pathname.startsWith('/_next/static/');
}

/** `/ja/create` or `/en/create` (末尾スラッシュ許容) か。localePrefix=always 前提。 */
export function isCreateNavPath(pathname: string): boolean {
  return OFFLINE_CREATE_PATH_RE.test(pathname);
}

export type OfflineFetchDecision = 'static' | 'create-nav' | 'passthrough';

/** fetch イベントを SW が引き取ってよいか (どの戦略か) を判定する。passthrough は
 *  respondWith せず素通し (= ブラウザ既定)。GET・同一オリジン以外は必ず passthrough。 */
export function decideOfflineFetch(input: {
  method: string;
  /** Request.mode ('navigate' / 'cors' / 'same-origin' / 'no-cors' 等)。 */
  mode: string;
  sameOrigin: boolean;
  pathname: string;
}): OfflineFetchDecision {
  if (input.method !== 'GET') return 'passthrough';
  if (!input.sameOrigin) return 'passthrough';
  if (isStaticAssetPath(input.pathname)) return 'static';
  if (input.mode === 'navigate' && isCreateNavPath(input.pathname)) {
    return 'create-nav';
  }
  return 'passthrough';
}
