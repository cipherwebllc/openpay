// トップの節見出しの型: 章ラベル (eyebrow) + 見出し (h2) + 1 行のリード。Server/Client どちらからも使える純表示。
// 全節で同じ大きさ・余白にそろえ、章ラベルで「いまどの章か」を示す (plans/lp-polish-2026-09.md P2)。

import type { ReactNode } from 'react';

export function LandingSectionHeader({
  eyebrow,
  title,
  lead,
  id,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      {eyebrow ? <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand sm:text-sm">{eyebrow}</p> : null}
      {/* 見出しは文節で折り返し、行の長さをそろえる (「ステーブルコインなの / か」のような 1 文字だけの行や、
          単語の途中の改行を出さない・日本語は html lang=ja で効く word-break:auto-phrase)。 */}
      <h2
        id={id}
        className={`text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 [word-break:auto-phrase] text-balance sm:text-4xl ${eyebrow ? 'mt-2' : ''}`}
      >
        {title}
      </h2>
      {lead ? <p className="mx-auto mt-3 max-w-2xl text-balance text-sm leading-relaxed text-slate-600 [word-break:auto-phrase] sm:text-base">{lead}</p> : null}
    </div>
  );
}

// 章の帯: 全幅の白地で章をまとめ、ページの地色 (slate-50) と交互にしてリズムを作る。
// 全幅の地色は box-shadow + clip-path で描く (100vw の要素はスクロールバーぶん横にはみ出すが、影は幅に数えられない)。
// 帯の中の最初の節は上の余白を持たない (帯の上下の余白でそろえる)。
export function LandingBand({ children }: { children: ReactNode }) {
  return (
    <div className="mt-16 bg-white py-9 shadow-[0_0_0_100vmax_white] [clip-path:inset(0_-100vmax)] sm:mt-28 sm:py-20 [&>*:first-child]:mt-0">
      {children}
    </div>
  );
}
