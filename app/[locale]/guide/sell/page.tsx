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
import { GuideDisclosure, GuideDisclosureGroup } from '@/components/guide/GuideDisclosure';
import { guideNavFor } from '@/lib/guideNav';
import { GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideCta } from '@/components/guide/GuideEnd';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideToc } from '@/components/guide/GuideToc';
import { BulletList, Section, StepList } from '@/components/guide/PosGuidePieces';
import { CodeBlock } from '@/components/guide/AgentGuidePieces';
import { SELL_GUIDE_STARTER_KIT_JA, guideSellMetadata, sellGuideContentFor } from '@/lib/sellGuide';
import { splitTextLinks } from '@/lib/textLinks';
import { GUIDE_INLINE_LINK, GuideMoreLink, GuideTxLink } from '@/components/guide/GuideLink';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return guideSellMetadata(locale);
}

const ROUTE_BADGE =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-sm font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200';

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
          {/* 3 つは順番ではなく選ぶもの。手順の番号 (塗りの丸) と見分けるため A・B・C の角丸の札にする。 */}
          <GuideDisclosureGroup as="ul" className="mt-5">
            <li>
              <GuideDisclosure
                summary={
                  <>
                    <h3 className="flex items-center gap-3 text-base font-semibold text-slate-900">
                      <span className={ROUTE_BADGE}>A</span>
                      {c.noCodeTitle}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">
                      {c.noCodeBody}
                    </p>
                  </>
                }
              >
              <GuideMoreLink href={c.noCodeLink.href} external>
                {c.noCodeLink.label}
              </GuideMoreLink>
              <CodeBlock label={c.noCodeEnvLabel} code={c.noCodeEnv} />
              </GuideDisclosure>
            </li>

            <li>
              <GuideDisclosure
                summary={
                  <>
                    <h3 className="flex items-center gap-3 text-base font-semibold text-slate-900">
                      <span className={ROUTE_BADGE}>B</span>
                      {c.sdkTitle}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">
                      {c.sdkBody}
                    </p>
                  </>
                }
              >
              <GuideMoreLink href={c.sdkPackage.href} external>
                {c.sdkPackage.label}
              </GuideMoreLink>
              <CodeBlock label={c.sdkInstallLabel} code={c.sdkInstall} />
              <CodeBlock label={c.sdkOneShotLabel} code={c.sdkOneShotCode} />
              <p className="mt-4 text-sm leading-relaxed text-slate-700">
                {c.sdkSplitIntro}
              </p>
              <CodeBlock label={c.sdkSplitLabel} code={c.sdkSplitCode} />
              <GuideCallout kind="warn">{c.sdkSplitNote}</GuideCallout>
              </GuideDisclosure>
            </li>

            <li>
              <GuideDisclosure
                summary={
                  <>
                    <h3 className="flex items-center gap-3 text-base font-semibold text-slate-900">
                      <span className={ROUTE_BADGE}>C</span>
                      {c.snippetTitle}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">
                      {c.snippetBody}
                    </p>
                  </>
                }
              >
              <GuideMoreLink href={`/${locale}${c.snippetLink.href}`}>{c.snippetLink.label}</GuideMoreLink>
              </GuideDisclosure>
            </li>
          </GuideDisclosureGroup>
          <GuideCallout kind="info" className="mt-5">
            <h3 className="font-semibold text-slate-900">{c.authorityTitle}</h3>
            <p className="mt-0.5">{c.authorityBody}</p>
          </GuideCallout>
        </Section>

        <Section title={c.listingTitle}>
          <StepList
            steps={c.listingSteps}
          />
          <p className="mt-5">
            <GuideMoreLink href={`/${locale}${c.registrationLink.href}`}>{c.registrationLink.label}</GuideMoreLink>
          </p>
          {/* Bazaar は別の発見面 (USDC/Base/CDP)。出品者の「Bazaar にも載る?」の誤解を先回りで解く。
              任意の拡張なので、見出しと要点だけを見せて本文はたたむ (plans/guide-ux-polish-2.md P3)。 */}
          <div className="mt-6">
          <GuideDisclosure
                summary={
              <>
                <h3 className="text-base font-semibold text-slate-900">{c.bazaarTitle}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.bazaarIntro}</p>
              </>
            }
          >
            <BulletList
              items={c.bazaarItems}
              marker="•"
            />
            {c.bazaarNote.map((note) => (
              // 文中の URL はリンクにする (素の文字のまま 3 行に折れていた)。URL は文の途中にも置くので、
              // URL の部分だけを切り出す (lib/textLinks.ts)。
              <p key={note} className="mt-3 text-sm leading-relaxed text-slate-700">
                {splitTextLinks(note).map((part, i) =>
                  part.kind === 'text' ? (
                    part.text
                  ) : (
                    <a
                      key={i}
                      href={part.href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="break-all font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                    >
                      {part.href}
                    </a>
                  ),
                )}
              </p>
            ))}
          </GuideDisclosure>
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
          />
        </Section>

        <Section title={c.pricingTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.pricingIntro}
          </p>
          <BulletList
            items={c.pricingExamples}
            marker="•"
          />
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.pricingAdvice}
          </p>
          <GuideCallout kind="info" className="mt-3">{c.pricingGuard}</GuideCallout>
        </Section>

        {/* 実売の事例は手順の後 (手順を知りたい人が先に読む)。先に外部の買い手による購入 (全件は /transparency)、
            次に手順の実例 (Coo-ICP・運営者の動作確認) — Coo-ICP そのものは実売ではないので分けて書く。 */}
        <Section title={c.proofTitle}>
          <div className="mt-4 rounded-2xl bg-white p-5 shadow-card ring-1 ring-emerald-200/70">
            <h3 className="text-sm font-bold text-slate-900">{c.proofExternalTitle}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">{c.proofExternal}</p>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              <Link
                href={`/${locale}${c.proofExternalLink.href}`}
                prefetch={false}
                className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
              >
                {c.proofExternalLink.label}
              </Link>
            </p>
          </div>
          <div className="mt-4 rounded-2xl bg-white p-5 shadow-card ring-1 ring-emerald-200/70">
            <h3 className="text-sm font-bold text-slate-900">{c.proofExampleLabel}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">
              {c.proofIntro}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              {c.proofFlow} <GuideTxLink href={c.proofTransaction.href} hash={c.proofTransaction.label} />
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

        <GuideCta
          title={c.ctaTitle}
          action={{ href: `/${locale}${c.ctaButtonHref}`, label: c.ctaButton }}
          footer={
            locale === 'ja' ? (
              <p>
                {SELL_GUIDE_STARTER_KIT_JA.lead}{' '}
                <a
                  href={SELL_GUIDE_STARTER_KIT_JA.link.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={GUIDE_INLINE_LINK}
                >
                  {SELL_GUIDE_STARTER_KIT_JA.link.label}
                </a>
              </p>
            ) : undefined
          }
        >
          <p>{c.ctaBody}</p>
        </GuideCta>
      </article>
      </GuideFrame>
    </AppShell>
  );
}
