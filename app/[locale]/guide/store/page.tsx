// /guide/store: 「無料サービスで始めるデジタル商品販売」クリエイター向けガイド。
//
// content SOT は lib/storeGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/agentGuide.ts / lib/posGuide.ts / lib/mobileOrderGuide.ts と同じ。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { BulletList, Section } from '@/components/guide/PosGuidePieces';
import { storeGuideContentFor, storeGuideMetadata } from '@/lib/storeGuide';

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
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {c.title}
          </h1>
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
                  <BulletList
                    items={section.bullets}
                    marker="✓"
                    markerClassName="text-emerald-600"
                  />
                ) : null}
              </div>
            ))}
          </div>
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
