// ガイドの「たためるカード」(plans/guide-ux-polish.md フェーズ 2)。選んだものだけを開いて読む長い手順
// (store の配布方法・共通の注意点など) に使う。見出しと要点 (summary) は常に見せ、本文はたたむ。
// JS を使わない <details>。aria-label は使わない (名前は summary の可視の文字・掟 8)。

import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * variant = 'card' (既定): 選んで開く長い手順のカード。'subtle': 節の中の「くわしく」(補足の細部・前提の説明) を
 * 地色の小箱でたたむ。本文の主張は外に出し、細部だけをここに入れる (引き算しても情報は消さない)。
 */
export function GuideDisclosure({
  summary,
  children,
  defaultOpen = false,
  variant = 'card',
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  variant?: 'card' | 'subtle';
}) {
  if (variant === 'subtle') {
    return (
      <details open={defaultOpen} className="group mt-4 rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-200/70">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-700 [@media(hover:hover)]:hover:bg-slate-100/70 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1 [word-break:auto-phrase]">{summary}</span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <div className="space-y-2 px-4 pb-4 pt-1 [&_li]:text-slate-600 [&_p]:text-slate-600">{children}</div>
      </details>
    );
  }
  return (
    <details open={defaultOpen} className="group rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
      <summary className="flex cursor-pointer list-none items-start gap-3 rounded-2xl px-4 py-4 sm:px-5 [@media(hover:hover)]:hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1 [word-break:auto-phrase]">{summary}</div>
        <ChevronDown
          className="mt-0.5 h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="border-t border-slate-100 px-4 pb-5 pt-4 sm:px-5">{children}</div>
    </details>
  );
}

/**
 * 並んだ「たためるカード」(variant='card') を 1 枚の箱にまとめ、行を区切り線で分ける (よくある質問と同じ型)。
 * 選んで開く手順 (配布方法・出品の経路・セットアップ) や注意点が箱の山にならないようにする (plans/guide-ux-polish-2.md P5)。
 * 子は GuideDisclosure を直接並べる (li で包むときは as="ul")。中の「くわしく」(subtle) には効かない (直下の details だけ)。
 */
export function GuideDisclosureGroup({
  children,
  as: Tag = 'div',
  className,
}: {
  children: ReactNode;
  as?: 'div' | 'ul';
  className?: string;
}) {
  return (
    <Tag
      className={`divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 [&>details]:rounded-none [&>details]:shadow-none [&>details]:ring-0 [&>details>summary]:rounded-none [&>li>details]:rounded-none [&>li>details]:shadow-none [&>li>details]:ring-0 [&>li>details>summary]:rounded-none ${className ?? 'mt-4'}`}
    >
      {children}
    </Tag>
  );
}
