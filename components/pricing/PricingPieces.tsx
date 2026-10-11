// 料金ページ (/pricing) の部品。page.tsx に規定外の export を作らないため部品に分ける (掟 3)。
// hook / next-intl を使わない同期の server 部品 (jsdom で描画テストできる)。
//
// 表の形 (plans/pricing-page.md §2.2 案 1): 機能ごとに 1 枚のカード (<li>) + 定義リスト (<dl>)。
// スマホは 1 列で上から読み、md 以上は各カードの中を同じ 3 列 grid にして表のように横に読める。DOM は 1 つ。
// 計算例だけは短い数字の <table> (3 列・<caption> + <th scope>)。横スクロールの包みは付けない。
// aria-label は付けない (名前はすべて可視テキスト・掟 8)。アイコンは aria-hidden。

import {
  Calculator,
  Coins,
  Fuel,
  QrCode,
  ShoppingBag,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';
import type {
  PricingExampleTable,
  PricingPayer,
  PricingPayerTone,
  PricingRow,
  PricingRowId,
} from '@/lib/pricing';

// LP の利用料カード (components/LandingSupport.tsx) と同じアイコン。お店がガス代を肩代わりは Fuel。
const ROW_ICONS: Record<PricingRowId, LucideIcon> = {
  pay: QrCode,
  register: Calculator,
  mobile: Smartphone,
  tip: Coins,
  store: ShoppingBag,
  storeGas: Fuel,
};

// LandingSupport の負担者ピルと同じ配色 (お店 = emerald / お客様側 = blue)。どちらもあり得るときは slate。
const PAYER_TONE: Record<PricingPayerTone, string> = {
  shop: 'bg-emerald-100 text-emerald-800',
  customer: 'bg-blue-100 text-blue-800',
  either: 'bg-slate-100 text-slate-800',
};

function PayerList({ payers }: { payers: readonly PricingPayer[] }) {
  return (
    <ul className="space-y-1.5">
      {payers.map((payer) => (
        <li key={`${payer.label}:${payer.note}`} className="text-sm leading-relaxed text-slate-700">
          <span
            className={`mr-1.5 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${PAYER_TONE[payer.tone]}`}
          >
            {payer.label}
          </span>
          {payer.note}
        </li>
      ))}
    </ul>
  );
}

export function FeeCard({
  row,
  dtStandard,
  dtGasless,
  dtPayer,
}: {
  row: PricingRow;
  dtStandard: string;
  dtGasless: string;
  dtPayer: string;
}) {
  const Icon = ROW_ICONS[row.id];
  return (
    <li className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 sm:p-5">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900">{row.name}</h3>
          {row.scope ? (
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{row.scope}</p>
          ) : null}
        </div>
      </div>
      {/* base の grid-cols-1 は必須 (スマホで横にはみ出さない)。md 以上は全カードで同じ列幅にそろえる。 */}
      <dl className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_13rem] md:gap-5">
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-slate-500">{dtStandard}</dt>
          <dd className="mt-1 text-sm leading-relaxed text-slate-700">{row.standard}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-slate-500">{dtGasless}</dt>
          <dd className="mt-1 text-sm leading-relaxed text-slate-700">{row.gasless}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-slate-500">{dtPayer}</dt>
          <dd className="mt-1">
            <PayerList payers={row.payers} />
          </dd>
        </div>
      </dl>
      {row.note ? (
        <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
          {row.note}
        </p>
      ) : null}
    </li>
  );
}

export function ExampleTable({ table }: { table: PricingExampleTable }) {
  return (
    <div className="mt-6 rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 sm:p-5">
      <table className="w-full text-sm">
        <caption className="pb-3 text-left text-sm font-semibold text-slate-900">
          {table.caption}
        </caption>
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-600">
            {table.headers.map((header, index) => (
              <th
                key={header}
                scope="col"
                className={`pb-2 font-semibold ${index === 0 ? 'pr-2 text-left' : 'px-2 text-right last:pr-0'}`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {table.rows.map(([first, second, third]) => (
            <tr key={first.text}>
              {/* 金額は「10,000 JPYC」の途中で折り返さない (390px でも 3 列の金額は 1 行に収まる)。 */}
              <th scope="row" className="whitespace-nowrap py-2 pr-2 text-left font-medium tabular-nums text-slate-900">
                {first.text}
              </th>
              {[second, third].map((cell, index) => (
                <td key={index} className="px-2 py-2 text-right tabular-nums text-slate-700 last:pr-0">
                  <span className="whitespace-nowrap">{cell.text}</span>
                  {cell.mark ? (
                    <span className="block text-xs text-slate-500">{cell.mark}</span>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.notes.map((note) => (
        <p key={note} className="mt-3 text-sm leading-relaxed text-slate-700">
          {note}
        </p>
      ))}
    </div>
  );
}
