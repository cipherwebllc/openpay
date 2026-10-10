// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/lib/clientSyntax.mjs (node native ESM)。tsc は declaration only として読む。

type SourcePosition = { line: number, column: number, sample: string };

/**
 * source を字句走査し、クラスの static 初期化ブロックの位置 (1 始まり・`{` の位置) と、走査が同期を失った位置
 * (閉じていない文字列・コメント・正規表現・template・括弧、対応しない閉じ括弧) を返す。
 */
export function scanClientSource(source: string): {
  staticBlocks: SourcePosition[],
  error: null | (SourcePosition & { message: string }),
};
