// /guide/pos: 「無料POS × OpenPay 手動2台持ち」店舗向け運用ガイド。
//
// content SOT は lib/posGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/explore.ts / lib/news.ts と同じ。図版は public/guide/*.svg を後日配置
// (docs/guides/pos-combo-image-prompts.md の Codex 発注で生成)。未配置のあいだは
// プレースホルダ枠を描画して 404 を出さない。
//
// SEO 価値がある集客コンテンツなので noindex は設定しない (explore と同方針)。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { guideContentFor, type GuideImage } from '@/lib/posGuide';

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
  const dims = FIGURE_DIMS[image.file] ?? { w: 1200, h: 720 };
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
            <ul className="mt-3 space-y-2">
              {c.canDo.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-sm leading-relaxed text-slate-700"
                >
                  <span aria-hidden className="mt-0.5 text-emerald-600">
                    ✓
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              {c.cannotTitle}
            </h2>
            <ul className="mt-3 space-y-2">
              {c.cannot.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-sm leading-relaxed text-slate-700"
                >
                  <span aria-hidden className="mt-0.5 text-slate-400">
                    •
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* 必要なもの */}
        <section className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">{c.needTitle}</h2>
          <ul className="mt-3 space-y-2">
            {c.need.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-sm leading-relaxed text-slate-700"
              >
                <span aria-hidden className="mt-0.5 text-emerald-600">
                  •
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* 仕組み */}
        <section className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">
            {c.overviewTitle}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.overviewBody}
          </p>
          <GuideFigure image={c.overviewImage} />
        </section>

        {/* STEP 0 準備 */}
        <section className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">{c.setupTitle}</h2>
          <ol className="mt-4 space-y-4">
            {c.setupSteps.map((step) => (
              <li key={step.n} className="flex items-start gap-3">
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-700">
                  {step.n}
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {step.title}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-slate-700">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <GuideFigure image={c.setupImage} />
        </section>

        {/* 毎回の会計フロー */}
        <section className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">{c.flowTitle}</h2>
          <ol className="mt-4 space-y-4">
            {c.flowSteps.map((step) => (
              <li key={step.n} className="flex items-start gap-3">
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white">
                  {step.n}
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {step.title}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-slate-700">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <GuideFigure image={c.flowImage} />
          <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
            {c.safetyNote}
          </p>
          <GuideFigure
            image={c.successImage}
            caption={c.successCaption}
            className="mx-auto mt-6 max-w-[260px]"
          />
        </section>

        {/* 閉店後の突合 */}
        <section className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">
            {c.reconcileTitle}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.reconcileBody}
          </p>
          <ul className="mt-3 space-y-2">
            {c.reconcileBullets.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-sm leading-relaxed text-slate-700"
              >
                <span aria-hidden className="mt-0.5 text-emerald-600">
                  •
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <GuideFigure image={c.reconcileImage} />
        </section>

        {/* おすすめ無料POS (アフィリエイト枠) */}
        <section className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">{c.posTitle}</h2>
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
        </section>

        {/* コスト比較 */}
        <section className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">{c.costTitle}</h2>
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
        </section>

        {/* FAQ */}
        <section className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">{c.faqTitle}</h2>
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
        </section>

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
