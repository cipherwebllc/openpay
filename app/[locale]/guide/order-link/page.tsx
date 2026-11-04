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
import { GuideDisclosure } from '@/components/guide/GuideDisclosure';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';
import { GuideFaq } from '@/components/guide/GuideFaq';
import { GuideFeeList } from '@/components/guide/GuideFee';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideMoreLink } from '@/components/guide/GuideLink';
import { withUiNames } from '@/components/guide/GuideUiNames';
import {
  GuideActions,
  GuideAudience,
  GuideFeatureList,
  GuideLead,
  GuideSubtitle,
  GuideTitle,
} from '@/components/guide/GuideHeader';
import { GuideToc } from '@/components/guide/GuideToc';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { BulletList, STEP_BADGE_CUSTOMER, Section, StepList } from '@/components/guide/PosGuidePieces';
import { guideNavFor } from '@/lib/guideNav';
import { HOWTO_VIDEO_UI, howtoVideoFor } from '@/lib/howtoVideos';
import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import { orderLinkGuideContentFor, orderLinkGuideMetadata, type OrderLinkGuideContent } from '@/lib/orderLinkGuide';

/** content の {recoverPercent}・{recoverFloor} を開示の値で埋める (率を content に直書きしない・掟 14)。 */
function withFeeValues(text: string): string {
  return text
    .replaceAll('{recoverPercent}', String(LANDING_PAYMENT_FEE_VALUES.recoverPercent))
    .replaceAll('{recoverFloor}', String(LANDING_PAYMENT_FEE_VALUES.recoverFloor));
}

/** 手順 3 の「お客様の画面」の図 (本番の画面を撮ったもの)。PC 用と lg 未満用で置き場所が違うので 2 か所から使う。 */
function PreviewShot({ shot, className }: { shot: OrderLinkGuideContent['previewShot']; className: string }) {
  return (
    <figure className={`w-full ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/guide/order-link/${shot.file}`}
        alt={shot.alt}
        width={shot.width}
        height={shot.height}
        loading="lazy"
        className="h-auto w-full rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70"
      />
      <figcaption className="mt-2 text-center text-xs leading-relaxed text-slate-500">{withUiNames(shot.caption)}</figcaption>
    </figure>
  );
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
  const video = howtoVideoFor(locale, 'orderLink');
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
            <GuideFeatureList items={c.features} uiNames />
          </Section>

          {video && (
            <Section title={HOWTO_VIDEO_UI.sectionTitle} toc={false}>
              <GuideVideo video={video} />
            </Section>
          )}

          <Section title={c.stepsTitle}>
            {/*
              PC (lg 以上) は手順の右の列に「お客様の画面」の図。lg 未満は図を手順 3 (リンクを送る) の直下に置く
              (図が手順 4 の後ろに出て、どの手順の図か分からなくなるのを避ける)。「設定」の項目は手順 1 の直下。
            */}
            <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start lg:gap-10">
              <StepList
                steps={c.steps.map((step, i) => ({ n: i + 1, ...step }))}
                uiNames
                extras={{
                  1: (
                    <GuideDisclosure variant="subtle" summary={withUiNames(c.settingsLabel)}>
                      <dl className="divide-y divide-slate-200/70">
                        {c.settings.map((row) => (
                          <div key={row.label} className="grid gap-0.5 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[8.5rem_1fr] sm:gap-4">
                            <dt className="text-sm font-semibold text-slate-800">{row.label}</dt>
                            <dd className="text-sm leading-relaxed text-slate-600">{row.body}</dd>
                          </div>
                        ))}
                      </dl>
                    </GuideDisclosure>
                  ),
                  3: <PreviewShot shot={c.previewShot} className="mt-4 max-w-[280px] lg:hidden" />,
                }}
              />
              <PreviewShot shot={c.previewShot} className="mt-4 hidden lg:block" />
            </div>
          </Section>

          <Section title={c.payStepsTitle}>
            <StepList
              steps={c.paySteps.map((step, i) => ({ n: i + 1, ...step }))}
              badgeClassName={STEP_BADGE_CUSTOMER}
              uiNames
            />
            <p className="mt-4 text-sm leading-relaxed text-slate-600">
              {c.payNoWallet}{' '}
              <GuideMoreLink href={`/${locale}/guide/wallet`}>{nav.items.wallet.label}</GuideMoreLink>
            </p>
          </Section>

          <Section title={c.checksTitle}>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">{withUiNames(c.checksLead)}</p>
            <GuideFeatureList items={c.checks} columns={1} uiNames />
            <BulletList items={c.checksNotes} marker="•" />
            <GuideCallout kind="warn">
              <p>{c.sellerDuty}</p>
            </GuideCallout>
          </Section>

          {/* 利用料は発送までの流れ (作る → 払う → 確かめる) の後ろ。流れを途中で切らない。 */}
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
              expanded
            >
              <p className="mt-3 text-sm leading-relaxed text-slate-700">{withUiNames(c.feeLimit)}</p>
            </GuideFeeList>
          </Section>

          <Section title={c.faqTitle}>
            <GuideFaq items={c.faq} uiNames />
          </Section>

          <GuideCta title={c.ctaTitle} action={{ href: createHref, label: c.ctaLabel }}>
            <p>{withUiNames(c.ctaBody)}</p>
          </GuideCta>

          <GuideRelated locale={locale} current="order-link" links={['pay', 'wallet', 'start', 'pricing']} />
        </article>
      </GuideFrame>
    </AppShell>
  );
}
