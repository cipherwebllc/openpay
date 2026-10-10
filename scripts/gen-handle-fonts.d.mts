// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/gen-handle-fonts.mjs (node native ESM)。tsc は declaration only として読む。

/** 書き込み先が root の内側 (root 自身は除く) にあることを確かめる。外なら throw。 */
export function assertInside(root: string, target: string): string;

/** 展開済みの 2 package から <repo>/public/fonts/handle/ と <repo>/components/handleFonts.css を作り直す。 */
export function generateHandleFonts(options: { serifPkg: string; maruPkg: string; repo: string }): {
  woff2: number;
  bytes: number;
  faces: number;
  cssChars: number;
};
