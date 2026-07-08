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
    <AppShell>
      <article className="mx-auto max-w-3xl">
        <Link
          href={`/${locale}`}
          prefetch={false}
          className="text-sm font-medium text-emerald-700 hover:text-emerald-900"
        >
          {c.backHome}
        </Link>

        <header className="mt-4">
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {c.title}
          </h1>
          <p className="mt-2 text-base font-medium text-emerald-700">
            {c.subtitle}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">{c.lead}</p>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.audience}
          </p>
        </header>

        <GuideHero image={c.heroImage} />

        {/* できること / できないこと */}
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-emerald-200/70">
            <h2 className="text-base font-semibold text-emerald-900">
              {c.canDoTitle}
            </h2>
            <BulletList
              items={c.canDo}
              marker="✓"
              markerClassName="text-emerald-600"
            />
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
            <h2 className="text-base font-semibold text-slate-900">
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

        <Section title={c.overviewTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.overviewBody}
          </p>
        </Section>

        <Section title={c.setupTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.setupIntro}
          </p>
          <StepList
            steps={c.setupSteps}
            badgeClassName="bg-emerald-100 text-emerald-700"
          />
          <CodeBlock label={c.configLabel} code={c.configCode} />
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.configNote}
          </p>
        </Section>

        <Section title={c.flowTitle}>
          <StepList
            steps={c.flowSteps}
            badgeClassName="bg-emerald-600 text-white"
          />
        </Section>

        <Section title={c.jpycTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.jpycBody}
          </p>
          <StepList
            steps={c.jpycSteps}
            badgeClassName="bg-emerald-100 text-emerald-700"
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
          <dl className="mt-4 space-y-5">
            {c.faqs.map((f) => (
              <div key={f.q}>
                <dt className="text-sm font-semibold text-slate-900">{f.q}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-slate-700">
                  {f.a}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        {/* CTA */}
        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 className="text-lg font-bold text-emerald-900">{c.ctaTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.ctaBody}
          </p>
          <Link
            href={`/${locale}${c.ctaButtonHref}`}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
          >
            {c.ctaButton}
          </Link>
        </section>
      </article>
    </AppShell>
  );
}
