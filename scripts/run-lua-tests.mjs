#!/usr/bin/env node
// 本物の Lua (wasmoon) を使う test だけを、プロセスを作り直しながら最大 MAX_ATTEMPTS 回まで実行する。
//
// 背景: scripts/lib/luaRealTests.mjs 参照。旧ハーネスの共有 Lua stack への返り値蓄積による
// WASM heap 破損は EVAL 単位の隔離で修正済み。既存のプロセス再起動は維持し、
// 2 回目以降を要したら warning annotation で表面化する。
// 判定は run-tests.mjs と同じく JSON reporter (numFailedTests / 報告ファイル一覧) を信頼ソースにする:
// 1 回でも「全ファイルが報告され・failed=0・total>0」になれば成功、MAX_ATTEMPTS 回すべて
// 失敗したら exit 1 (= 本当に壊れているか、flaky が悪化している)。
//
// 使い方: node scripts/run-lua-tests.mjs (CI の lua-real job・ローカルでも可)
// env: LUA_TESTS_MAX_ATTEMPTS (既定 3) / LUA_TESTS_ATTEMPT_TIMEOUT_MS (既定 600000)

import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LUA_REAL_TEST_FILES } from './lib/luaRealTests.mjs';
import { checkTestFileCoverage, normalizeReportedFiles } from './lib/testFileFence.mjs';

const MAX_ATTEMPTS = Number(process.env.LUA_TESTS_MAX_ATTEMPTS ?? 3);
// 1 attempt の上限。旧ハーネスの doString 返り値蓄積による Lua stack の範囲外書き込みは、
// WASM heap を壊し、クラッシュだけでなく worker の無応答も起こした
// (2026-09-12 PR #482: 2 file pass 後に vitest worker が 74 分無応答・プロセスは生存)。
// EVAL 単位の隔離で修正済みだが、再発時の無応答が CI 全体に波及しないよう、
// 上限を超えたらプロセスグループごと SIGKILL して失敗 attempt に数える。
const ATTEMPT_TIMEOUT_MS = Number(process.env.LUA_TESTS_ATTEMPT_TIMEOUT_MS ?? 10 * 60_000);

function runOnce(attempt) {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(join(tmpdir(), 'vitest-lua-'));
    const jsonOut = join(tmp, 'result.json');
    const args = [
      '--max-old-space-size=4096',
      './node_modules/.bin/vitest',
      'run',
      // 実行並列度は既存の 1 fork を維持。Lua stack の蓄積はハーネスの EVAL 単位の隔離で解消。
      '--pool=forks',
      '--poolOptions.forks.minForks=1',
      '--poolOptions.forks.maxForks=1',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${jsonOut}`,
      ...LUA_REAL_TEST_FILES,
    ];
    console.log(`\n[run-lua-tests] attempt ${attempt}/${MAX_ATTEMPTS}`);
    // detached: 子 (vitest) が起動する fork worker も同じプロセスグループに入るので、timeout 時に
    // グループごと SIGKILL できる (worker だけ生き残る事故を防ぐ)。
    const child = spawn('node', args, { stdio: 'inherit', detached: process.platform !== 'win32' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[run-lua-tests] attempt ${attempt}: timeout after ${ATTEMPT_TIMEOUT_MS}ms — killing vitest process group`);
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // 既に終了していれば何もしない (exit ハンドラ側で resolve する)。
      }
    }, ATTEMPT_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rmSync(tmp, { recursive: true, force: true });
        return resolve({ ok: false, reason: 'timeout (worker hung)' });
      }
      let report = null;
      try {
        report = JSON.parse(readFileSync(jsonOut, 'utf8'));
      } catch {
        console.error(`[run-lua-tests] attempt ${attempt}: JSON report unreadable (vitest exit=${code})`);
      }
      rmSync(tmp, { recursive: true, force: true });
      if (!report) return resolve({ ok: false, reason: 'no-report' });
      const { numFailedTests, numTotalTests, numPassedTests, testResults } = report;
      const reported = normalizeReportedFiles(testResults, process.cwd());
      const files = checkTestFileCoverage({ onDisk: LUA_REAL_TEST_FILES, reported });
      console.log(
        `[run-lua-tests] attempt ${attempt}: vitest exit=${code} passed=${numPassedTests} failed=${numFailedTests} total=${numTotalTests} files=${reported.length}/${LUA_REAL_TEST_FILES.length}`,
      );
      if (numFailedTests > 0) return resolve({ ok: false, reason: `${numFailedTests} failed` });
      if (numTotalTests === 0) return resolve({ ok: false, reason: '0 tests ran' });
      if (numPassedTests + numFailedTests < numTotalTests) {
        return resolve({ ok: false, reason: 'partial silent skip (worker died)' });
      }
      if (!files.ok) return resolve({ ok: false, reason: `files missing: ${files.missing.join(', ')}` });
      resolve({ ok: true });
    });
  });
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  if (attempt > 1) {
    console.warn(`::warning::[run-lua-tests] attempt ${attempt}/${MAX_ATTEMPTS} required after earlier failure; investigate a possible regression.`);
  }
  const result = await runOnce(attempt);
  if (result.ok) {
    console.log(`[run-lua-tests] OK (attempt ${attempt})`);
    process.exit(0);
  }
  console.error(`[run-lua-tests] attempt ${attempt} failed: ${result.reason}`);
}
console.error(`[run-lua-tests] FAIL: ${MAX_ATTEMPTS} attempts exhausted`);
process.exit(1);
