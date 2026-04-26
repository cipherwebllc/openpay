// next-intl が SSR で messages を読み込むエントリ。next.config.mjs の
// createNextIntlPlugin('./i18n/request.ts') で参照される。
import { notFound } from 'next/navigation';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, isLocale } from '../i18n';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = requested && isLocale(requested) ? requested : DEFAULT_LOCALE;
  if (!isLocale(locale)) notFound();

  const messages = (await import(`../messages/${locale}.json`)).default;
  return { locale, messages };
});
