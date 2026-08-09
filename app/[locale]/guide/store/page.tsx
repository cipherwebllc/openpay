// /guide/store: 「無料サービスで始めるデジタル商品販売」クリエイター向けガイド。
//
// content SOT は lib/storeGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/agentGuide.ts / lib/posGuide.ts / lib/mobileOrderGuide.ts と同じ。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { BulletList, Section } from '@/components/guide/PosGuidePieces';
import { storeGuideContentFor, storeGuideMetadata } from '@/lib/storeGuide';
import { HOSTED_PRODUCT_CATEGORIES } from '@/lib/x402/storeMeta';
import { env } from '@/lib/env';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return storeGuideMetadata(locale);
}

export default async function GuideStorePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = storeGuideContentFor(locale);
  const tCatalog = await getTranslations({ locale, namespace: 'StoreCatalog' });

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

        {/* --- LP 前半 (P2 総合案内化): Hero → 誰向け → できること → 商品例 →
            手数料 → 始め方。後半は既存の操作ガイド (opsTitle 以下) を全て保持。 --- */}
        <header className="mt-4">
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
            {c.heroTitle}
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-700 sm:text-base">
            {c.heroLead}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href={`/${locale}/create?tab=profile`}
              prefetch={false}
              className="inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
            >
              {c.heroCtaProfile}
            </Link>
            {env.enableCreatorStoreUi ? (
              <Link
                href={`/${locale}/store`}
                prefetch={false}
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
              >
                {c.heroCtaStore}
              </Link>
            ) : null}
          </div>
          <div className="mt-7 overflow-hidden rounded-[1.75rem] bg-white shadow-lift ring-1 ring-slate-200/60">
            <Image
              src="/guide/hero-creator.avif"
              alt={c.heroVisualAlt}
              width={1400}
              height={787}
              priority
              sizes="(min-width: 768px) 768px, calc(100vw - 2rem)"
              className="h-auto w-full object-cover"
            />
          </div>
        </header>

        <Section title={c.forWhoTitle}>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {c.forWhoChips.map((chip) => (
              <span
                key={chip}
                className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700"
              >
                {chip}
              </span>
            ))}
          </div>
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

        <Section title={c.categoriesTitle}>
          <div className="mt-3 flex flex-wrap gap-2">
            {HOSTED_PRODUCT_CATEGORIES.map((category) => (
              <span
                key={category}
                className="rounded-full bg-white px-3.5 py-1.5 text-sm font-semibold text-slate-700 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] ring-1 ring-slate-200"
              >
                {tCatalog(`categories.${category}`)}
              </span>
            ))}
          </div>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.categoriesExamples}
          </p>
        </Section>

        <Section title={c.feeTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.feeBody}
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

        {/* --- ここから既存の操作ガイド (6 つの方法・全文維持) --- */}
        <header className="mt-14 border-t border-slate-200 pt-10">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {c.opsTitle}
          </h2>
          <p className="mt-2 text-base font-medium text-emerald-700">
            {c.subtitle}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">{c.lead}</p>
        </header>

        <Section title={c.basicsTitle}>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr>
                  {c.basicsTable.headers.map((h) => (
                    <th
                      key={h}
                      className="border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-slate-500"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.basicsTable.rows.map((row) => (
                  <tr key={row[0]}>
                    {row.map((cell, i) => (
                      <td
                        key={cell}
                        className={`border border-slate-200 px-3 py-2 align-top leading-relaxed text-slate-700 ${
                          i === 0 ? 'font-semibold text-slate-900' : ''
                        }`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.basicsBody}
          </p>
          <p className="mt-3 rounded-xl bg-blue-50 px-4 py-3 text-sm leading-relaxed text-slate-700 ring-1 ring-blue-100">
            💡 {c.basicsPoint}
          </p>
        </Section>

        {c.methods.map((m) => (
          <Section
            key={m.n}
            title={`${locale === 'en' ? 'Method' : '方法'} ${m.n}: ${m.title}`}
          >
            <p className="mt-1 text-xs font-medium text-slate-500">
              {m.tagline}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {m.fits.map((fit) => (
                <span
                  key={fit}
                  className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700"
                >
                  {fit}
                </span>
              ))}
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              {m.intro}
            </p>
            <ol className="mt-4 space-y-3">
              {m.steps.map((step, i) => (
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
            {m.note ? (
              <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-950 ring-1 ring-amber-200">
                ⚠️ {m.note}
              </p>
            ) : null}
            {m.point ? (
              <p className="mt-4 rounded-xl bg-blue-50 px-4 py-3 text-sm leading-relaxed text-slate-700 ring-1 ring-blue-100">
                💡 {m.point}
              </p>
            ) : null}
          </Section>
        ))}

        <Section title={c.commonTitle}>
          <div className="mt-2 space-y-6">
            {c.commonSections.map((section) => (
              <div key={section.title}>
                <h3 className="text-sm font-semibold text-slate-900">
                  {section.title}
                </h3>
                {section.body ? (
                  <p className="mt-1 text-sm leading-relaxed text-slate-700">
                    {section.body}
                  </p>
                ) : null}
                {section.bullets ? (
                  // ✓ は「確認して潰す」チェックリスト用。本文を伴うセクションの箇条書きは
                  // 事実の列挙 (できなくなること等) なので、• にして推奨と読ませない。
                  <BulletList
                    items={section.bullets}
                    marker={section.body ? '•' : '✓'}
                    markerClassName="text-emerald-600"
                  />
                ) : null}
              </div>
            ))}
          </div>
        </Section>

        <Section title={c.startLinkTitle}>
          <p className="mt-2 text-sm leading-relaxed text-slate-700">
            {c.startLinkBody}
          </p>
          <p className="mt-3">
            <Link
              href={`/${locale}/guide/start`}
              prefetch={false}
              className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline"
            >
              {c.startLinkLabel} →
            </Link>
          </p>
        </Section>

        <Section title={c.promoTitle}>
          <BulletList
            items={c.promoBullets}
            marker="•"
            markerClassName="text-emerald-600"
          />
          <p className="mt-4 rounded-xl bg-blue-50 px-4 py-3 text-sm leading-relaxed text-slate-700 ring-1 ring-blue-100">
            💡 {c.promoPoint}
          </p>
        </Section>

        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 className="text-lg font-bold text-emerald-900">{c.ctaTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.ctaBody}
          </p>
          <Link
            href={`/${locale}/create?tab=profile`}
            prefetch={false}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
          >
            {c.ctaLabel}
          </Link>
        </section>

        <p className="mt-10 text-xs leading-relaxed text-slate-400">
          {c.disclaimer}
        </p>
      </article>
    </AppShell>
  );
}
