// 料金ページ (/pricing) の部品。page.tsx に規定外の export を作らないため部品に分ける (掟 3)。
// hook / next-intl を使わない同期の server 部品 (jsdom で描画テストできる)。計算機だけは client
// (components/pricing/PricingCalculator.tsx)。
//
// 見た目の方針 (迷わない・疲れない):
// - 冒頭の 4 枚のカードで「いつ・いくら・だれが」を先に答える (LP の利用料カードと同じ配色とビッグナンバー)。
// - 機能ごとの料金は 1 枚の面に行を並べる。md 以上は表のように列をそろえ (見出しの行は見た目だけ)、
//   スマホは各行の中で「通常決済 / ガスレス決済 / 払う人」を縦に並べる。DOM は 1 つ (dl)。
// - 説明の文は「くわしく」(details) にたたむ。値そのもの (料率・払う人) は常に見せる。
// aria-label は付けない (名前はすべて可視テキスト・掟 8)。アイコンは aria-hidden。

import {
  ArrowRightLeft,
  ChevronDown,
  Coins,
  Fuel,
  QrCode,
  ShoppingBag,
  Smartphone,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { PAYER_TONE, PayerPill } from '@/components/pricing/PayerPill';
import type {
  PricingPayer,
  PricingRow,
  PricingRowId,
  PricingSummaryCase,
  PricingSummaryId,
  PricingValue,
} from '@/lib/pricing';

// LP の利用料カード (components/LandingSupport.tsx) と同じアイコン。お店がガス代を肩代わりは Fuel。
const ROW_ICONS: Record<PricingRowId, LucideIcon> = {
  pay: QrCode,
  mobile: Smartphone,
  tip: Coins,
  store: ShoppingBag,
  storeGas: Fuel,
};

const SUMMARY_ICONS: Record<PricingSummaryId, LucideIcon> = {
  gasless: Zap,
  mobile: Smartphone,
  tip: Coins,
  digital: ShoppingBag,
};

/** 冒頭の「料金がかかるのは、この 4 つだけ」のカード。 */
export function SummaryCard({ item }: { item: PricingSummaryCase }) {
  const Icon = SUMMARY_ICONS[item.id];
  return (
    <li className="flex flex-col rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900 sm:text-base">
          <Icon className="h-5 w-5 shrink-0 text-brand" aria-hidden />
          <span className="min-w-0">{item.name}</span>
        </h3>
        <PayerPill payer={item.payer} />
      </div>
      <p className="mt-3 text-xs font-medium text-slate-500">{item.feeName}</p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* 「約 2 JPYC」のような長い値は 1 段小さくし、「1%」より面積で勝たないようにする (視線の優先を料率に)。 */}
        <span
          className={`font-extrabold leading-none tracking-tight tabular-nums ${
            item.focal.length > 4 ? 'text-3xl' : 'text-4xl'
          } ${PAYER_TONE[item.payer.tone].focal}`}
        >
          {item.focal}
        </span>
        {item.focalSub ? (
          <span className="text-sm font-semibold text-slate-600">{item.focalSub}</span>
        ) : null}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{item.detail}</p>
    </li>
  );
}

const TRUST_ICONS: readonly LucideIcon[] = [Fuel, ArrowRightLeft];

/** ガス代は別・代金は直接届く (2 つの短い文)。 */
export function TrustList({ items }: { items: readonly string[] }) {
  return (
    <ul className="grid grid-cols-1 gap-2.5 rounded-2xl bg-slate-50 px-4 py-3.5 ring-1 ring-inset ring-slate-200/70 sm:grid-cols-2 sm:gap-6 sm:px-5">
      {items.map((item, index) => {
        const Icon = TRUST_ICONS[index % TRUST_ICONS.length];
        return (
          <li key={item} className="flex gap-2.5 text-sm leading-relaxed text-slate-600">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <span>{item}</span>
          </li>
        );
      })}
    </ul>
  );
}

// 表の列の幅 (見出しの行と各行で同じ値を使い、md 以上で列をそろえる)。
const ROW_GRID = 'md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]';
const CELL_GRID = 'md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,1fr)]';

// 「なし」「提供なし」は料金がかからない (払うものがない) ので、料金の値より弱く見せる。
function isNone(value: string): boolean {
  return /^(なし|提供なし|None|Not offered)$/.test(value);
}

function ValueList({ values }: { values: readonly PricingValue[] }) {
  return (
    <ul className="space-y-1">
      {values.map((value) => (
        <li key={`${value.rail}:${value.value}`} className="flex flex-wrap items-baseline gap-x-2 text-sm leading-snug">
          {value.rail ? <span className="text-xs font-medium text-slate-500">{value.rail}</span> : null}
          <span className={isNone(value.value) ? 'font-medium text-slate-500' : 'font-semibold text-slate-900'}>
            {value.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PayerCell({ payers }: { payers: readonly PricingPayer[] }) {
  return (
    <ul className="space-y-1.5">
      {payers.map((payer) => (
        <li key={`${payer.label}:${payer.note}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <PayerPill payer={payer} />
          {payer.note ? <span className="text-xs text-slate-500">{payer.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** md 以上で見せる見出しの行 (見た目だけ・読み上げは各行の dt が担う)。 */
export function FeeTableHead({
  colFeature,
  dtStandard,
  dtStandardDef,
  dtGasless,
  dtGaslessDef,
  dtPayer,
}: {
  colFeature: string;
  dtStandard: string;
  dtStandardDef: string;
  dtGasless: string;
  dtGaslessDef: string;
  dtPayer: string;
}) {
  return (
    <div
      aria-hidden
      className={`hidden gap-4 border-b border-slate-200 pb-3 pl-5 pr-28 pt-4 text-xs font-semibold text-slate-700 md:grid ${ROW_GRID}`}
    >
      <span>{colFeature}</span>
      <span className={`grid gap-4 ${CELL_GRID}`}>
        <span>
          {dtStandard}
          <span className="block font-normal text-slate-500">{dtStandardDef}</span>
        </span>
        <span>
          {dtGasless}
          <span className="block font-normal text-slate-500">{dtGaslessDef}</span>
        </span>
        <span>{dtPayer}</span>
      </span>
    </div>
  );
}

export function FeeRow({
  row,
  dtStandard,
  dtGasless,
  dtPayer,
  detailsLabel,
}: {
  row: PricingRow;
  dtStandard: string;
  dtGasless: string;
  dtPayer: string;
  detailsLabel: string;
}) {
  const Icon = ROW_ICONS[row.id];
  const cells = [
    { dt: dtStandard, dd: <ValueList values={row.standard} /> },
    { dt: dtGasless, dd: <ValueList values={row.gasless} /> },
    { dt: dtPayer, dd: <PayerCell payers={row.payers} /> },
  ];
  return (
    <li className="relative px-4 pb-2 pt-4 sm:px-5 md:pb-4 md:pr-28">
      {/* base の grid-cols-1 は必須 (スマホで横にはみ出さない)。 */}
      <div className={`grid grid-cols-1 gap-3 md:gap-4 ${ROW_GRID}`}>
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Icon className="h-5 w-5 shrink-0 text-brand" aria-hidden />
            {row.name}
          </h3>
          {row.scope ? <p className="mt-1 text-xs leading-relaxed text-slate-500 md:pl-7">{row.scope}</p> : null}
        </div>
        <dl className={`grid grid-cols-1 gap-2.5 md:gap-4 ${CELL_GRID}`}>
          {cells.map((cell) => (
            <div key={cell.dt} className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 md:block">
              <dt className="text-xs font-semibold text-slate-500 md:sr-only">{cell.dt}</dt>
              <dd className="min-w-0">{cell.dd}</dd>
            </div>
          ))}
        </dl>
      </div>
      <details className="group md:static">
        {/* スマホは行の末尾 (押した所のすぐ下に中身が出る)。md 以上は行の右上 (li の pr-28 で列と重ならない)。
            色は灰: 緑は「お店が払う」の色なので、リンクの意味と混ぜない。 */}
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900 md:absolute md:right-5 md:top-3 [&::-webkit-details-marker]:hidden">
          {detailsLabel}
          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <ul className="mb-2 space-y-2 border-l-2 border-slate-200 pl-3 text-sm leading-relaxed text-slate-600 md:mb-0 md:mt-3 md:ml-7">
          {row.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** 「このほかの場合」: 見出しだけを並べ、本文はたたむ。 */
export function OtherCases({ titles, bodies }: { titles: readonly string[]; bodies: readonly string[] }) {
  return (
    <ul className="divide-y divide-slate-100 rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
      {titles.map((title, index) => (
        <li key={title}>
          <details className="group">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50 sm:px-5 sm:text-base [&::-webkit-details-marker]:hidden">
              {title}
              <ChevronDown className="h-5 w-5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <p className="px-4 pb-4 text-sm leading-relaxed text-slate-600 sm:px-5">{bodies[index]}</p>
          </details>
        </li>
      ))}
    </ul>
  );
}
