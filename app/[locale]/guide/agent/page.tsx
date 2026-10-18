// /guide/agent: 「AI で注文するガイド」訪日客・早期利用者向け。
//
// content SOT は lib/agentGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/posGuide.ts / lib/explore.ts と同じ。描画は PosGuidePieces (Section/BulletList/StepList) の
// 再利用 + AgentGuidePieces (CodeBlock/AddressCallout) の最小追加。図版 SVG は使わない (この面の
// 視覚要素は設定 JSON とコントラクトアドレスで、コードブロック/モノスペースが正しい)。
//
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/pos・explore と同方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideFaq } from '@/components/guide/GuideFaq';
import { GuideDisclosure } from '@/components/guide/GuideDisclosure';
import { guideNavFor } from '@/lib/guideNav';
import { GUIDE_PRIMARY_ACTION, GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideToc } from '@/components/guide/GuideToc';
import {
  BulletList,
  Section,
  StepList,
} from '@/components/guide/PosGuidePieces';
import {
  AddressCallout,
  CodeBlock,
  GuideHero,
} from '@/components/guide/AgentGuidePieces';
import { agentGuideContentFor, guideAgentMetadata } from '@/lib/agentGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return guideAgentMetadata(locale);
}

export default async function GuideAgentPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = agentGuideContentFor(locale);

  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="agent">
      <article className="mx-auto max-w-3xl">
        <Link
          href={`/${locale}${c.backLink.href}`}
          prefetch={false}
          className="inline-flex min-h-11 items-center text-xs font-medium text-slate-500 hover:text-slate-900"
        >
          {c.backLink.label}
        </Link>

        <header className="mt-2">
          <GuideTitle>{guideNavFor(locale).items['agent'].label}</GuideTitle>
          <GuideSubtitle>{c.title}</GuideSubtitle>
          <GuideLead>{c.lead}</GuideLead>
                  <GuideActions actions={[{ href: `/${locale}${c.ctaButtonHref}`, label: c.ctaButton }]} />
        </header>

        <GuideToc title={guideNavFor(locale).tocTitle} />

        <GuideHero image={c.heroImage} />

        {/* できること / できないこと */}
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-emerald-200/70">
            <h2 data-toc="skip" className="text-base font-semibold text-emerald-900">
              {c.canDoTitle}
            </h2>
            <BulletList
              items={c.canDo}
              marker="✓"
              markerClassName="text-emerald-600"
            />
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
            <h2 data-toc="skip" className="text-base font-semibold text-slate-900">
              {c.cannotTitle}
            </h2>
            <BulletList
              items={c.cannot}
              marker="•"
              markerClassName="text-slate-400"
            />
          </section>
        </div>

        <Section title={c.needTitle}>
          <BulletList
            items={c.need}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        <Section title={c.setupTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.setupIntro}
          </p>
          <StepList
            steps={c.setupSteps}
          />
          <GuideDisclosure variant="subtle" summary={c.setupEnvironmentNote.title}>
            <BulletList items={c.setupEnvironmentNote.items} marker="•" markerClassName="text-slate-400" />
          </GuideDisclosure>
          <CodeBlock label={c.configLabel} code={c.configCode} />
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.configNote}
          </p>
        </Section>

        <Section title={c.flowTitle}>
          <StepList
            steps={c.flowSteps}
          />
        </Section>

        <Section title={c.jpycTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.jpycBody}
          </p>
          <StepList
            steps={c.jpycSteps}
          />
          <AddressCallout
            label={c.jpycAddressLabel}
            address={c.jpycAddress}
            chainNote={c.jpycAddressChainNote}
            legacyWarning={c.jpycLegacyWarning}
          />
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.jpycGasNote}
          </p>
          <GuideDisclosure variant="subtle" summary={c.jpycNoGasLabel}>
            <p className="text-sm leading-relaxed">{c.jpycNoGasNote}</p>
          </GuideDisclosure>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {c.jpycLiquidityNote}
          </p>
        </Section>

        {/* 重要なお知らせ (交換業回避・投資助言でない・公式確認) — 目立たせる */}
        <Section title={c.disclosuresTitle}>
          <div className="mt-3 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
            <BulletList
              items={c.disclosures}
              marker="•"
              markerClassName="text-amber-700"
            />
          </div>
        </Section>

        <Section title={c.safetyTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.safetyBody}
          </p>
          <BulletList
            items={c.safety}
            marker="•"
            markerClassName="text-emerald-600"
          />
          <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900 ring-1 ring-amber-200">
            {c.safetyNote}
          </p>
        </Section>

        <Section title={c.faqTitle}>
          <GuideFaq items={c.faqs} />
        </Section>

        {/* CTA */}
        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 data-toc="skip" className="text-lg font-bold text-emerald-900">{c.ctaTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.ctaBody}
          </p>
          <Link
            href={`/${locale}${c.ctaButtonHref}`}
            className={`mt-5 ${GUIDE_PRIMARY_ACTION}`}
          >
            {c.ctaButton}
          </Link>
        </section>
      </article>
      </GuideFrame>
    </AppShell>
  );
}
