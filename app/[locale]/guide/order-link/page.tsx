// /guide/order-link:「注文リンク」お店向けガイド (通販の注文ごとに支払いリンクを作って送る)。
//
// content SOT は lib/orderLinkGuide.ts (ja/en 同梱)。利用料の率と最低額は DISCLOSED_* 由来の
// LANDING_PAYMENT_FEE_VALUES で埋め、下の注記は掟 14 フェンス済みの Landing.supportFeeNote をそのまま描画する。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';
import { GuideFaq } from '@/components/guide/GuideFaq';
import { GuideFeeList } from '@/components/guide/GuideFee';
import { GuideFrame } from '@/components/guide/GuideFrame';
import {
  GuideActions,
  GuideAudience,
  GuideFeatureList,
  GuideLead,
  GuideSubtitle,
  GuideTitle,
} from '@/components/guide/GuideHeader';
import { GuideToc } from '@/components/guide/GuideToc';
import { BulletList, STEP_BADGE_CUSTOMER, Section, StepLines } from '@/components/guide/PosGuidePieces';
import { guideNavFor } from '@/lib/guideNav';
import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import { orderLinkGuideContentFor, orderLinkGuideMetadata } from '@/lib/orderLinkGuide';

/** content の {recoverPercent}・{recoverFloor} を開示の値で埋める (率を content に直書きしない・掟 14)。 */
function withFeeValues(text: string): string {
  return text
    .replaceAll('{recoverPercent}', String(LANDING_PAYMENT_FEE_VALUES.recoverPercent))
    .replaceAll('{recoverFloor}', String(LANDING_PAYMENT_FEE_VALUES.recoverFloor));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return orderLinkGuideMetadata(locale);
}

export default async function GuideOrderLinkPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = orderLinkGuideContentFor(locale);
  const nav = guideNavFor(locale);
  const tLanding = await getTranslations({ locale, namespace: 'Landing' });
  const createHref = `/${locale}/create?tab=orderLink`;

  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="order-link">
        <article className="mx-auto max-w-3xl">
          <header>
            <GuideTitle>{nav.items['order-link'].label}</GuideTitle>
            <GuideSubtitle>{c.subtitle}</GuideSubtitle>
            <GuideLead>{c.lead}</GuideLead>
            <GuideActions actions={[{ href: createHref, label: c.ctaCreate }]} />
            <GuideAudience title={c.forWhoTitle} chips={c.forWhoChips} />
          </header>

          <GuideToc title={nav.tocTitle} />

          <Section title={c.featuresTitle}>
            <GuideFeatureList items={c.features} />
          </Section>

          <Section title={c.stepsTitle}>
            <StepLines steps={c.steps} />
          </Section>

          <Section title={c.payStepsTitle}>
            <StepLines steps={c.paySteps} badgeClassName={STEP_BADGE_CUSTOMER} />
          </Section>

          <Section title={c.feeTitle}>
            <GuideFeeList
              items={[c.feeGasless, c.feeStandard].map((item) => ({
                focal: withFeeValues(item.focal),
                title: item.title,
                body: withFeeValues(item.body),
              }))}
              note={tLanding('supportFeeNote')}
              pricingHref={`/${locale}/pricing`}
              pricingLabel={tLanding('supportFeeDetailsLink')}
            />
            <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.feeLimit}</p>
          </Section>

          <Section title={c.checksTitle}>
            <BulletList items={c.checks} marker="✓" />
            <GuideCallout kind="warn">
              <p>{c.sellerDuty}</p>
            </GuideCallout>
          </Section>

          <Section title={c.faqTitle}>
            <GuideFaq items={c.faq} />
          </Section>

          <GuideCta title={c.ctaTitle} action={{ href: createHref, label: c.ctaLabel }}>
            <p>{c.ctaBody}</p>
          </GuideCta>

          <GuideRelated locale={locale} current="order-link" links={['pay', 'wallet', 'start', 'pricing']} />
        </article>
      </GuideFrame>
    </AppShell>
  );
}
