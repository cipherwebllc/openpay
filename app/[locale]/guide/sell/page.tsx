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
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideDisclosure } from '@/components/guide/GuideDisclosure';
import { guideNavFor } from '@/lib/guideNav';
import { GUIDE_PRIMARY_ACTION, GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideToc } from '@/components/guide/GuideToc';
import { STEP_BADGE, BulletList, Section, StepList } from '@/components/guide/PosGuidePieces';
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
    <AppShell wide>
      <GuideFrame locale={locale} current="sell">
      <article className="mx-auto max-w-3xl">

        <header>
          <GuideTitle>{guideNavFor(locale).items['sell'].label}</GuideTitle>
          <GuideSubtitle>{c.title}</GuideSubtitle>
          <GuideLead>
            {c.subtitle}
          </GuideLead>
                  <GuideActions actions={[{ href: `/${locale}${c.ctaButtonHref}`, label: c.ctaButton }]} />
        </header>

        <GuideToc title={guideNavFor(locale).tocTitle} />

        <Section title={c.routesTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.routesIntro}
          </p>
          <ol className="mt-5 space-y-3">
            <li>
              <GuideDisclosure
                defaultOpen
                summary={
                  <>
                    <h3 className="flex items-center gap-3 text-base font-semibold text-slate-900">
                      <span className={STEP_BADGE}>1</span>
                      {c.noCodeTitle}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">
                      {c.noCodeBody}
                    </p>
                  </>
                }
              >
              <a
                href={c.noCodeLink.href}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex text-sm font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
              >
                {c.noCodeLink.label}
              </a>
              <CodeBlock label={c.noCodeEnvLabel} code={c.noCodeEnv} />
              </GuideDisclosure>
            </li>

            <li>
              <GuideDisclosure
                                summary={
                  <>
                    <h3 className="flex items-center gap-3 text-base font-semibold text-slate-900">
                      <span className={STEP_BADGE}>2</span>
                      {c.sdkTitle}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">
                      {c.sdkBody}
                    </p>
                  </>
                }
              >
              <a
                href={c.sdkPackage.href}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex text-sm font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
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
              </GuideDisclosure>
            </li>

            <li>
              <GuideDisclosure
                                summary={
                  <>
                    <h3 className="flex items-center gap-3 text-base font-semibold text-slate-900">
                      <span className={STEP_BADGE}>3</span>
                      {c.snippetTitle}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">
                      {c.snippetBody}
                    </p>
                  </>
                }
              >
              <Link
                href={`/${locale}${c.snippetLink.href}`}
                className="inline-flex text-sm font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
              >
                {c.snippetLink.label}
              </Link>
              </GuideDisclosure>
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
          />
          <Link
            href={`/${locale}${c.registrationLink.href}`}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm ring-1 ring-emerald-200 transition-colors hover:bg-emerald-50"
          >
            {c.registrationLink.label}
          </Link>
          {/* Bazaar は別の発見面 (USDC/Base/CDP)。出品者の「Bazaar にも載る?」の誤解を先回りで解く。 */}
          <div className="mt-6 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
            <h3 className="text-base font-semibold text-slate-900">{c.bazaarTitle}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">{c.bazaarIntro}</p>
            <BulletList
              items={c.bazaarItems}
              marker="•"
              markerClassName="text-emerald-600"
            />
            {c.bazaarNote.map((note) => {
              // 文中の URL はリンクにする (素の文字のまま 3 行に折れていた)。
              const [before, url] = note.split(/(?=https:\/\/)/);
              return (
                <p key={note} className="mt-3 text-sm leading-relaxed text-slate-700">
                  {before}
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="break-all font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                    >
                      {url}
                    </a>
                  ) : null}
                </p>
              );
            })}
          </div>
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

        {/* 実売の証拠は手順の後 (手順を知りたい人が先に読む)。 */}
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
      </GuideFrame>
    </AppShell>
  );
}
