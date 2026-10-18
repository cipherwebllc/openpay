// ガイドのページの頭 (h1・副題・リード・行動ボタン) の共通部品 (plans/guide-ux-polish.md フェーズ 1)。
// これまでページごとに h1 の大きさ (2 種)・副題の色 (緑)・リードの大きさがばらばらだったのを 1 つの型にそろえる。
// hook・next-intl に依存しない同期の server 部品 (jsdom で描画テストできる)。aria-label は使わない (掟 8)。

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';

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

/**
 * 「こんな人に向いています」。見出しの節にせず、リードの下の小さなラベルとチップにする
 * (中身がチップだけの h2 を本文の目次に並べない・plans/guide-ux-polish-2.md P3)。
 */
export function GuideAudience({ title, chips }: { title: string; chips: readonly string[] }) {
  return (
    <div className="mt-4">
      <p className="text-xs font-semibold text-slate-500">{title}</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <li key={chip} className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
            {chip}
          </li>
        ))}
      </ul>
    </div>
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

/**
 * 「できること」の一覧。機能ごとに影付きのカードを並べず、1 枚の白い箱にチェック付きの行を並べる
 * (PC は 2 列)。スマホで 1 機能 = 1 枚のカードが縦に続き、同じ形の箱で疲れていたのを軽くする
 * (plans/guide-ux-polish-2.md P3)。見出しは h3 (節の h2 の下)。
 */
export function GuideFeatureList({ items }: { items: readonly { readonly title: string; readonly body: string }[] }) {
  return (
    <ul className="mt-4 grid grid-cols-1 gap-x-8 gap-y-5 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:grid-cols-2 sm:p-6">
      {items.map((f) => (
        <li key={f.title} className="flex items-start gap-3">
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-50 ring-1 ring-inset ring-emerald-200/70">
            <Check className="h-3 w-3 text-emerald-700" aria-hidden strokeWidth={3} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900">{f.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">{f.body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
