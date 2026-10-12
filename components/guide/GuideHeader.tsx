// ガイドのページの頭 (h1・副題・リード・行動ボタン) の共通部品 (plans/guide-ux-polish.md フェーズ 1)。
// これまでページごとに h1 の大きさ (2 種)・副題の色 (緑)・リードの大きさがばらばらだったのを 1 つの型にそろえる。
// hook・next-intl に依存しない同期の server 部品 (jsdom で描画テストできる)。aria-label は使わない (掟 8)。

import type { ReactNode } from 'react';
import Link from 'next/link';

export function GuideTitle({ children }: { children: ReactNode }) {
  return (
    // auto-phrase: 日本語を文節の切れ目で改行する (「け）」だけ・「注 / 文」のような割れを防ぐ)。対応しない
    // ブラウザ (Safari) は通常の改行のまま。text-balance は日本語で語の途中を割るので使わない。
    <h1 className="text-3xl font-bold leading-tight tracking-tight text-slate-900 [word-break:auto-phrase] sm:text-4xl">{children}</h1>
  );
}

/** h1 の下の一文 (要点)。緑の色は「お店」の意味に使うので、ここは濃い灰色にする。 */
export function GuideSubtitle({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-lg font-semibold leading-snug text-slate-800">{children}</p>;
}

export function GuideLead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={`mt-4 max-w-2xl text-base leading-relaxed text-slate-600 ${className ?? ''}`}>{children}</p>
  );
}

export type GuideAction = { readonly href: string; readonly label: string; readonly external?: boolean };

export const GUIDE_PRIMARY_ACTION =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700';
export const GUIDE_SECONDARY_ACTION =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-5 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 transition-colors hover:bg-slate-50';

/** ページの頭の行動ボタン (1 つ目が主・2 つ目以降は従)。 */
export function GuideActions({ actions, className }: { actions: readonly GuideAction[]; className?: string }) {
  return (
    <div className={`flex flex-wrap gap-3 ${className ?? 'mt-6'}`}>
      {actions.map((action, index) =>
        action.external ? (
          <a
            key={action.href}
            href={action.href}
            target="_blank"
            rel="noreferrer noopener"
            className={index === 0 ? GUIDE_PRIMARY_ACTION : GUIDE_SECONDARY_ACTION}
          >
            {action.label}
          </a>
        ) : (
          <Link key={action.href} href={action.href} prefetch={false} className={index === 0 ? GUIDE_PRIMARY_ACTION : GUIDE_SECONDARY_ACTION}>
            {action.label}
          </Link>
        ),
      )}
    </div>
  );
}
