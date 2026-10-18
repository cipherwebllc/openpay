// ガイドの利用料の欄 (plans/guide-ux-polish.md フェーズ 3)。料率 (focal) と名前は常に見せ、説明はたたむ。
// 文言は掟 14 フェンス済みの messages (Landing.supportFee*) をそのまま渡す (開示の文は消さない・たたむだけ)。
// 末尾に料金ページ (/pricing) への入口を置く (機能ごとの料金と計算例は料金ページが正)。

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { GuideDisclosure, GuideDisclosureGroup } from '@/components/guide/GuideDisclosure';

export type GuideFeeItem = { readonly focal: string; readonly title: string; readonly body: string };

export function GuideFeeList({
  items,
  note,
  pricingHref,
  pricingLabel,
}: {
  items: readonly GuideFeeItem[];
  note: string;
  pricingHref: string;
  pricingLabel: string;
}) {
  return (
    <>
      {/* 複数の場合は 1 枚の箱に区切り線で並べる (store・sell と同じ GuideDisclosureGroup・P6)。 */}
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
