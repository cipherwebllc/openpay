// カバレッジの下限 (vitest.config.ts と scripts/run-tests.mjs の単一情報源)。
// CI は full vitest を 1 回だけ coverage 付きで走らせ (第 7 回レビュー E13)、run-tests.mjs が
// テストの合否 (JSON reporter) とこの下限 (coverage-summary.json) の両方を判定する。
// run-tests.mjs は vitest の終了コードではなく JSON reporter・未処理エラーの集計・この下限で合否を決める
// (終了コードの理由を区別できないため) → 閾値割れもここの値で明示的に比べる。
// 値の根拠は vitest.config.ts のコメント (実測 -2pt・回帰のみ検出)。
export const COVERAGE_THRESHOLDS = Object.freeze({
  statements: 87,
  branches: 84,
  functions: 88,
  lines: 87,
});

// coverage-summary.json の本文 (読めなければ null) を下限と比べる。run-tests.mjs の判定を
// テストで固定できるよう純関数にしてある (tests/scripts/runTestsVerdict.test.ts)。
export function evaluateCoverage(summaryText, thresholds = COVERAGE_THRESHOLDS) {
  let total;
  try {
    total = typeof summaryText === 'string' ? JSON.parse(summaryText)?.total : undefined;
  } catch {
    total = undefined;
  }
  if (!total || typeof total !== 'object') return { ok: false, readable: false, results: [] };
  const results = Object.entries(thresholds).map(([metric, min]) => {
    const pct = total[metric]?.pct;
    return { metric, pct, min, pass: typeof pct === 'number' && pct >= min };
  });
  return { ok: results.every((r) => r.pass), readable: true, results };
}
