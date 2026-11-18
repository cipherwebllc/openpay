// /sponsors: スポンサー・広告掲載のご案内 (2026-11-18 user 裁定の第 1 段 = 募集ページと導線だけ)。
//
// 本文は lib/sponsors.ts (ja/en 同梱・ja は承認済みの文)。料金・日数・社数・入稿の数字は lib/sponsorPlans.ts の定数から。
// 部品は components/sponsors/SponsorsPieces.tsx。問い合わせは Discord と X だけ (URL はフッターと同じ lib/officialLinks.ts)。
// 第 1 段では掲載の欄・設定ファイル・ランダム表示を作らない (掲載イメージは「サンプル」と明記した枠だけ)。
// 第 2 段 (設定ファイル・バナーのランダム表示・協賛企業のロゴ・掲載期間の自動の切り替え・各ページへの設置) は、最初の掲載が
// 決まりそうになってから作る。
// SEO 対象なので noindex にしない (sitemap に載せる)。掟 3: default / generateMetadata 以外を export しない。リンクは prefetch={false}。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { BulletList } from '@/components/guide/PosGuidePieces';
import { phrased } from '@/components/Phrased';
import {
  SponsorsAnnualPlanCard,
  SponsorsContactActions,
  SponsorsFlow,
  SponsorsParagraph,
  SponsorsPlanCards,
  SponsorsSamples,
  SponsorsSection,
  SponsorsSpecList,
} from '@/components/sponsors/SponsorsPieces';
import { keepNumbersTogether } from '@/lib/guideText';
import { sponsorsContentFor, sponsorsMetadata } from '@/lib/sponsors';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return sponsorsMetadata(locale);
}

export default async function SponsorsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = sponsorsContentFor(locale);
  const [sponsorPlan, bannerPlan] = c.plans;

  return (
    <AppShell>
      {/* 日本語は文節で折り、最後の行が 1〜2 字だけにならないようにする (Chromium 系・word-break と text-wrap は子に継ぐ)。
          文節で折る CSS が無い iPhone の Safari は、見出しと短い行だけ phrased の区切りで折る。 */}
      <article className="mx-auto max-w-4xl [word-break:auto-phrase] supports-[word-break:auto-phrase]:text-pretty">
        <Link
          href={`/${locale}`}
          prefetch={false}
          className="inline-flex min-h-11 items-center text-sm font-medium text-emerald-700 hover:text-emerald-900"
        >
          {c.backHome}
        </Link>

        <header className="mt-2">
          {/* 文節で折る (スマホで「…ご案 / 内」のように 1 字だけが次の行に落ちない・iPhone の Safari は phrased の区切りで折る)。 */}
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-slate-900 [word-break:auto-phrase] sm:text-4xl">
            {phrased(c.title, locale)}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-700 sm:text-lg">{c.lead}</p>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600 sm:text-base">{c.audience}</p>
          <SponsorsContactActions discordLabel={c.contactDiscord} xLabel={c.contactX} />
        </header>

        <SponsorsSection id="plans" title={phrased(c.plansTitle, locale)}>
          <SponsorsParagraph>{c.plansLead}</SponsorsParagraph>
          <SponsorsPlanCards plans={c.plans} locale={locale} />
          <SponsorsAnnualPlanCard plan={c.annual} locale={locale} />
          <p className="mt-4 text-sm leading-relaxed text-slate-600">{keepNumbersTogether(c.priceNote)}</p>
        </SponsorsSection>

        <SponsorsSection id="samples" title={phrased(c.samplesTitle, locale)}>
          <SponsorsSamples
            sponsorTitle={sponsorPlan.name}
            bannerTitle={bannerPlan.name}
            sampleLabel={c.sampleLabel}
            logoLabel={c.sampleLogo}
            companyLabel={c.sampleCompany}
            bannerSize={c.sampleBannerSize}
          />
        </SponsorsSection>

        <SponsorsSection id="specs" title={phrased(c.specsTitle, locale)}>
          <SponsorsSpecList items={c.specs} locale={locale} />
        </SponsorsSection>

        <SponsorsSection id="terms" title={phrased(c.termsTitle, locale)}>
          <SponsorsParagraph>{c.terms}</SponsorsParagraph>
          <p className="mt-3 text-sm leading-relaxed text-slate-700 sm:text-base">
            <span className="font-semibold text-slate-900">{c.bannerTermsLabel}</span>
            {/* 札と本文の間: ja は括弧で区切れるので空けない・en は語の間の空白。 */}
            {locale === 'en' ? ' ' : ''}
            {keepNumbersTogether(c.bannerTerms)}
          </p>
        </SponsorsSection>

        <SponsorsSection id="renewal" title={phrased(c.renewalTitle, locale)}>
          <SponsorsParagraph>{c.renewal}</SponsorsParagraph>
          <SponsorsParagraph>{c.renewalAnnual}</SponsorsParagraph>
        </SponsorsSection>

        <SponsorsSection id="standards" title={phrased(c.standardsTitle, locale)}>
          <SponsorsParagraph>{c.standardsIntro}</SponsorsParagraph>
          <BulletList items={c.standards} marker="•" />
          <SponsorsParagraph>{c.standardsNote}</SponsorsParagraph>
        </SponsorsSection>

        <SponsorsSection id="refund" title={phrased(c.refundTitle, locale)}>
          <SponsorsParagraph>{c.refund}</SponsorsParagraph>
        </SponsorsSection>

        <SponsorsSection id="welcome" title={phrased(c.welcomeTitle, locale)}>
          <SponsorsParagraph>{c.welcome}</SponsorsParagraph>
        </SponsorsSection>

        {/* 締めは流れと問い合わせのボタン (① Discord か X でお問い合わせ の行き先)。 */}
        <SponsorsSection id="flow" title={phrased(c.flowTitle, locale)}>
          <SponsorsFlow steps={c.flow} locale={locale} />
          <SponsorsContactActions discordLabel={c.contactDiscord} xLabel={c.contactX} className="mt-6" />
        </SponsorsSection>
      </article>
    </AppShell>
  );
}
