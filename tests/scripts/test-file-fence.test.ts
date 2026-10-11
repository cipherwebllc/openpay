// scripts/lib/testFileFence.mjs (CI runner のファイル数フェンス) の純関数検証。
//
// このフェンスは「worker が collection の前に死んだファイル」を検出するためにある。
// 既存の test 数ベースの判定 (numTotalTests) はその経路を素通りさせるため、
// ファイル一覧の突き合わせが唯一の検出手段になる。

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkTestFileCoverage,
  fileLevelFailures,
  listTestFiles,
  normalizeReportedFiles,
} from '@/scripts/lib/testFileFence.mjs';

const root = process.cwd();

describe('listTestFiles', () => {
  it('tests/ 配下の *.test.ts(x) を repo-relative で列挙する', () => {
    const files = listTestFiles(root);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('tests/scripts/test-file-fence.test.ts');
    expect(files.every((f: string) => /^tests\/.+\.test\.tsx?$/.test(f))).toBe(true);
  });

  it('存在しないディレクトリは空配列 (呼び出し側で 0 件扱い)', () => {
    expect(listTestFiles(root, 'no-such-dir')).toEqual([]);
  });
});

describe('normalizeReportedFiles', () => {
  it('絶対 path を repo-relative に直して昇順で返す', () => {
    const reported = normalizeReportedFiles(
      [
        { name: resolve(root, 'tests/lib/b.test.ts') },
        { name: resolve(root, 'tests/lib/a.test.ts') },
      ],
      root,
    );
    expect(reported).toEqual(['tests/lib/a.test.ts', 'tests/lib/b.test.ts']);
  });

  it('testResults が配列でない / name 欠落は無視する', () => {
    expect(normalizeReportedFiles(undefined, root)).toEqual([]);
    expect(normalizeReportedFiles([{}, { name: 123 }], root)).toEqual([]);
  });
});

describe('checkTestFileCoverage', () => {
  const onDisk = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.tsx'];

  it('全ファイルが報告されていれば ok', () => {
    expect(checkTestFileCoverage({ onDisk, reported: [...onDisk] })).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('reporter に現れないファイルを missing として fail させる', () => {
    // = worker が collection 前に死んだケース。test 数ベースの判定では検出できない。
    const r = checkTestFileCoverage({
      onDisk,
      reported: ['tests/a.test.ts', 'tests/c.test.tsx'],
    });
    expect(r).toEqual({ ok: false, missing: ['tests/b.test.ts'] });
  });

  it('allowlist に載ったファイルだけは欠けても ok', () => {
    const r = checkTestFileCoverage({
      onDisk,
      reported: ['tests/a.test.ts', 'tests/c.test.tsx'],
      allowlist: ['tests/b.test.ts'],
    });
    expect(r).toEqual({ ok: true, missing: [] });
  });

  it('余分な報告 (削除済ファイル等) は fail 条件にしない', () => {
    const r = checkTestFileCoverage({
      onDisk,
      reported: [...onDisk, 'tests/gone.test.ts'],
    });
    expect(r.ok).toBe(true);
  });

  it('allowlist が空なら 1 件の欠落でも fail する', () => {
    expect(
      checkTestFileCoverage({ onDisk, reported: onDisk.slice(0, 2), allowlist: [] })
        .ok,
    ).toBe(false);
  });
});

// ファイル単位の失敗 (import 時の例外・beforeAll/afterAll の例外・test が 0 件) は numFailedTests に載らない。
// vitest 2.1.9 / 5.0.3 の JSON reporter はどちらも、そのファイルの status を 'failed'・message を理由にする (実測)。
describe('fileLevelFailures', () => {
  it('status が failed のファイルを repo-relative の path と理由の 1 行目で返す', () => {
    const failures = fileLevelFailures(
      [
        { name: resolve(root, 'tests/ok.test.ts'), status: 'passed', assertionResults: [{ status: 'passed' }] },
        { name: resolve(root, 'tests/import.test.ts'), status: 'failed', message: 'probe: import-time failure\n    at x', assertionResults: [] },
        { name: resolve(root, 'tests/after-all.test.ts'), status: 'failed', message: 'probe: afterAll failure', assertionResults: [{ status: 'passed' }] },
        { name: resolve(root, 'tests/empty.test.ts'), status: 'failed', message: 'No test found in suite tests/empty.test.ts', assertionResults: [] },
        { name: resolve(root, 'tests/skipped.test.ts'), status: 'skipped', assertionResults: [{ status: 'skipped' }] },
      ],
      root,
    );
    expect(failures).toEqual([
      { file: 'tests/import.test.ts', message: 'probe: import-time failure' },
      { file: 'tests/after-all.test.ts', message: 'probe: afterAll failure' },
      { file: 'tests/empty.test.ts', message: 'No test found in suite tests/empty.test.ts' },
    ]);
  });

  it('名前や理由が欠けていても、失敗したファイルを落とさない', () => {
    expect(fileLevelFailures([{ status: 'failed' }], root)).toEqual([{ file: '(name なし)', message: '' }]);
  });

  it('testResults が配列でなければ空 (JSON が読めない場合は呼び出し側が別に fail させる)', () => {
    expect(fileLevelFailures(undefined, root)).toEqual([]);
    expect(fileLevelFailures({}, root)).toEqual([]);
  });
});

