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
import { GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideCta } from '@/components/guide/GuideEnd';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideToc } from '@/components/guide/GuideToc';
import {
  BulletList,
  Section,
  STEP_BADGE_CUSTOMER,
  guideHeadingId,
  StepList,
} from '@/components/guide/PosGuidePieces';
import {
  AddressCallout,
  CodeBlock,
  GuideHero,
} from '@/components/guide/AgentGuidePieces';
import { agentGuideContentFor, guideAgentMetadata } from '@/lib/agentGuide';
import { GuideMoreLink } from '@/components/guide/GuideLink';

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
        <header>
          <GuideTitle>{guideNavFor(locale).items['agent'].label}</GuideTitle>
          <GuideSubtitle>{c.title}</GuideSubtitle>
          <GuideLead>{c.lead}</GuideLead>
          {/* 行き先は OpenPay Agent (「人が支払う」の設定を作るページ)。AI ストア (/discovery) はデータ・API の一覧で、
              お店の注文とは別 (2026-10-19 user)。 */}
          <GuideActions actions={[{ href: `/${locale}${c.ctaButtonHref}`, label: c.ctaButton }]} />
        </header>

        <GuideToc title={guideNavFor(locale).tocTitle} />

        {/* できること / できないこと */}
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-emerald-200/70">
            <h2 data-toc="skip" className="text-base font-semibold text-emerald-900">
              {c.canDoTitle}
            </h2>
            <BulletList
              items={c.canDo}
              marker="✓"
            />
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
            <h2 data-toc="skip" className="text-base font-semibold text-slate-900">
              {c.cannotTitle}
            </h2>
            <BulletList
              items={c.cannot}
              marker="•"
            />
          </section>
        </div>

        <Section title={c.needTitle}>
          <BulletList
            items={c.need}
            marker="✓"
          />
          {/* JPYC の入手方法は同じページの節へ飛ぶリンクにする (長いページで「下記」を探させない・P8)。 */}
          <p className="mt-3">
            <GuideMoreLink href={`#${guideHeadingId(c.jpycTitle)}`}>{c.jpycTitle}</GuideMoreLink>
          </p>
        </Section>

        <Section title={c.setupTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.setupIntro}
          </p>
          <StepList steps={c.setupSteps} badgeClassName={STEP_BADGE_CUSTOMER} />
          <GuideDisclosure variant="subtle" summary={c.setupEnvironmentNote.title}>
            <BulletList items={c.setupEnvironmentNote.items} marker="•" />
          </GuideDisclosure>
          <CodeBlock label={c.configLabel} code={c.configCode} />
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.configNote}
          </p>
        </Section>

        {/* AI との会話 → 注文ページ → 支払いの 3 画面は、ページの頭ではなく注文の流れの図にする (頭を軽く・P8)。 */}
        <Section title={c.flowTitle}>
          <StepList steps={c.flowSteps} badgeClassName={STEP_BADGE_CUSTOMER} />
          <GuideHero image={c.heroImage} />
        </Section>

        <Section title={c.jpycTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.jpycBody}
          </p>
          <StepList steps={c.jpycSteps} badgeClassName={STEP_BADGE_CUSTOMER} />
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
          <GuideCallout kind="warn">
            <ul className="list-disc space-y-1 pl-4 marker:text-amber-500">
              {c.disclosures.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </GuideCallout>
        </Section>

        <Section title={c.safetyTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.safetyBody}
          </p>
          <BulletList
            items={c.safety}
            marker="•"
          />
          <GuideCallout kind="warn">{c.safetyNote}</GuideCallout>
        </Section>

        <Section title={c.faqTitle}>
          <GuideFaq items={c.faqs} />
        </Section>

        {/* CTA */}
        <GuideCta title={c.ctaTitle} action={{ href: `/${locale}${c.ctaButtonHref}`, label: c.ctaButton }}>
          <p>{c.ctaBody}</p>
        </GuideCta>
      </article>
      </GuideFrame>
    </AppShell>
  );
}
