// カバレッジの下限 (vitest.config.ts と scripts/run-tests.mjs の単一情報源)。
// CI は full vitest を 1 回だけ coverage 付きで走らせ (第 7 回レビュー E13)、run-tests.mjs が
// テストの合否 (JSON reporter) とこの下限 (coverage-summary.json) の両方を判定する。
// run-tests.mjs は worker の post-teardown crash で vitest が非 0 終了しても全 assertion が
// pass なら通す作りなので、閾値割れを vitest の終了コードに任せると見逃す → ここの値で明示的に比べる。
// 値の根拠は vitest.config.ts のコメント (実測 -2pt・回帰のみ検出)。
export const COVERAGE_THRESHOLDS = Object.freeze({
  statements: 87,
  branches: 84,
  functions: 88,
  lines: 87,
});
