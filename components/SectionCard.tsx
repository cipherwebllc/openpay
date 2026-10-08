// 番号なしのセクションカード (2026-10 磨き上げ: モバイル注文・チップ・プロフの ①〜④ を外す)。
// 見出しは決済QR・レジのカードと同じ小さな見出し (text-sm)・右に操作 (「設定」等) を置ける。
// headingId は見出しへのリンク (プロフのミニプレビュー「プレビューへ」等) とラベル付けに使う。

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function SectionCard({
  title,
  headingId,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  headingId: string;
  icon?: LucideIcon;
  /** 見出しの右に置く操作 (任意)。 */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 print:shadow-none print:ring-0"
    >
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          {Icon ? <Icon className="h-4 w-4 text-slate-400" aria-hidden /> : null}
          {title}
        </h2>
        {action}
      </div>
      <div className="px-5 pb-5 pt-3">{children}</div>
    </section>
  );
}
