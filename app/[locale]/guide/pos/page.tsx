// /guide/pos: 「無料POS × OpenPay 手動2台持ち」店舗向け運用ガイド。
//
// content SOT は lib/posGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/explore.ts / lib/news.ts と同じ。図版は public/guide/*.svg を素の <img> で描画する。
//
// SEO 価値がある集客コンテンツなので noindex は設定しない (explore と同方針)。

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { guideContentFor, type GuideImage, type GuideStep } from '@/lib/posGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = guideContentFor(locale);
  return {
    title: `${c.metaTitle} · OpenPay`,
    description: c.metaDescription,
  };
}

// public/guide/<file> の SVG 図版の intrinsic 寸法 (CLS 防止の width/height 用)。
const FIGURE_DIMS: Record<string, { w: number; h: number }> = {
  'hero.svg': { w: 1200, h: 675 },
  'overview-flow.svg': { w: 1000, h: 320 },
  'pos-add-method.svg': { w: 760, h: 480 },
  'four-steps.svg': { w: 1100, h: 280 },
  'payment-success.svg': { w: 420, h: 720 },
  'history-reconcile.svg': { w: 1000, h: 420 },
  'cost-compare.svg': { w: 900, h: 360 },
};

// 標準セクション (mt-10 + 見出し)。カード型の できること/cannot・CTA は独自スタイルなので使わない。
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

// 箇条書き (できること=✓ / その他=•・マーカー色のみ可変)。
function BulletList({
  items,
  marker,
  markerClassName,
}: {
  items: readonly string[];
  marker: string;
  markerClassName: string;
}) {
  return (
    <ul className="mt-3 space-y-2">
      {items.map((item) => (
        <li
          key={item}
          className="flex items-start gap-2 text-sm leading-relaxed text-slate-700"
        >
          <span aria-hidden className={`mt-0.5 ${markerClassName}`}>
            {marker}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// 番号付きステップ (準備=淡色バッジ / 会計フロー=濃色バッジ・バッジ配色のみ可変)。
function StepList({
  steps,
  badgeClassName,
}: {
  steps: readonly GuideStep[];
  badgeClassName: string;
}) {
  return (
    <ol className="mt-4 space-y-4">
      {steps.map((step) => (
        <li key={step.n} className="flex items-start gap-3">
          <span
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${badgeClassName}`}
          >
            {step.n}
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-900">{step.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">
              {step.body}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// 静的 SVG 図版を描画 (最適化不要なので素の <img>・既存 HandleProfile 等と同方針)。
function GuideFigure({
  image,
  className,
  caption,
}: {
  image: GuideImage;
  className?: string;
  caption?: string;
}) {
  const dims = FIGURE_DIMS[image.file] ?? { w: 1200, h: 675 };
  return (
    <figure className={className ?? 'my-6'}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/guide/${image.file}`}
        alt={image.alt}
        width={dims.w}
        height={dims.h}
        loading="lazy"
        className="h-auto w-full rounded-2xl border border-slate-200 bg-white"
      />
      {caption ? (
        <figcaption className="mt-2 text-center text-xs leading-relaxed text-slate-500">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
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
          <section className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-emerald-900">
              {c.canDoTitle}
            </h2>
            <BulletList
              items={c.canDo}
              marker="✓"
              markerClassName="text-emerald-600"
            />
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
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

        {/* 必要なもの */}
        <Section title={c.needTitle}>
          <BulletList
            items={c.need}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        {/* 仕組み */}
        <Section title={c.overviewTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.overviewBody}
          </p>
          <GuideFigure image={c.overviewImage} />
        </Section>

        {/* STEP 0 準備 */}
        <Section title={c.setupTitle}>
          <StepList
            steps={c.setupSteps}
            badgeClassName="bg-emerald-100 text-emerald-700"
          />
          <GuideFigure image={c.setupImage} />
        </Section>

        {/* 毎回の会計フロー */}
        <Section title={c.flowTitle}>
          <StepList
            steps={c.flowSteps}
            badgeClassName="bg-emerald-600 text-white"
          />
          <GuideFigure image={c.flowImage} />
          <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
            {c.safetyNote}
          </p>
          <GuideFigure
            image={c.successImage}
            caption={c.successCaption}
            className="mx-auto mt-6 max-w-[260px]"
          />
        </Section>

        {/* 閉店後の突合 */}
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

        {/* おすすめ無料POS (アフィリエイト枠) */}
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
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-sm text-slate-700"
              >
                {name}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.posCaveat}
          </p>
        </Section>

        {/* コスト比較 */}
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
          <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-900">
            {c.feeNote}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.costNote}
          </p>
          <GuideFigure image={c.costImage} />
        </Section>

        {/* FAQ */}
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
        <section className="mt-12 rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
          <h2 className="text-lg font-bold text-emerald-900">{c.ctaTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.ctaBody}
          </p>
          <Link
            href={`/${locale}${c.ctaButtonHref}`}
            className="mt-4 inline-flex items-center justify-center rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            {c.ctaButton}
          </Link>
        </section>
      </article>
    </AppShell>
  );
}
