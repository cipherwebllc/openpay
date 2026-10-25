// /pricing: 機能ごとの OpenPay の料金・払う人・計算例 (plans/pricing-page.md・plans/pricing-ux-polish.md)。
//
// 本文は lib/pricing.ts (ja/en 同梱・数字は lib/legal.ts の DISCLOSED_* から差し込む)。
// 計算機は components/pricing/PricingCalculator.tsx (client・式は lib/pricingMath.ts・料率はここで組み立てて渡す)。
// 部品は components/pricing/PricingPieces.tsx。
// 掟 3: default / generateMetadata 以外を export しない。リンクはすべて prefetch={false}。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { PricingCalculator } from '@/components/pricing/PricingCalculator';
import {
  FeeRow,
  FeeTableHead,
  OtherCases,
  SummaryCard,
  TrustList,
} from '@/components/pricing/PricingPieces';
import { PRICING_ROW_GROUPS, pricingContentFor, pricingMetadata } from '@/lib/pricing';
import { PRICING_EXAMPLE_AMOUNTS, disclosedPricingRates } from '@/lib/pricingExamples';

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

function SectionHeading({ id, title, lead }: { id: string; title: string; lead?: string }) {
  return (
    <div className="max-w-2xl">
      <h2 id={id} className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
        {title}
      </h2>
      {lead ? <p className="mt-2 text-sm leading-relaxed text-slate-600">{lead}</p> : null}
    </div>
  );
}

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
          className="inline-flex min-h-11 items-center text-sm font-medium text-emerald-700 hover:text-emerald-900"
        >
          {content.backHome}
        </Link>

        <header className="mt-2">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{content.title}</h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-700 sm:text-lg">{content.lead}</p>
        </header>

        <section aria-labelledby="pricing-summary" className="mt-8 sm:mt-10">
          <SectionHeading id="pricing-summary" title={content.summaryTitle} />
          {/* base の grid-cols-1 は必須 (スマホで横にはみ出さない)。 */}
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
            {content.summary.map((item) => (
              <SummaryCard key={item.id} item={item} />
            ))}
          </ul>
          <div className="mt-4">
            <TrustList items={content.trust} />
          </div>
        </section>

        <section aria-labelledby="pricing-calc" className="mt-14 sm:mt-16">
          <SectionHeading id="pricing-calc" title={content.calc.title} lead={content.calc.lead} />
          <div className="mt-5">
            <PricingCalculator
              copy={content.calc}
              rates={disclosedPricingRates()}
              presets={PRICING_EXAMPLE_AMOUNTS.gasless}
              defaultAmount={PRICING_EXAMPLE_AMOUNTS.preorderSplit}
            />
          </div>
        </section>

        <section aria-labelledby="pricing-fees" className="mt-14 sm:mt-16">
          <SectionHeading id="pricing-fees" title={content.feesTitle} lead={content.feesLead} />
          <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
            {/* lg より狭い幅では見出しの行が無いので、2 つの決済と「料金を払う人」の意味を表の上の帯に書く (lg 以上は見出しの行が見せる)。 */}
            <dl className="flex flex-wrap gap-x-4 gap-y-1 border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-xs text-slate-500 lg:sr-only">
              <div className="flex gap-1.5">
                <dt className="font-semibold text-slate-700">{content.dtStandard}</dt>
                <dd>{content.dtStandardDef}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="font-semibold text-slate-700">{content.dtGasless}</dt>
                <dd>{content.dtGaslessDef}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="font-semibold text-slate-700">{content.dtPayer}</dt>
                <dd>{content.dtPayerDef}</dd>
              </div>
            </dl>
            <FeeTableHead
              colFeature={content.colFeature}
              dtStandard={content.dtStandard}
              dtStandardDef={content.dtStandardDef}
              dtGasless={content.dtGasless}
              dtGaslessDef={content.dtGaslessDef}
              dtPayer={content.dtPayer}
              dtPayerDef={content.dtPayerDef}
            />
            {/* 払う人ごとのまとまり (お店 / チップを送る方 / デジタル商品・AI の買い手)。読む人が自分の行だけを見られる。 */}
            <ul className="divide-y divide-slate-100">
              {PRICING_ROW_GROUPS.map((group) => (
                <li key={group.id}>
                  <h3 className="bg-slate-50 px-4 py-2 text-xs font-bold tracking-wide text-slate-600 sm:px-5">
                    {content.rowGroupTitles[group.id]}
                  </h3>
                  <ul className="divide-y divide-slate-100">
                    {group.rowIds.map((rowId) => {
                      const row = content.rows.find((r) => r.id === rowId);
                      return row ? (
                        <FeeRow
                          key={row.id}
                          row={row}
                          dtStandard={content.dtStandard}
                          dtGasless={content.dtGasless}
                          dtPayer={content.dtPayer}
                          detailsLabel={content.detailsLabel}
                        />
                      ) : null;
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="pricing-other" className="mt-14 sm:mt-16">
          <SectionHeading id="pricing-other" title={content.otherTitle} />
          <div className="mt-4">
            <OtherCases titles={content.otherTitles} bodies={content.otherItems} />
          </div>
        </section>

        {/* 正確な条件は規約と特商法 (脚注)。 */}
        <footer className="mt-12 border-t border-slate-200 pt-6">
          <p className="text-sm leading-relaxed text-slate-600">
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
        </footer>
      </article>
    </AppShell>
  );
}
