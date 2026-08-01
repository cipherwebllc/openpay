import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE, LOCALES } from './i18n';

const intl = createMiddleware({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  // /ja/* へ強制リダイレクトせず、ブラウザの Accept-Language を見て決める
  localeDetection: true,
  // /pay と /tip は localePrefix=always (URL 上に必ず /ja or /en が出る)
  localePrefix: 'always',
});

export default function middleware(request: NextRequest) {
  // /og/* は OG 画像の公開 URL → /api/og/* へ server rewrite する。
  // 公開 URL を /api/ 配下から出す理由: robots.txt の Disallow: /api/ を前置一致
  // だけで評価する SNS カード検証系が Allow (longest-match) や Twitterbot 専用
  // グループを無視して「restricted」と誤判定するため (2026-08-02 本番実害)。
  // next.config.mjs の rewrites() を使わないのは、rewrites が 1 つでも存在すると
  // client router に rewrite 解決コードが入り全ルートの First Load JS が +3kB
  // 太るため (bundle 予算超過の実測)。middleware は server 専用で client 影響ゼロ。
  const { pathname } = request.nextUrl;
  if (pathname === '/og' || pathname.startsWith('/og/')) {
    const url = request.nextUrl.clone();
    url.pathname = `/api${pathname}`;
    return NextResponse.rewrite(url);
  }
  return intl(request);
}

export const config = {
  // _next, /api, /manifest.webmanifest, /icon-512.png などの静的・特殊ルートは除外。
  // /og/ は除外しない (上の rewrite が動くために middleware を通す必要がある。
  // 誤って除外すると「メタタグは /og/ を指すが画像 404」の静かな全滅になる)。
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
