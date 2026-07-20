// /guide/mobile-order: 「モバイルオーダーのやり方」お客様向けガイド (5 ステップ + 実機スクショ)。
//
// content SOT は lib/mobileOrderGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/agentGuide.ts / lib/posGuide.ts と同じ。手順画像は public/guide/mobile-order/ の実機
// スクリーンショット (サンプル店舗と同一メニューの実描画)。
//
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/pos・guide/agent と同方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { BulletList, Section } from '@/components/guide/PosGuidePieces';
import { StepShot } from '@/components/guide/MobileOrderGuidePieces';
import {
  mobileOrderGuideContentFor,
  mobileOrderGuideMetadata,
} from '@/lib/mobileOrderGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return mobileOrderGuideMetadata(locale);
}

export default async function GuideMobileOrderPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = mobileOrderGuideContentFor(locale);

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

        <Section title={c.needTitle}>
          <BulletList items={c.need} marker="✓" markerClassName="text-emerald-600" />
        </Section>

        <Section title={c.stepsTitle}>
          <ol className="mt-6 space-y-10">
            {c.steps.map((step) => (
              <StepShot key={step.n} step={step} />
            ))}
          </ol>
        </Section>

        <Section title={c.faqTitle}>
          <dl className="mt-4 space-y-5">
            {c.faq.map((f) => (
              <div key={f.q}>
                <dt className="text-sm font-semibold text-slate-900">{f.q}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-slate-700">
                  {f.a}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        {/* サンプル店舗 CTA (外部同一オリジンの @handle ページ) */}
        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 className="text-lg font-bold text-emerald-900">{c.tryTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.tryBody}
          </p>
          <a
            href={c.tryUrl}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
          >
            {c.tryCta}
          </a>
        </section>

        <Section title={c.relatedTitle}>
          <p className="mt-3 text-sm">
            <Link
              href={`/${locale}/guide/agent`}
              prefetch={false}
              className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
            >
              {c.relatedAgentGuide}
            </Link>
          </p>
        </Section>
      </article>
    </AppShell>
  );
}
