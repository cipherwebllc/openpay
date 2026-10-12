// 料金ページの「払う人」のピル (server の部品と client の計算機で共用)。
// LandingSupport の負担者ピルと同じ配色 (お店 = emerald / お客様側 = blue)。どちらもあり得るときは slate。
// 色だけに頼らず、ピルの文字で払う人を書く。

import type { PricingPayer, PricingPayerTone } from '@/lib/pricing';

export const PAYER_TONE: Record<PricingPayerTone, { pill: string; focal: string }> = {
  shop: { pill: 'bg-emerald-50 text-emerald-800 ring-emerald-200/70', focal: 'text-emerald-600' },
  customer: { pill: 'bg-blue-50 text-blue-800 ring-blue-200/70', focal: 'text-blue-600' },
  either: { pill: 'bg-slate-100 text-slate-700 ring-slate-200', focal: 'text-slate-700' },
};

export function PayerPill({ payer }: { payer: PricingPayer }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${PAYER_TONE[payer.tone].pill}`}
    >
      {payer.label}
    </span>
  );
}
