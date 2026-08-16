// /guide/shop: 「レジ・モバイルオーダー」店舗運営者向け LP 兼ガイド (P3 新設)。
//
// content SOT は lib/shopGuide.ts (ja/en 同梱)。利用料の数値は content に持たず、
// 掟 14 フェンス済みの Landing.supportFeeRegister*/supportFeeMobile* (messages) を
// そのまま描画する (tests/app/legal.test.tsx のフェンスが本ページの表示も守る)。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { Section } from '@/components/guide/PosGuidePieces';
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
  const tLanding = await getTranslations({ locale, namespace: 'Landing' });

  const fees = [
    {
      title: tLanding('supportFeeRegisterTitle'),
      focal: tLanding('supportFeeRegisterFocal'),
      body: tLanding('supportFeeRegisterBody'),
    },
    {
      title: tLanding('supportFeeMobileTitle'),
      focal: tLanding('supportFeeMobileFocal'),
      body: tLanding('supportFeeMobileBody'),
    },
  ];

  const guideLinks = [
    { href: `/${locale}/guide/start`, label: c.guideLinkStart },
    { href: `/${locale}/guide/image-url`, label: c.guideLinkImage },
    { href: `/${locale}/guide/pos`, label: c.guideLinkPos },
    { href: `/${locale}/guide/mobile-order`, label: c.guideLinkCustomer },
    { href: `/${locale}/guide/agent`, label: c.guideLinkAgent },
  ];

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
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
            {c.heroTitle}
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-700 sm:text-base">
            {c.heroLead}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href={`/${locale}/create?tab=register`}
              prefetch={false}
              className="inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
            >
              {c.heroCtaRegister}
            </Link>
            <Link
              href={`/${locale}/create?tab=mobileOrder`}
              prefetch={false}
              className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
            >
              {c.heroCtaMobile}
            </Link>
          </div>
          <div className="mt-7 overflow-hidden rounded-[1.75rem] bg-white shadow-lift ring-1 ring-slate-200/60">
            <Image
              src="/og-image-mobileorder.webp"
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

        <Section title={c.flowTitle}>
          <ol className="mt-4 space-y-3">
            {c.flowSteps.map((step, i) => (
              <li key={step} className="flex items-start gap-3">
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800">
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
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {fees.map((fee) => (
              <div
                key={fee.title}
                className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)]"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-bold text-slate-900">
                    {fee.focal}
                  </span>
                  <h3 className="text-sm font-bold text-slate-900">
                    {fee.title}
                  </h3>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {fee.body}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            {tLanding('supportFeeNote')}
          </p>
        </Section>

        <Section title={c.startTitle}>
          <ol className="mt-4 space-y-3">
            {c.startSteps.map((step, i) => (
              <li key={step} className="flex items-start gap-3">
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800">
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
          <h2 className="text-lg font-bold text-emerald-900">{c.ctaTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.ctaBody}
          </p>
          <Link
            href={`/${locale}/create?tab=register`}
            prefetch={false}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
          >
            {c.ctaLabel}
          </Link>
        </section>
      </article>
    </AppShell>
  );
}
