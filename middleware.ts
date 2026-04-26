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
  // _next, /api, /manifest.webmanifest, /icon.svg などの静的・特殊ルートは除外
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
