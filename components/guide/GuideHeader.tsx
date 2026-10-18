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

/**
 * h1 の下の一文 (要点)。緑の色は「お店」の意味に使うので灰色にする。太さは中くらいにして、本文の h2 (太字) より
 * 弱く見せる (スマホで h2 と 2px しか差がなく、見出しの強弱が崩れていた・plans/guide-ux-polish-2.md P4)。
 */
export function GuideSubtitle({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-lg font-medium leading-snug text-slate-700 [word-break:auto-phrase]">{children}</p>;
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
/**
 * ガイドの中の札 (対象者・利用シーン・カテゴリ・POS の名前など)。押せる UI と見分けがつくよう、影・枠・緑・太字を使わない
 * 平らな灰色の 1 つの型にそろえる (plans/guide-ux-polish-2.md P5)。
 */
export const GUIDE_TAG = 'rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600';

export function GuideAudience({ title, chips }: { title: string; chips: readonly string[] }) {
  return (
    <div className="mt-4">
      <p className="text-xs font-semibold text-slate-500">{title}</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <li key={chip} className={GUIDE_TAG}>
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

/** 和文 100 字ほど (英数字は半分に数える) を超える説明。日本語と英語でほぼ同じ項目が長いと判定される。 */
function isLongText(text: string): boolean {
  let weight = 0;
  for (const ch of text) weight += ch.charCodeAt(0) < 128 ? 0.5 : 1;
  return weight > 100;
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
        // 説明の長い項目 (条件つきの機能など) は 2 列の片側に細長く積まず、横いっぱいにする (P5)。
        <li key={f.title} className={`flex items-start gap-3 ${isLongText(f.body) ? 'sm:col-span-2' : ''}`}>
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
