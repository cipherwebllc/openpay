// ガイドの注意書き・ヒントの囲み (plans/guide-ux-polish.md フェーズ 3)。以前はページごとに 4 種の実装と
// 絵文字のアイコン (💡・⚠️: OS で見た目が変わり、読み上げで「電球」と読まれる) が混ざっていた。
// アイコンは lucide で aria-hidden。aria-label は使わない (掟 8)。

import type { ReactNode } from 'react';
import { Info, Lightbulb, TriangleAlert, type LucideIcon } from 'lucide-react';

const KINDS: Record<'tip' | 'warn' | 'info', { box: string; icon: LucideIcon; iconTone: string }> = {
  // tip は中立の灰色 + 電球 (青は「お客様の手順」の色に取っておく・P7)。info とは記号で見分ける。
  tip: { box: 'bg-slate-50 text-slate-700 ring-slate-200/70', icon: Lightbulb, iconTone: 'text-amber-500' },
  warn: { box: 'bg-amber-50 text-amber-950 ring-amber-200', icon: TriangleAlert, iconTone: 'text-amber-600' },
  info: { box: 'bg-slate-50 text-slate-700 ring-slate-200/70', icon: Info, iconTone: 'text-slate-500' },
};

export function GuideCallout({
  kind,
  children,
  className,
}: {
  kind: 'tip' | 'warn' | 'info';
  children: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon, iconTone } = KINDS[kind];
  return (
    // 文字は本文と同じ大きさ (注意書きは本文の中でいちばん大事な行のため)。
    <div className={`flex gap-3 rounded-xl px-4 py-3 text-[15px] leading-7 ring-1 sm:text-[16px] ${box} ${className ?? 'mt-4'}`}>
      <Icon className={`mt-1.5 h-4 w-4 shrink-0 ${iconTone}`} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
