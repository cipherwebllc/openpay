// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/lib/testFileFence.mjs (node native ESM)。tsc は declaration only として読む。

/** tests/ 配下の *.test.ts(x) を repo-relative path (posix 区切り) の昇順で返す。 */
export function listTestFiles(root: string, dir?: string): string[];

/** vitest JSON reporter の testResults[].name (絶対 path) を repo-relative へ正規化する。 */
export function normalizeReportedFiles(
  testResults: unknown,
  root: string,
): string[];

/** ディスク上の test ファイルと reporter 報告分を突き合わせ、欠落を返す。 */
export function checkTestFileCoverage(args: {
  onDisk: string[];
  reported: string[];
  allowlist?: string[];
}): { ok: boolean; missing: string[] };
