// /guide/shop: 「レジ・モバイルオーダー」店舗運営者向け LP 兼ガイド (P3 新設)。
//
// content SOT は lib/shopGuide.ts (ja/en 同梱)。利用料の数値は content に持たず、
// 掟 14 フェンス済みの Landing.supportFeeRegister*/supportFeeMobile* (messages) を
// そのまま描画する (tests/app/legal.test.tsx のフェンスが本ページの表示も守る)。
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
import { GUIDE_PRIMARY_ACTION, GUIDE_SECONDARY_ACTION, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { STEP_BADGE, Section } from '@/components/guide/PosGuidePieces';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { HOWTO_VIDEO_UI, howtoVideoFor } from '@/lib/howtoVideos';
import { shopGuideContentFor, shopGuideMetadata } from '@/lib/shopGuide';

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

  const guideLinks = [
    { href: `/${locale}/guide/start`, label: c.guideLinkStart },
    { href: `/${locale}/guide/image-url`, label: c.guideLinkImage },
    { href: `/${locale}/guide/pos`, label: c.guideLinkPos },
    { href: `/${locale}/guide/mobile-order`, label: c.guideLinkCustomer },
    { href: `/${locale}/guide/agent`, label: c.guideLinkAgent },
    { href: `/${locale}/guide/qr#jpyc-discount`, label: c.guideLinkDiscount },
  ];

  return (
    <AppShell>
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
          <div className="mt-8 overflow-hidden rounded-[1.75rem] bg-white shadow-lift ring-1 ring-slate-200/60">
            <Image
              src="/landing/mobileorder.webp"
              alt={c.heroVisualAlt}
              width={1280}
              height={670}
              priority
              sizes="(min-width: 768px) 768px, calc(100vw - 2rem)"
              className="h-auto w-full object-cover"
            />
          </div>
        </header>


        <Section title={c.relationTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.relationBody}
          </p>
        </Section>

        <Section title={c.featuresTitle}>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {c.features.map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)]"
              >
                <h3 className="text-sm font-bold text-slate-900">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </Section>

        {/* 動画は「できること」の後 (ヒーロー画像の直後に画像が 2 枚続かないように)。 */}
        {videos.length > 0 && (
          <Section title={HOWTO_VIDEO_UI.sectionTitle} toc={false}>
            <div className="space-y-8">
              {videos.map((v) => (
                <GuideVideo key={v.youtubeId} video={v} />
              ))}
            </div>
          </Section>
        )}

        <Section title={c.flowTitle}>
          <ol className="mt-4 space-y-3">
            {c.flowSteps.map((step, i) => (
              <li key={step} className="flex items-start gap-3">
                <span className={STEP_BADGE}>
                  {i + 1}
                </span>
                <span className="text-sm leading-relaxed text-slate-700">
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </Section>

        <Section title={c.scenesTitle}>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {c.sceneChips.map((chip) => (
              <span
                key={chip}
                className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700"
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
          <ol className="mt-4 space-y-3">
            {c.startSteps.map((step, i) => (
              <li key={step} className="flex items-start gap-3">
                <span className={STEP_BADGE}>
                  {i + 1}
                </span>
                <span className="text-sm leading-relaxed text-slate-700">
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </Section>

        <Section title={c.guidesTitle}>
          <ul className="mt-3 space-y-2">
            {guideLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  prefetch={false}
                  className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline"
                >
                  {link.label} →
                </Link>
              </li>
            ))}
          </ul>
        </Section>

        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 data-toc="skip" className="text-lg font-bold text-emerald-900">{c.ctaTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.ctaBody}
          </p>
          <Link
            href={`/${locale}/create?tab=register`}
            prefetch={false}
            className={`mt-5 ${GUIDE_PRIMARY_ACTION}`}
          >
            {c.ctaLabel}
          </Link>
        </section>
      </article>
      </GuideFrame>
    </AppShell>
  );
}
