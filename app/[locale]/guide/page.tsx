// /guide: 「OpenPay でできること」のハブ (plans/guide-hub-sidebar.md §2.5)。
//
// content SOT は lib/guideNav.ts (ja/en 同梱・各ガイドの目次と同じ文言)。ハブには目次を出さない
// (ハブそのものが目次の展開形で、同じ 10 リンクを二重に並べないため)。
// SEO 価値がある入口なので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideHubPanels } from '@/components/guide/GuideHubPieces';
import { GuideLead, GuideTitle } from '@/components/guide/GuideHeader';
import { guideHubMetadata, guideNavFor } from '@/lib/guideNav';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return guideHubMetadata(locale);
}

export default async function GuideHubPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const nav = guideNavFor(locale);

  return (
    <AppShell wide>
      <article className="mx-auto max-w-4xl">
        <Link
          href={`/${locale}`}
          prefetch={false}
          className="text-sm font-medium text-emerald-700 hover:text-emerald-900"
        >
          {nav.backHome}
        </Link>

        <header className="mt-4">
          <GuideTitle>{nav.hubTitle}</GuideTitle>
          <GuideLead>{nav.hubLead}</GuideLead>
        </header>

        {/* グループごとのパネル。お店向けの頭に「はじめての方へ」(読む順の番号)・最後に関連ページ (料金)。 */}
        <GuideHubPanels locale={locale} nav={nav} />
      </article>
    </AppShell>
  );
}
