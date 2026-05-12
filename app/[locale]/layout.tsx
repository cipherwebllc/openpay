import { notFound } from 'next/navigation';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { Analytics } from '@vercel/analytics/next';
import { LOCALES } from '@/i18n';
import { AlphaNotice } from '@/components/AlphaNotice';
import { SiteFooter } from '@/components/SiteFooter';
import { Providers } from '../providers';
import '../globals.css';

// 本番デプロイ後、Vercel ダッシュボード (Web Analytics) で初回 pageview の
// 受信を目視確認すること。コード上の統合は build pass のみで未検証。

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
          <AlphaNotice />
          <Providers>{children}</Providers>
          <SiteFooter />
        </NextIntlClientProvider>
        <Analytics />
      </body>
    </html>
  );
}
