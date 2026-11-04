// ガイドの利用料の欄 (plans/guide-ux-polish.md フェーズ 3)。料率 (focal) と名前は常に見せ、説明はたたむ。
// 文言は掟 14 フェンス済みの messages (Landing.supportFee*) をそのまま渡す (開示の文は消さない・たたむだけ)。
// 末尾に料金ページ (/pricing) への入口を置く (機能ごとの料金と計算例は料金ページが正)。

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { GuideDisclosure, GuideDisclosureGroup } from '@/components/guide/GuideDisclosure';

export type GuideFeeItem = { readonly focal: string; readonly title: string; readonly body: string };

export function GuideFeeList({
  items,
  note,
  pricingHref,
  pricingLabel,
  expanded = false,
  children,
}: {
  items: readonly GuideFeeItem[];
  note: string;
  pricingHref: string;
  pricingLabel: string;
  /**
   * true: 説明をたたまずに見せる (説明が 1〜2 文と短く、選ぶときに比べて読む欄・注文リンク)。名前を左・料率を右に置き、
   * 「名前: 料率」と読ませる (「なし 通常決済」を「通常決済なし」と読み違えない)。
   */
  expanded?: boolean;
  /** 箱のすぐ下 (共通の注記の前) に置く、この機能だけの補足 (1 回の上限など)。 */
  children?: ReactNode;
}) {
  return (
    <>
      {expanded ? (
        <ul className="mt-4 divide-y divide-slate-100 rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
          {items.map((item) => (
            <li key={item.title} className="px-4 py-4 sm:px-5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-bold text-slate-900 sm:text-base">{item.title}</h3>
                <span className="shrink-0 text-xl font-bold tabular-nums text-slate-900">{item.focal}</span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">{item.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        // 複数の場合は 1 枚の箱に区切り線で並べる (store・sell と同じ GuideDisclosureGroup・P6)。
        <GuideDisclosureGroup>
          {items.map((item) => (
            <GuideDisclosure
              key={item.title}
              summary={
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-xl font-bold tabular-nums text-slate-900">{item.focal}</span>
                  <h3 className="text-sm font-bold text-slate-900 sm:text-base">{item.title}</h3>
                </div>
              }
            >
              <p className="text-sm leading-relaxed text-slate-600">{item.body}</p>
            </GuideDisclosure>
          ))}
        </GuideDisclosureGroup>
      )}
      {children}
      <p className="mt-3 text-sm leading-relaxed text-slate-600">{note}</p>
      <Link
        href={pricingHref}
        prefetch={false}
        className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-emerald-700 hover:text-emerald-900"
      >
        {pricingLabel}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </>
  );
}
