import { notFound } from 'next/navigation';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { Analytics } from '@vercel/analytics/next';
import { LOCALES } from '@/i18n';
import { Providers } from '../providers';
import '../globals.css';

// <Analytics /> の build-time 統合は確認済 (typecheck/build 通過) だが、
// **実 pageview が Vercel ダッシュボードに記録されるかは未検証**。
// 本番デプロイ後に Vercel Analytics ダッシュボードで初回イベント受信を
// 目視確認すること (Vercel 側で Web Analytics が enabled である前提)。

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  // Static rendering を有効にする (next-intl v4)
  setRequestLocale(locale);

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
        <Analytics />
      </body>
    </html>
  );
}
