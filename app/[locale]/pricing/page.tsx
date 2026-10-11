// /pricing: 機能ごとの OpenPay の料金・払う人・計算例 (plans/pricing-page.md)。
//
// 本文は lib/pricing.ts (ja/en 同梱・数字は lib/legal.ts の DISCLOSED_* から差し込む)。
// 計算例は lib/pricingExamples.ts (実際の分け方と同じ式)。部品は components/pricing/PricingPieces.tsx。
// 掟 3: default / generateMetadata 以外を export しない。リンクはすべて prefetch={false}。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { BulletList, Section } from '@/components/guide/PosGuidePieces';
import { ExampleTable, FeeCard } from '@/components/pricing/PricingPieces';
import { pricingContentFor, pricingMetadata } from '@/lib/pricing';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return pricingMetadata(locale);
}

const LINK_CLASS =
  'font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900';

export default async function PricingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const content = pricingContentFor(locale);
  const [termsLink, tokuteiLink] = content.termsLinks;

  return (
    <AppShell>
      <article className="mx-auto max-w-4xl">
        <Link
          href={`/${locale}`}
          prefetch={false}
          className="text-sm font-medium text-emerald-700 hover:text-emerald-900"
        >
          {content.backHome}
        </Link>

        <header className="mt-4">
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{content.title}</h1>
          <p className="mt-4 text-base leading-relaxed text-slate-800">{content.lead}</p>
          <BulletList items={content.cases} marker="•" markerClassName="text-emerald-600" />
          <p className="mt-4 text-sm leading-relaxed text-slate-700">{content.storeGasNote}</p>
          <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700 ring-1 ring-slate-200">
            {content.aside}
          </p>
        </header>

        <Section title={content.feesTitle}>
          {/* base の grid-cols-1 は必須 (スマホで横にはみ出さない)。 */}
          <ul className="mt-4 grid grid-cols-1 gap-3">
            {content.rows.map((row) => (
              <FeeCard
                key={row.id}
                row={row}
                dtStandard={content.dtStandard}
                dtGasless={content.dtGasless}
                dtPayer={content.dtPayer}
              />
            ))}
          </ul>
        </Section>

        <Section title={content.examplesTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">{content.examplesLead}</p>
          {content.examples.map((table) => (
            <ExampleTable key={table.caption} table={table} />
          ))}
          <p className="mt-6 text-sm leading-relaxed text-slate-700">{content.storeGasExample}</p>
        </Section>

        <Section title={content.otherTitle}>
          <BulletList items={content.otherItems} marker="•" markerClassName="text-emerald-600" />
        </Section>

        <Section title={content.termsTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {content.termsBefore}
            <Link href={`/${locale}${termsLink.href}`} prefetch={false} className={LINK_CLASS}>
              {termsLink.label}
            </Link>
            {content.termsBetween}
            <Link href={`/${locale}${tokuteiLink.href}`} prefetch={false} className={LINK_CLASS}>
              {tokuteiLink.label}
            </Link>
            {content.termsAfter}
          </p>
        </Section>
      </article>
    </AppShell>
  );
}
