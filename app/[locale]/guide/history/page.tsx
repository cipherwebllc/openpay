// /guide/history:「取引履歴と会計 CSV」お店向けガイド (履歴に売上が出る払い方・出ない入金・会計 CSV・保存の注意)。
//
// content SOT は lib/historyGuide.ts (ja/en 同梱)。履歴の上限の件数は content が HISTORY_MAX_ENTRIES から描く。
// /history の「履歴に出ない入金もあります」の 1 行 (components/HistoryView.tsx) と、決済QR・お店のガイドの「売上履歴」から
// ここへ来る。料率・利用料は扱わない。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideToc } from '@/components/guide/GuideToc';
import { BulletList, Section } from '@/components/guide/PosGuidePieces';
import { guideNavFor } from '@/lib/guideNav';
import { historyGuideContentFor, historyGuideMetadata } from '@/lib/historyGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return historyGuideMetadata(locale);
}

export default async function GuideHistoryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = historyGuideContentFor(locale);
  const nav = guideNavFor(locale);
  const historyHref = `/${locale}/history`;

  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="history">
        <article className="mx-auto max-w-3xl">
          <header>
            <GuideTitle>{nav.items.history.label}</GuideTitle>
            <GuideSubtitle>{c.subtitle}</GuideSubtitle>
            <GuideLead>{c.lead}</GuideLead>
            <GuideActions actions={[{ href: historyHref, label: c.ctaOpen }]} />
          </header>

          <GuideToc title={nav.tocTitle} />

          <Section title={c.inHistoryTitle}>
            <BulletList items={c.inHistory} marker="✓" />
          </Section>

          <Section title={c.notInHistoryTitle}>
            <BulletList items={c.notInHistory} marker="•" />
            <p className="mt-4 text-sm leading-relaxed text-slate-700">{c.notInHistoryCheck}</p>
          </Section>

          <Section title={c.csvTitle}>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.csvBody}</p>
          </Section>

          <Section title={c.storageTitle}>
            <GuideCallout kind="warn">
              <p>{c.storageBody}</p>
            </GuideCallout>
          </Section>

          <GuideCta title={c.ctaTitle} action={{ href: historyHref, label: c.ctaOpen }} />

          <GuideRelated locale={locale} current="history" links={['qr', 'shop', 'start']} />
        </article>
      </GuideFrame>
    </AppShell>
  );
}
