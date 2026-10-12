// /guide/mobile-order: 「モバイルオーダーのやり方」お客様向けガイド (5 ステップ + 実機スクショ)。
//
// content SOT は lib/mobileOrderGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/agentGuide.ts / lib/posGuide.ts と同じ。手順画像は public/guide/mobile-order/ の実機
// スクリーンショット (サンプル店舗と同一メニューの実描画)。
//
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/pos・guide/agent と同方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideFaq } from '@/components/guide/GuideFaq';
import { GUIDE_PRIMARY_ACTION, GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { BulletList, Section } from '@/components/guide/PosGuidePieces';
import { StepShot } from '@/components/guide/MobileOrderGuidePieces';
import {
  mobileOrderGuideContentFor,
  mobileOrderGuideMetadata,
} from '@/lib/mobileOrderGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return mobileOrderGuideMetadata(locale);
}

export default async function GuideMobileOrderPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = mobileOrderGuideContentFor(locale);

  return (
    <AppShell>
      <GuideFrame locale={locale} current="mobile-order">
      <article className="mx-auto max-w-3xl">

        <header>
          <GuideTitle>
            {c.title}
          </GuideTitle>
          <GuideSubtitle>
            {c.subtitle}
          </GuideSubtitle>
          <GuideLead>{c.lead}</GuideLead>
                  <GuideActions actions={[{ href: c.tryUrl, label: c.tryCta }]} />
        </header>

        <Section title={c.needTitle}>
          <BulletList items={c.need} marker="✓" markerClassName="text-emerald-600" />
        </Section>

        <Section title={c.stepsTitle}>
          <ol className="mt-6 space-y-10">
            {c.steps.map((step) => (
              <StepShot key={step.n} step={step} />
            ))}
          </ol>
        </Section>

        <Section title={c.faqTitle}>
          <GuideFaq items={c.faq} />
        </Section>

        {/* サンプル店舗 CTA (外部同一オリジンの @handle ページ) */}
        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 data-toc="skip" className="text-lg font-bold text-emerald-900">{c.tryTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.tryBody}
          </p>
          <a
            href={c.tryUrl}
            className={`mt-5 ${GUIDE_PRIMARY_ACTION}`}
          >
            {c.tryCta}
          </a>
        </section>

        <Section title={c.relatedTitle} toc={false}>
          <p className="mt-3 text-sm">
            <Link
              href={`/${locale}/guide/agent`}
              prefetch={false}
              className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
            >
              {c.relatedAgentGuide}
            </Link>
          </p>
        </Section>
      </article>
      </GuideFrame>
    </AppShell>
  );
}
