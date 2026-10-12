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
import { GuideHubGroups, GuideHubRelated } from '@/components/guide/GuideHubPieces';
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
    <AppShell>
      <article className="mx-auto max-w-3xl">
        <Link
          href={`/${locale}`}
          prefetch={false}
          className="text-sm font-medium text-emerald-700 hover:text-emerald-900"
        >
          {nav.backHome}
        </Link>

        <header className="mt-4">
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
            {nav.hubTitle}
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-700 sm:text-base">
            {nav.hubLead}
          </p>
        </header>

        <GuideHubGroups locale={locale} nav={nav} />
        {/* 末尾にガイド以外の関連ページ (料金)。GUIDE_SLUGS と目次には入れない (plans/pricing-page.md §2.6)。 */}
        <GuideHubRelated locale={locale} nav={nav} />
      </article>
    </AppShell>
  );
}
