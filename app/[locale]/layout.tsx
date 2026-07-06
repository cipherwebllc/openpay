import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
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

// SEO/AIEO: <title>/<meta description>/OG を locale 別に上書き (root layout は
// non-locale 経路のフォールバック)。文言は messages Meta namespace が単一情報源。
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'Meta' });
  const title = t('title');
  const description = t('description');
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      locale: locale === 'ja' ? 'ja_JP' : 'en_US',
      alternateLocale: locale === 'ja' ? ['en_US'] : ['ja_JP'],
      images: [
        { url: '/og-image.png', width: 1200, height: 630, alt: t('ogImageAlt') },
      ],
    },
    twitter: { card: 'summary_large_image', title, description },
    // alternates(canonical/hreflang) は layout に置くと全下層ページへ継承され
    // 「全ページの canonical=/ja」になる事故を招くため、ここでは設定しない。
  };
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
        <SpeedInsights />
      </body>
    </html>
  );
}
