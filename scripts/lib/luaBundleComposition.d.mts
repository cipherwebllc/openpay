// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/lib/luaBundleComposition.mjs (node native ESM)。tsc は declaration only として読む。

/**
 * source (ビルド成果物の JS) の中に、文字列の `after` の直後に `expected` が (畳み込まれて、または変数で) `+` 連結
 * された箇所があるか。変数は使われた場所から見えている宣言 (レキシカルスコープ) の初期化式で値を求める。
 */
export function hasComposition(source: string, after: string, expected: string, fileName?: string): boolean;
