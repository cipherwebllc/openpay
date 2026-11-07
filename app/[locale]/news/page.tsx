// /news: 運営からの一斉告知 (お知らせ)。AppShell + NewsList。
// explore/page.tsx と同型 (generateMetadata + setRequestLocale)。
// ログイン不要・全ユーザー対象・コンテンツは lib/news.ts のコード内配列。本文は server で newsEntriesFor(locale) に絞って
// NewsList (client) へ渡す (全件の ja/en の本文を /news の JS に入れない・lib/news.ts の newsEntriesFor の注)。

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { NewsList } from '@/components/NewsList';
import { newsEntriesFor } from '@/lib/news';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('News');
  return {
    title: `${t('pageTitle')} · OpenPay`,
    description: t('pageDescription'),
  };
}

export default async function NewsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('News');

  return (
    <AppShell>
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('pageTitle')}
        </h1>
        <p className="mt-2 text-sm text-slate-600">{t('pageDescription')}</p>
      </header>
      <NewsList items={newsEntriesFor(locale === 'en' ? 'en' : 'ja')} />
    </AppShell>
  );
}
