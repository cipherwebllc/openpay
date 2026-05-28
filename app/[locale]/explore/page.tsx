// /explore: ステーブルコイン (JPYC / USDC) が使える外部サービスへのポータル。
// AppShell + ExploreList (5 カテゴリ × n エントリ)。
//
// noindex は意図的に設定しない (外部リンクの directory として SEO 価値あり)。

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { ExploreList } from '@/components/ExploreList';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Explore');
  return {
    title: `${t('pageTitle')} · OpenPay`,
    description: t('pageDescription'),
  };
}

export default async function ExplorePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Explore');

  return (
    <AppShell>
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('pageTitle')}
        </h1>
        <p className="mt-2 text-sm text-slate-600">{t('pageDescription')}</p>
      </header>
      <ExploreList />
    </AppShell>
  );
}
