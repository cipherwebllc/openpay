// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/lib/month-of.mjs (node native ESM)。tsc は declaration only として読む。

/** UTC 基準で `offset` か月ずらした "YYYY-MM"。月末の繰り上がりを起こさない (1 日固定で計算)。 */
export function monthOf(offset?: number, now?: Date): string;
