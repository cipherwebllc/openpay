import createMiddleware from 'next-intl/middleware';
import { DEFAULT_LOCALE, LOCALES } from './i18n';

export default createMiddleware({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  // /ja/* へ強制リダイレクトせず、ブラウザの Accept-Language を見て決める
  localeDetection: true,
  // /pay と /tip は localePrefix=always (URL 上に必ず /ja or /en が出る)
  localePrefix: 'always',
});

export const config = {
  // _next, /api, /manifest.webmanifest, /icon-512.png などの静的・特殊ルートは除外。
  // /og/ は OG 画像の公開 URL (next.config.mjs の rewrite で /api/og/ へ内部転送)。
  // 除外しないと next-intl が /ja/og/… へ locale リダイレクトして画像が 404 になる。
  matcher: ['/((?!_next|api|og/|.*\\..*).*)'],
};
