// /guide/shop: 「レジ・モバイルオーダー」店舗運営者向け LP 兼ガイド (P3 新設)。
//
// content SOT は lib/shopGuide.ts (ja/en 同梱)。利用料の数値は content に持たず、
// 掟 14 フェンス済みの Landing.supportFeeRegister*/supportFeeMobile* (messages) を
// そのまま描画する (tests/app/legal.test.tsx のフェンスが本ページの表示も守る)。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { guideNavFor } from '@/lib/guideNav';
import { GuideFeeList } from '@/components/guide/GuideFee';
import { GUIDE_TAG, GUIDE_PRIMARY_ACTION, GUIDE_SECONDARY_ACTION, GuideLead, GuideSubtitle, GuideTitle, GuideFeatureList } from '@/components/guide/GuideHeader';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';
import { Section, StepLines } from '@/components/guide/PosGuidePieces';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { HOWTO_VIDEO_UI, howtoVideoFor } from '@/lib/howtoVideos';
import { shopGuideContentFor, shopGuideMetadata } from '@/lib/shopGuide';
import { GuideToc } from '@/components/guide/GuideToc';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return shopGuideMetadata(locale);
}

export default async function GuideShopPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = shopGuideContentFor(locale);
  // このページはレジとモバイルオーダーの両方を扱うので、動画も 3 本 (レジ → モバイルオーダー → 受注の順・ja だけ)。
  const videos = [
    howtoVideoFor(locale, 'register'),
    howtoVideoFor(locale, 'mobileOrder'),
    howtoVideoFor(locale, 'orders'),
  ].filter((v) => v !== null);
  const tLanding = await getTranslations({ locale, namespace: 'Landing' });

  const fees = [
    {
      title: tLanding('supportFeeRegisterTitle'),
      focal: tLanding('supportFeeRegisterFocal', LANDING_PAYMENT_FEE_VALUES),
      body: tLanding('supportFeeRegisterBody', LANDING_PAYMENT_FEE_VALUES),
    },
    {
      title: tLanding('supportFeeMobileTitle'),
      focal: tLanding('supportFeeMobileFocal', LANDING_PAYMENT_FEE_VALUES),
      body: tLanding('supportFeeMobileBody', LANDING_PAYMENT_FEE_VALUES),
    },
  ];


  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="shop">
      <article className="mx-auto max-w-3xl">

        <header>
          <GuideTitle>{guideNavFor(locale).items['shop'].label}</GuideTitle>
          <GuideSubtitle>{c.heroTitle}</GuideSubtitle>
          <GuideLead>
            {c.heroLead}
          </GuideLead>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href={`/${locale}/create?tab=register`}
              prefetch={false}
              className={GUIDE_PRIMARY_ACTION}
            >
              {c.heroCtaRegister}
            </Link>
            <Link
              href={`/${locale}/create?tab=mobileOrder`}
              prefetch={false}
              className={GUIDE_SECONDARY_ACTION}
            >
              {c.heroCtaMobile}
            </Link>
          </div>
        </header>

        <GuideToc title={guideNavFor(locale).tocTitle} />

        <Section title={c.relationTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.relationBody}
          </p>
        </Section>

        <Section title={c.featuresTitle}>
          <GuideFeatureList items={c.features} />
        </Section>

        {/* 動画は「できること」の後 (ページの頭は文字と行動ボタンだけにして軽くする・P5)。 */}
        {videos.length > 0 && (
          <Section title={HOWTO_VIDEO_UI.sectionTitle} toc={false}>
            <div className="space-y-3">
              {videos.map((v) => (
                <GuideVideo key={v.youtubeId} video={v} />
              ))}
            </div>
          </Section>
        )}

        <Section title={c.flowTitle}>
          <StepLines steps={c.flowSteps} />
        </Section>

        <Section title={c.scenesTitle}>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {c.sceneChips.map((chip) => (
              <span
                key={chip}
                className={GUIDE_TAG}
              >
                {chip}
              </span>
            ))}
          </div>
        </Section>

        <Section title={c.feeTitle}>
          <GuideFeeList
            items={fees}
            note={tLanding('supportFeeNote')}
            pricingHref={`/${locale}/pricing`}
            pricingLabel={tLanding('supportFeeDetailsLink')}
          />
        </Section>

        <Section title={c.startTitle}>
          <StepLines steps={c.startSteps} />
        </Section>

        <GuideCta title={c.ctaTitle} action={{ href: `/${locale}/create?tab=register`, label: c.ctaLabel }}>
          <p>{c.ctaBody}</p>
        </GuideCta>
        <GuideRelated
          locale={locale}
          current="shop"
          links={['mobile-order', 'image-url', { href: `/${locale}/guide/qr#jpyc-discount`, label: c.guideLinkDiscount }]}
        />
      </article>
      </GuideFrame>
    </AppShell>
  );
}
