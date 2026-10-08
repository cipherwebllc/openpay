// 任意の項目のまとまり (モバイル注文: 画像・店舗情報・SNS・受付時間 / プロフ: 見た目・SNS・リンク 等)。
// 閉じて置き、入れた数を見出しの右に出す (必要な人だけが開く・入れた人は中身があることが分かる)。

import type { ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';

export function OptionalGroup({
  icon: Icon,
  title,
  filled,
  filledLabel,
  groupId,
  children,
}: {
  icon: LucideIcon;
  title: string;
  /** 入力済みの項目数 (0 なら何も出さない)。 */
  filled: number;
  filledLabel: (count: number) => string;
  /** 中身を role=group で括るときの見出し id (任意)。 */
  groupId?: string;
  children: ReactNode;
}) {
  return (
    <details className="group/opt rounded-xl border border-slate-200">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
        <Icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        <span id={groupId} className="min-w-0 flex-1">{title}</span>
        {filled > 0 ? (
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
            {filledLabel(filled)}
          </span>
        ) : null}
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open/opt:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-4 border-t border-slate-100 px-3 pb-3 pt-3">{children}</div>
    </details>
  );
}
