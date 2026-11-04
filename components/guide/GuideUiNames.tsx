// ガイドの本文の中の画面の名前 (「…」/ “…” で引いたボタン・欄の名前) を少し濃く・太くして、本文から拾いやすくする。
// 使うかはページが選ぶ (uiNames)。引用符を画面の名前だけに使うページ (tests/lib/orderLinkGuide.test.ts が画面の文言と照合) 向け。
// 短い名前は途中で改行しない (スマホで「リンクをコ / ピー」と割れるのを防ぐ)。長い名前は折り返す (320px ではみ出さない)。
// hook を使わない同期の部品 (Server Component から呼べる)。

import type { ReactNode } from 'react';

const UI_NAME = /(「[^」]+」|“[^”]+”)/g;
/** これより長い名前は折り返しを許す (和文 14 字 ≒ 15px で 210px・320px の画面の本文の幅に収まる)。 */
const NOWRAP_MAX = 14;

export function withUiNames(text: string): ReactNode {
  const parts = text.split(UI_NAME);
  if (parts.length === 1) return text;
  // split に括弧つきの正規表現を渡すと、奇数番目が一致した部分 (画面の名前) になる。
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className={`font-medium text-slate-900 ${[...part].length <= NOWRAP_MAX ? 'whitespace-nowrap' : ''}`}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}
