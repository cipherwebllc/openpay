// /guide/qr: 「決済QR」シンプルな JPYC 受け取り向け LP 兼ガイド (P4 新設)。
//
// content SOT は lib/qrGuide.ts (ja/en 同梱)。利用料は掟 14 フェンス済みの
// Landing.supportFeePay* を、対応通貨・チェーンは Landing.faqA2 をそのまま描画する
// (数値・チェーン一覧の直書きを増やさない — plans/site-ia-guides-ruling.md N7)。
// Hero 画像は旧トップ Hero の店頭決済イラストを再利用 (裁定・確定 4)。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { guideNavFor } from '@/lib/guideNav';
import { GuideFeeList } from '@/components/guide/GuideFee';
import { GUIDE_PRIMARY_ACTION, GUIDE_SECONDARY_ACTION, GuideLead, GuideSubtitle, GuideTitle, GuideAudience, GuideFeatureList } from '@/components/guide/GuideHeader';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';
import { BulletList, STEP_BADGE, Section } from '@/components/guide/PosGuidePieces';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { HOWTO_VIDEO_UI, howtoVideoFor } from '@/lib/howtoVideos';
import { qrGuideContentFor, qrGuideMetadata } from '@/lib/qrGuide';
import { GuideCallout } from '@/components/guide/GuideCallout';

// JPYC 社の発表 (2026-10-09・割引などの優遇についての同社の考え方と導入店向け相談窓口)。窓口のメールアドレスは
// 載せずに発表へリンクする (公開の連絡先にメールアドレスを書かない方針)。
const JPYC_DISCOUNT_RELEASE_URL = 'https://prtimes.jp/main/html/rd/p/000000332.000054018.html';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return qrGuideMetadata(locale);
}

function StepList({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="mt-4 space-y-3">
      {steps.map((step, i) => (
        <li key={step} className="flex items-start gap-3">
          <span className={STEP_BADGE}>
            {i + 1}
          </span>
          <span className="text-sm leading-relaxed text-slate-700">{step}</span>
        </li>
      ))}
    </ol>
  );
}

export default async function GuideQrPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = qrGuideContentFor(locale);
  const video = howtoVideoFor(locale, 'qr');
  const tLanding = await getTranslations({ locale, namespace: 'Landing' });


  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="qr">
      <article className="mx-auto max-w-3xl">

        <header>
          <GuideTitle>{guideNavFor(locale).items['qr'].label}</GuideTitle>
          <GuideSubtitle>{c.heroTitle}</GuideSubtitle>
          <GuideLead>
            {c.heroLead}
          </GuideLead>
          <GuideAudience title={c.forWhoTitle} chips={c.forWhoChips} />
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href={`/${locale}/create`}
              prefetch={false}
              className={GUIDE_PRIMARY_ACTION}
            >
              {c.heroCtaCreate}
            </Link>
            <Link
              href={`/${locale}/scan`}
              prefetch={false}
              className={GUIDE_SECONDARY_ACTION}
            >
              {c.heroCtaScan}
            </Link>
          </div>
          <div className="mt-8 overflow-hidden rounded-[1.75rem] bg-white shadow-lift ring-1 ring-slate-200/60">
            <Image
              src="/landing/hero-qr-payment.avif"
              alt={c.heroVisualAlt}
              width={1400}
              height={787}
              priority
              sizes="(min-width: 768px) 768px, calc(100vw - 2rem)"
              className="h-auto w-full object-cover"
            />
          </div>
        </header>


        <Section title={c.featuresTitle}>
          <GuideFeatureList items={c.features} />
        </Section>

        {/* 動画は「できること」の後 (ヒーロー画像の直後に画像が 2 枚続かないように)。 */}
        {video && (
          <Section title={HOWTO_VIDEO_UI.sectionTitle} toc={false}>
            <GuideVideo video={video} />
          </Section>
        )}

        <Section title={c.receiveFlowTitle}>
          <StepList steps={c.receiveFlowSteps} />
        </Section>

        <Section title={c.payFlowTitle}>
          <StepList steps={c.payFlowSteps} />
        </Section>

        <Section title={c.feeTitle}>
          <GuideFeeList
            items={[
              {
                focal: tLanding('supportFeePayFocal', LANDING_PAYMENT_FEE_VALUES),
                title: tLanding('supportFeePayTitle'),
                body: tLanding('supportFeePayBody', LANDING_PAYMENT_FEE_VALUES),
              },
            ]}
            note={tLanding('supportFeeNote')}
            pricingHref={`/${locale}/pricing`}
            pricingLabel={tLanding('supportFeeDetailsLink')}
          />
        </Section>

        <Section title={c.discountTitle} id="jpyc-discount">
          <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.discountLead}</p>
          <BulletList items={c.discountPoints} marker="•" markerClassName="text-emerald-600" />
          <GuideCallout kind="warn">
            <p>{c.discountCaution}</p>
            <p className="mt-1">
              <a
                href={JPYC_DISCOUNT_RELEASE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold underline underline-offset-2"
              >
                {c.discountSourceLabel}
              </a>
            </p>
          </GuideCallout>
        </Section>

        <Section title={c.currenciesTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {tLanding('faqA2', LANDING_PAYMENT_FEE_VALUES)}
          </p>
        </Section>

        <GuideCta title={c.ctaTitle} action={{ href: `/${locale}/create`, label: c.ctaLabel }}>
          <p>{c.ctaBody}</p>
        </GuideCta>
        <GuideRelated locale={locale} current="qr" links={['start', 'shop', 'pos']} />
      </article>
      </GuideFrame>
    </AppShell>
  );
}
