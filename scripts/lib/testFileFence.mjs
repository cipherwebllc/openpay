// full vitest 実行で「1 ファイルも取りこぼしていない」ことを確かめるための純関数群。
//
// なぜ必要か: scripts/run-tests.mjs の既存フェンスは numTotalTests (collect 済 test 数) を基準に
// している。worker が **collection の前に** 死ぬと、そのファイルの test はそもそも数えられず
// numTotalTests にも載らないため、passed + failed === total が成立してしまい無音で通る。
// 「ディスク上の test ファイル数」と「reporter が報告したファイル数」を突き合わせれば、
// この経路の取りこぼしを検出できる。
//
// vitest.config.ts の include は 'tests/**/*.test.{ts,tsx}'、exclude は node_modules / e2e / .next
// (いずれも tests/ の外) なので、ディスク側の期待値は tests/ 配下の *.test.ts(x) 全件になる。

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const TEST_FILE_RE = /\.test\.tsx?$/;
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

/** tests/ 配下の test ファイルを repo-relative path (posix 区切り) の昇順配列で返す。 */
export function listTestFiles(root, dir = 'tests') {
  const out = [];
  const abs = join(root, dir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return out; // tests/ が無い = 呼び出し側が 0 件として扱う
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listTestFiles(root, join(dir, entry.name)));
    } else if (TEST_FILE_RE.test(entry.name)) {
      out.push(join(dir, entry.name).split(sep).join('/'));
    }
  }
  return out.sort();
}

/** reporter の testResults[].name (絶対 path) を repo-relative へ正規化。 */
export function normalizeReportedFiles(testResults, root) {
  if (!Array.isArray(testResults)) return [];
  return testResults
    .map((r) => (typeof r?.name === 'string' ? r.name : ''))
    .filter((name) => name.length > 0)
    .map((name) => relative(root, name).split(sep).join('/'))
    .sort();
}

/**
 * ディスク上の test ファイルと reporter が報告したファイルを突き合わせる。
 *   { ok, missing }  missing = reporter が 1 件も報告しなかったファイル (allowlist 除外後)。
 * allowlist は「CI で意図的に走らせないファイル」用。空なら 1 件の取りこぼしでも ok:false。
 */
export function checkTestFileCoverage({ onDisk, reported, allowlist = [] }) {
  const allowed = new Set(allowlist);
  const seen = new Set(reported);
  const missing = onDisk.filter((f) => !seen.has(f) && !allowed.has(f));
  return { ok: missing.length === 0, missing };
}

/**
 * ファイル単位で失敗した test ファイル (testResults[].status === 'failed') を repo-relative で返す。
 *   [{ file, message }]  message = vitest が付けた理由の 1 行目 (import 時の例外・beforeAll/afterAll の例外・
 *   「No test found in suite」など)。
 * なぜ必要か: この経路は numFailedTests に載らない (assertion の失敗ではない) ため、test 数ベースの判定では
 * 通ってしまう。assertion の失敗で落ちたファイルも status は 'failed' なので一緒に返る (呼び出し側は
 * numFailedTests を先に見る)。
 */
export function fileLevelFailures(testResults, root) {
  if (!Array.isArray(testResults)) return [];
  return testResults
    .filter((r) => r?.status === 'failed')
    .map((r) => ({
      file: typeof r.name === 'string' ? relative(root, r.name).split(sep).join('/') : '(name なし)',
      message: String(r.message ?? '').split('\n')[0],
    }));
}
