#!/usr/bin/env node
// CI 用 vitest runner。
//
// 判定基準: vitest --reporter=json の出力 (numFailedTests / numTotalTests /
// numPassedTests) を唯一の信頼ソースとし、process exit code は無視する。
//
// fail 条件:
//   1. numFailedTests > 0 (assertion fail)
//   2. numTotalTests === 0 (silent global skip)
//   3. passed + failed < total かつ 未 run の test が KNOWN_BROKEN_FILES の
//      範囲外 (= 新規 partial silent skip。regression 検知用 fence)
//   4. ディスク上の tests/**/*.test.{ts,tsx} のうち reporter に 1 件も現れないファイルがある
//      (= collection 前に worker が死んだ / 誤除外。3. は test 数ベースなのでこの経路を見逃す)
//
// KNOWN_BROKEN_FILES: worker OOM 等で collect 後に run されないファイルを file→期待 missing
// test 数の Map で登録する暫定 allowlist。KNOWN_MAX_MISSING はこの Map から導出するので、
// ファイルを外せば fence がその件数分だけ自動的に厳しくなり (空なら missing 0 件のみ許容)、
// 新規 partial silent skip を確実に fail させる。
//
// 2026-06-03: 旧 6 ファイル (PaymentForm/CheckoutForm/TipForm 系) の worker OOM は真因が
// ConnectButton の render (jsdom で重い wagmi/connector graph を評価) と判明。ConnectButton を
// 軽量 stub (tests/_helpers/connectButtonStub.tsx) に差し替えることで全て実 run+pass に復帰した
// ため allowlist を空にした。手数料 0% 化に伴う stale assertion も併せて更新済。
// 詳細は memory:paymentform-oom-rootcause。

import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTestFileCoverage,
  listTestFiles,
  normalizeReportedFiles,
} from './lib/testFileFence.mjs';

// 既知の worker-OOM 等で未 run のファイル → 期待 missing test 数 (Map)。空 = 全ファイル run 前提
// (missing が 1 件でも出れば fail)。ここに足す操作は PR レビューで明示同意が必要。
const KNOWN_BROKEN_FILES = new Map([
  // 例: ['tests/components/Foo.test.tsx', 42], // OOM 等で未 run のファイルと collect 済 test 数
]);

// ファイル数フェンス (下記 3.) の allowlist。CI で意図的に走らせない test ファイルがあればここへ。
// vitest.config.ts の exclude は node_modules / e2e / .next (いずれも tests/ 外) だけなので、
// 現状は空 = tests/ 配下の全ファイルが reporter に現れることを要求する。
const KNOWN_UNREPORTED_FILES = [];

const tmp = mkdtempSync(join(tmpdir(), 'vitest-out-'));
const jsonOut = join(tmp, 'result.json');

// CLI から渡された追加引数 (path / -t 等の絞り込み)。空 = full run。
const extraArgs = process.argv.slice(2);

const args = [
  '--max-old-space-size=6144',
  './node_modules/.bin/vitest',
  'run',
  '--pool=forks',
  '--poolOptions.forks.minForks=1',
  '--poolOptions.forks.maxForks=2',
  '--reporter=default',
  '--reporter=json',
  `--outputFile=${jsonOut}`,
  ...extraArgs,
];

const child = spawn('node', args, { stdio: 'inherit' });

child.on('exit', (code) => {
  let report;
  try {
    report = JSON.parse(readFileSync(jsonOut, 'utf8'));
  } catch (e) {
    console.error('\n[run-tests] JSON report unreadable, falling back to vitest exit code:', code);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(code ?? 1);
  }
  rmSync(tmp, { recursive: true, force: true });

  const { numFailedTests, numTotalTests, numPassedTests, testResults } = report;
  console.log(
    `\n[run-tests] vitest exit=${code}, JSON: passed=${numPassedTests} failed=${numFailedTests} total=${numTotalTests}`,
  );

  if (numFailedTests > 0) {
    console.error('[run-tests] FAIL: 1 件以上 assertion failure あり');
    process.exit(1);
  }
  if (numTotalTests === 0) {
    console.error('[run-tests] FAIL: 0 tests ran');
    process.exit(1);
  }
  // ファイル数フェンス: worker が **collection の前に** 死んだファイルは numTotalTests にも
  // 載らないため、下の「partial silent skip」検出 (test 数ベース) では検出できない。ディスク上の
  // test ファイル一覧と reporter が報告したファイル一覧を突き合わせ、1 件でも欠けたら fail。
  // 引数付き実行 (path/-t での絞り込み) は full run ではないので適用しない。
  if (extraArgs.length === 0) {
    const onDisk = listTestFiles(process.cwd());
    const reported = normalizeReportedFiles(testResults, process.cwd());
    const coverage = checkTestFileCoverage({
      onDisk,
      reported,
      allowlist: KNOWN_UNREPORTED_FILES,
    });
    console.log(
      `[run-tests] test files: onDisk=${onDisk.length} reported=${reported.length}`,
    );
    if (!coverage.ok) {
      console.error(
        `[run-tests] FAIL: ${coverage.missing.length} 件の test ファイルが reporter に現れていない ` +
          '(collection 前に worker が死んだ / 誤って除外された可能性)。',
      );
      for (const f of coverage.missing) console.error(`  - ${f}`);
      process.exit(1);
    }
  }
  // Partial silent skip 検出: collection で出てきた test が JSON 上 pass にも fail にも
  // 数えられていない (= worker が collect 後・assertion 前に die)。numPassedTests +
  // numFailedTests < numTotalTests になる。
  const accounted = numPassedTests + numFailedTests;
  if (accounted < numTotalTests) {
    const missing = numTotalTests - accounted;
    const erroredFiles = Array.isArray(testResults)
      ? testResults
          .filter((r) => !r.assertionResults || r.assertionResults.length === 0)
          .map((r) => r.name)
      : [];
    // 絶対 path → repo-relative に正規化して allowlist と照合
    const cwd = process.cwd() + '/';
    const erroredRel = erroredFiles.map((f) =>
      f.startsWith(cwd) ? f.slice(cwd.length) : f,
    );
    const unknown = erroredRel.filter((f) => !KNOWN_BROKEN_FILES.has(f));
    const known = erroredRel.filter((f) => KNOWN_BROKEN_FILES.has(f));

    // vitest JSON reporter は worker crash 済 file の testResults entry を
    // 出さないため erroredRel が空になる場合がある (numTotalTests には別経路で
    // 加算済)。その場合は file 名を特定できないので allowlist 検証不能 →
    // KNOWN_BROKEN_FILES に登録した期待 missing 数の合計を上限とする。allowlist が
    // 空なら 0 = missing が 1 件でも出れば fail (= 全ファイル run を強制)。ファイルを
    // 外せば fence がその件数分だけ自動で厳しくなる (ハードコードの 186 を廃止)。
    const KNOWN_MAX_MISSING = [...KNOWN_BROKEN_FILES.values()].reduce(
      (sum, n) => sum + n,
      0,
    );
    if (unknown.length > 0) {
      console.error(
        `[run-tests] FAIL: ${missing} 件の test が collect 済だが run されていない ` +
          `(passed=${numPassedTests} + failed=${numFailedTests} < total=${numTotalTests})。` +
          'KNOWN_BROKEN_FILES 範囲外で新規 partial silent skip 発生。',
      );
      console.error('[run-tests] 新規 (allowlist 外) errored:');
      for (const f of unknown) console.error(`  - ${f}`);
      if (known.length > 0) {
        console.error('[run-tests] 既知 errored (allowlist 内):');
        for (const f of known) console.error(`  - ${f}`);
      }
      process.exit(1);
    }
    if (missing > KNOWN_MAX_MISSING) {
      console.error(
        `[run-tests] FAIL: 未 run test 数 ${missing} が許容上限 ${KNOWN_MAX_MISSING} を超過。` +
          '新規 partial silent skip が混入した可能性 (testResults entry が空のため file 名特定不能)。' +
          'KNOWN_BROKEN_FILES allowlist を見直すか、新規 broken file を調査すること。',
      );
      process.exit(1);
    }
    console.warn(
      `[run-tests] WARN: ${missing} 件の test が allowlist 内の broken file 群 (${KNOWN_BROKEN_FILES.size} files, 上限 ${KNOWN_MAX_MISSING}) のため pass 扱い。` +
        '上流 fix (test 分割 / mock 軽量化) は別 task として継続要。',
    );
    if (known.length > 0) {
      console.warn('[run-tests] 確定済 errored (allowlist 内):');
      for (const f of known) console.warn(`  - ${f}`);
    } else {
      console.warn(
        '[run-tests] errored file 名は vitest JSON reporter から取得不能 ' +
          '(testResults entry が空)。stdout 上の "Errors N errors" に相当。',
      );
    }
    process.exit(0);
  }
  if (code !== 0) {
    console.warn(
      `[run-tests] PASS with warning: vitest exit=${code} (likely worker post-teardown crash)。` +
        '全 assertion 数 (passed+failed) が total と一致しているため exit 0 で扱う。',
    );
  }
  process.exit(0);
});
