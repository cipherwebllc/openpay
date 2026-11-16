// 料金ページの「払う人」のピル (server の部品と client の計算機で共用)。
// LandingSupport の負担者ピルと同じ配色 (お店 = emerald / お客様側 = blue)。どちらもあり得るときは slate。
// 色だけに頼らず、ピルの文字で払う人を書く。
//
// focal = 料金の数字の色 (トップの導入メリット・料金のカード・料金ページの計算機が同じ値を使う)。白の上で 4.5:1 以上の濃さにする:
// 数字は 16px (計算機) まで小さくなり、トップの導入メリットの数字も狭い幅では縮むので、「大きい文字」の 3:1 では足りない。
// 緑は emerald-700 (白の上で 5.5:1)。emerald-600 は 3.8:1 で足りない。青は blue-600 (5.2:1)。
// tests/components/PayerPill.test.tsx がパレットの色から比を計算して固定する。

import type { PricingPayer, PricingPayerTone } from '@/lib/pricing';

export const PAYER_TONE: Record<PricingPayerTone, { pill: string; focal: string }> = {
  shop: { pill: 'bg-emerald-50 text-emerald-800 ring-emerald-200/70', focal: 'text-emerald-700' },
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
