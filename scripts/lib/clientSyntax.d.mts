// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/lib/clientSyntax.mjs (node native ESM)。tsc は declaration only として読む。

/** source の中のクラスの static 初期化ブロックの位置 (1 始まり・`{` の位置) と前後の文字列。 */
export function findStaticBlocks(source: string): Array<{ line: number, column: number, sample: string }>;
