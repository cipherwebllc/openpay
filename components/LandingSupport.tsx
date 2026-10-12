// トップの料金の節 (料金がかかる 4 つの場合)。Server Component。「はじめ方」の後・FAQ の前に置く。
//
// 料金ページ (/pricing) の冒頭と同じ「料金がかかる 4 つの場合」のカード (lib/pricing.ts の summary・料率は
// lib/legal.ts の DISCLOSED_* から) と、料金ページへの入口だけを出す (2026-10-12 user 裁定)。
// 運営の応援カードは締め (LandingTrust の LandingSupportCard) に移した。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight } from 'lucide-react';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';
import { SummaryCard } from '@/components/pricing/PricingPieces';
import { pricingContentFor } from '@/lib/pricing';

export async function LandingSupport() {
  const t = await getTranslations('Landing');
  const locale = await getLocale();
  const pricing = pricingContentFor(locale);

  return (
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader eyebrow={t('eyebrowPricing')} title={pricing.summaryTitle} lead={pricing.lead} />

      {/* 料金がかかる 4 つの場合 (料金ページ /pricing の冒頭と同じカード・料率は lib/legal.ts の DISCLOSED_* から)。
          機能ごとの説明と計算例は料金ページに任せる (2026-10-12 user 裁定: トップは 4 つの場合 + 料金ページへの入口)。 */}
      <ul className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        {pricing.summary.map((item) => (
          <SummaryCard key={item.id} item={item} />
        ))}
      </ul>

      <p className="mx-auto mt-6 max-w-2xl text-center text-xs leading-relaxed text-slate-500">
        {t('supportFeeNote')}
      </p>
      {/* 機能ごとの料金と計算例 (/pricing) への入口 (plans/pricing-page.md §2.6)。
          リンク名は可視テキストだけ (矢印は aria-hidden・掟 8)。min-h-11 で tap target 44px (WCAG 2.5.8)。 */}
      <p className="mt-2 text-center">
        <Link
          href={`/${locale}/pricing`}
          prefetch={false}
          className="group inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand underline-offset-2 hover:underline"
        >
          {t('supportFeeDetailsLink')}
          <ArrowRight aria-hidden className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </p>
    </section>
  );
}
