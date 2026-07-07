// /guide/pos: 「無料POS × OpenPay 手動2台持ち」店舗向け運用ガイド。
//
// content SOT は lib/posGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/explore.ts / lib/news.ts と同じ。図版は public/guide/*.svg を素の <img> で描画する。
// 描画ヘルパは components/guide/PosGuidePieces.tsx に分離 (実描画テスト可能)。
//
// SEO 価値がある集客コンテンツなので noindex は設定しない (explore と同方針)。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import {
  BulletList,
  GuideFigure,
  Section,
  StepList,
} from '@/components/guide/PosGuidePieces';
import { guideContentFor, guidePosMetadata } from '@/lib/posGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return guidePosMetadata(locale);
}

export default async function GuidePosPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = guideContentFor(locale);

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
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.audience}
          </p>
        </header>

        <GuideFigure image={c.heroImage} />

        {/* できること / できないこと */}
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-emerald-200/70">
            <h2 className="text-base font-semibold text-emerald-900">
              {c.canDoTitle}
            </h2>
            <BulletList
              items={c.canDo}
              marker="✓"
              markerClassName="text-emerald-600"
            />
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
            <h2 className="text-base font-semibold text-slate-900">
              {c.cannotTitle}
            </h2>
            <BulletList
              items={c.cannot}
              marker="•"
              markerClassName="text-slate-400"
            />
          </section>
        </div>

        <Section title={c.needTitle}>
          <BulletList
            items={c.need}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        <Section title={c.overviewTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.overviewBody}
          </p>
          <GuideFigure image={c.overviewImage} />
        </Section>

        <Section title={c.setupTitle}>
          <StepList
            steps={c.setupSteps}
            badgeClassName="bg-emerald-100 text-emerald-700"
          />
          <GuideFigure image={c.setupImage} />
        </Section>

        <Section title={c.flowTitle}>
          <StepList
            steps={c.flowSteps}
            badgeClassName="bg-emerald-600 text-white"
          />
          <GuideFigure image={c.flowImage} />
          <p className="rounded-xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900 ring-1 ring-amber-200">
            {c.safetyNote}
          </p>
          <GuideFigure
            image={c.successImage}
            caption={c.successCaption}
            className="mx-auto mt-6 max-w-[260px]"
          />
        </Section>

        <Section title={c.reconcileTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.reconcileBody}
          </p>
          <BulletList
            items={c.reconcileBullets}
            marker="•"
            markerClassName="text-emerald-600"
          />
          <GuideFigure image={c.reconcileImage} />
        </Section>

        <Section title={c.posTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.posBody}
          </p>
          {/* アフィリエイト承認後: 各 POS のリンク/バナーをここに設置し、
              affiliate リンクには c.affiliateAdLabel (「広告」/「Ad」) を併記 +
              rel="sponsored" を付す (景表法ステマ規制対応・lib/explore.ts と同思想)。
              承認前は非広告の参考列挙にとどめる (リンクなし)。 */}
          <ul className="mt-3 flex flex-wrap gap-2">
            {c.posExamples.map((name) => (
              <li
                key={name}
                className="rounded-full bg-white px-3 py-1 text-sm text-slate-700 shadow-card ring-1 ring-slate-200/70"
              >
                {name}
              </li>
            ))}
          </ul>
          {/* POS アフィリエイト (承認済)。景表法 (ステマ規制) 対応で affiliateAdLabel「広告」を
              併記し、rel="sponsored nofollow" + target=_blank で開く (lib/explore.ts と同思想)。 */}
          <div className="mt-4 rounded-xl bg-emerald-50/60 p-4 ring-1 ring-emerald-200/70">
            <div className="flex items-center gap-2">
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                {c.affiliateAdLabel}
              </span>
              <span className="text-sm font-semibold text-slate-900">
                {c.posAffiliate.name}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">
              {c.posAffiliate.blurb}
            </p>
            <a
              href={c.posAffiliate.href}
              target="_blank"
              rel="sponsored nofollow noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
            >
              {c.posAffiliate.cta}
              <span aria-hidden>→</span>
            </a>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.posCaveat}
          </p>
        </Section>

        <Section title={c.costTitle}>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th className="py-2 pr-3 font-medium text-slate-500" />
                  <th className="py-2 pr-3 font-semibold text-slate-700">
                    {c.costColCard}
                  </th>
                  <th className="py-2 font-semibold text-emerald-800">
                    {c.costColOpenpay}
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.costRows.map((row) => (
                  <tr
                    key={row.label}
                    className="border-b border-slate-100 align-top"
                  >
                    <th
                      scope="row"
                      className="py-3 pr-3 text-left font-medium text-slate-600"
                    >
                      {row.label}
                    </th>
                    <td className="py-3 pr-3 leading-relaxed text-slate-600">
                      {row.card}
                    </td>
                    <td className="py-3 leading-relaxed text-slate-800">
                      {row.openpay}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-900 ring-1 ring-emerald-200/70">
            {c.feeNote}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.costNote}
          </p>
          <GuideFigure image={c.costImage} />
        </Section>

        <Section title={c.faqTitle}>
          <dl className="mt-4 space-y-5">
            {c.faqs.map((f) => (
              <div key={f.q}>
                <dt className="text-sm font-semibold text-slate-900">{f.q}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-slate-700">
                  {f.a}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        {/* CTA */}
        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 className="text-lg font-bold text-emerald-900">{c.ctaTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.ctaBody}
          </p>
          <Link
            href={`/${locale}${c.ctaButtonHref}`}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
          >
            {c.ctaButton}
          </Link>
        </section>
      </article>
    </AppShell>
  );
}
