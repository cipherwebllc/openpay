// /guide/sell: 既存 API / AI エージェントを x402 で販売する出品者向けガイド兼ケーススタディ。
//
// content SOT は lib/sellGuide.ts (ja/en 同梱)。描画は PosGuidePieces の Section/BulletList/StepList と
// AgentGuidePieces の CodeBlock を再利用し、この面固有の component は作らない。
// SEO 集客コンテンツなので noindex は設定しない。
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
import { CodeBlock } from '@/components/guide/AgentGuidePieces';
import { guideSellMetadata, sellGuideContentFor } from '@/lib/sellGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return guideSellMetadata(locale);
}

export default async function GuideSellPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = sellGuideContentFor(locale);

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
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.subtitle}
          </p>
        </header>

        <Section title={c.proofTitle}>
          <div className="mt-4 rounded-2xl bg-white p-5 shadow-card ring-1 ring-emerald-200/70">
            <p className="text-sm leading-relaxed text-slate-700">
              {c.proofIntro}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              {c.proofFlow}{' '}
              <a
                href={c.proofTransaction.href}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all font-mono font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
              >
                {c.proofTransaction.label}
              </a>
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              {c.proofOutcome}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              {c.proofArticleLead}{' '}
              <a
                href={c.proofArticle.href}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
              >
                {c.proofArticle.label}
              </a>
            </p>
          </div>
        </Section>

        <Section title={c.routesTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.routesIntro}
          </p>
          <ol className="mt-5 list-decimal space-y-6 pl-5 marker:font-semibold marker:text-emerald-700">
            <li className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
              <h3 className="text-base font-semibold text-slate-900">
                {c.noCodeTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">
                {c.noCodeBody}
              </p>
              <a
                href={c.noCodeLink.href}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-flex text-sm font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
              >
                {c.noCodeLink.label}
              </a>
              <CodeBlock label={c.noCodeEnvLabel} code={c.noCodeEnv} />
            </li>

            <li className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
              <h3 className="text-base font-semibold text-slate-900">
                {c.sdkTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">
                {c.sdkBody}
              </p>
              <a
                href={c.sdkPackage.href}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-flex text-sm font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
              >
                {c.sdkPackage.label}
              </a>
              <CodeBlock label={c.sdkInstallLabel} code={c.sdkInstall} />
              <CodeBlock label={c.sdkOneShotLabel} code={c.sdkOneShotCode} />
              <p className="mt-4 text-sm leading-relaxed text-slate-700">
                {c.sdkSplitIntro}
              </p>
              <CodeBlock label={c.sdkSplitLabel} code={c.sdkSplitCode} />
              <p className="mt-3 rounded-xl bg-amber-50 p-4 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
                {c.sdkSplitNote}
              </p>
            </li>

            <li className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
              <h3 className="text-base font-semibold text-slate-900">
                {c.snippetTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">
                {c.snippetBody}
              </p>
              <Link
                href={`/${locale}${c.snippetLink.href}`}
                className="mt-3 inline-flex text-sm font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
              >
                {c.snippetLink.label}
              </Link>
            </li>
          </ol>
          <div className="mt-5 rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200/70">
            <h3 className="text-sm font-semibold text-emerald-900">
              {c.authorityTitle}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">
              {c.authorityBody}
            </p>
          </div>
        </Section>

        <Section title={c.listingTitle}>
          <StepList
            steps={c.listingSteps}
            badgeClassName="bg-emerald-600 text-white"
          />
          <Link
            href={`/${locale}${c.registrationLink.href}`}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm ring-1 ring-emerald-200 transition-colors hover:bg-emerald-50"
          >
            {c.registrationLink.label}
          </Link>
        </Section>

        {/* 業務完了型の説明の書き方 (2026-07-23 朝刊裁定 P2: モデル紹介でなく完了する仕事を書く) */}
        <Section title={c.jobDescTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.jobDescIntro}
          </p>
          <BulletList
            items={c.jobDescItems}
            marker="•"
            markerClassName="text-emerald-600"
          />
          <p className="mt-4 rounded-2xl bg-white p-5 text-sm leading-relaxed text-slate-700 shadow-card ring-1 ring-emerald-200/70">
            <span className="mb-1 block text-xs font-semibold text-emerald-700">
              {c.jobDescExampleLabel}
            </span>
            {c.jobDescExample}
          </p>
        </Section>

        <Section title={c.qualityTitle}>
          <BulletList
            items={c.quality}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        <Section title={c.pricingTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.pricingIntro}
          </p>
          <BulletList
            items={c.pricingExamples}
            marker="•"
            markerClassName="text-emerald-600"
          />
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.pricingAdvice}
          </p>
          <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700 ring-1 ring-slate-200/70">
            {c.pricingGuard}
          </p>
        </Section>

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
          <p className="mt-5 text-sm leading-relaxed text-slate-600">
            {c.buyerGuideLead}
            <Link
              href={`/${locale}${c.buyerGuideLink.href}`}
              className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
            >
              {c.buyerGuideLink.label}
            </Link>
          </p>
        </section>
      </article>
    </AppShell>
  );
}
