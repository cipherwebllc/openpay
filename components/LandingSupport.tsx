// トップの料金の節 (料金がかかる 5 つの場合)。Server Component。「はじめ方」の後・FAQ の前に置く。
//
// 料金ページ (/pricing) の冒頭と同じ「料金がかかる 5 つの場合」のカード (lib/pricing.ts の summary・料率は
// lib/legal.ts の DISCLOSED_* から) と、料金ページへの入口だけを出す (2026-10-12 user 裁定)。
// 運営の応援カードは締め (LandingTrust の LandingSupportCard) に移した。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight } from 'lucide-react';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';
import { SummaryCard } from '@/components/pricing/PricingPieces';
import { pricingContentFor } from '@/lib/pricing';
import { LANDING_LINK_ARROW, LANDING_NOTE_CENTERED, LANDING_TEXT_LINK } from '@/components/LandingControls';
import { phrased } from '@/components/Phrased';

export async function LandingSupport() {
  const t = await getTranslations('Landing');
  const locale = await getLocale();
  const pricing = pricingContentFor(locale);

  return (
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader
        eyebrow={t('eyebrowPricing')}
        title={phrased(pricing.summaryTitle, locale)}
        lead={phrased(pricing.lead, locale)}
      />

      {/* 料金がかかる 5 つの場合 (料金ページ /pricing の冒頭と同じカード・料率は lib/legal.ts の DISCLOSED_* から)。
          機能ごとの説明と計算例は料金ページに任せる (2026-10-12 user 裁定: トップは料金がかかる場合 + 料金ページへの入口)。
          5 つ目の「売上をほかのウォレットへ移す」は 2026-11-07 に足した (決済ではない・お店が払う利用料)。 */}
      <ul className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        {pricing.summary.map((item) => (
          <SummaryCard key={item.id} item={item} />
        ))}
      </ul>

      {/* カードに付く注 (注の型)。説明する対象のすぐ下に置く (上の空きは、ほかの注と同じ mt-3)。 */}
      <p className={`mt-3 ${LANDING_NOTE_CENTERED}`}>{phrased(t('supportFeeNote'), locale)}</p>
      {/* 機能ごとの料金と計算例 (/pricing) への入口 (plans/pricing-page.md §2.6)。
          文字リンクの型 (押せる高さ 44px・WCAG 2.5.8)。リンク名は可視テキストだけ (矢印は aria-hidden・掟 8)。 */}
      <p className="mt-2 text-center">
        <Link
          href={`/${locale}/pricing`}
          prefetch={false}
          className={LANDING_TEXT_LINK.brand}
        >
          {t('supportFeeDetailsLink')}
          <ArrowRight aria-hidden className={LANDING_LINK_ARROW} />
        </Link>
      </p>
    </section>
  );
}
