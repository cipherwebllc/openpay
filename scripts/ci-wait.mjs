#!/usr/bin/env node
// PR の CI settle 待ち + conclusion 判定 (CLAUDE.md「自律運転の型」の CI 待ち標準手順)。
//
// 動機: エージェントが CI 待ちのポーリングを毎回即興 bash で書くと、jq クエリの
// 打ち間違い・stale HEAD の見落とし・「成功したはず」の幻覚が混入する
// (2026-07-06 に実害)。settle 判定と conclusion 集計を単一スクリプトに固定し、
// 呼び出し側は出力ファイルを Read して HEAD 一致と exit code だけ確認すればよい。
//
// 判定は「期待する check 名の集合」(.github/workflows から導出・scripts/lib/ciWait.mjs) に対して行う
// (第 7 回レビュー E8)。workflow run がまだ登録されていない・必須 job が SKIPPED のときに
// 「出てきた分は全部 SUCCESS」で exit 0 にならないよう、期待 check が全部そろって SUCCESS の
// ときだけ 0 を返す。期待集合に無い check は従来どおり SUCCESS/NEUTRAL/SKIPPED を合格とする。
//
// 使い方:
//   node scripts/ci-wait.mjs <PR番号>            # settle まで待つ (既定 30 分)
//   node scripts/ci-wait.mjs <PR番号> --once     # 現在の状態を出力して即終了
//   node scripts/ci-wait.mjs <PR番号> --timeout 45  # 待ち上限 (分)
//   node scripts/ci-wait.mjs <PR番号> --head <sha>  # PR の head が <sha> (前方一致) でなければ exit 3
//
// 出力 (stdout): SETTLED/PENDING/TIMEOUT 行 (headSha 付き・missing=期待 check のうち未登録の数) +
//   check 一覧 TSV (未登録の期待 check は `<name>\tMISSING`)。
// exit code: 0 = 期待 check 全部 SUCCESS (他も合格)・1 = 失敗 check あり・2 = timeout / 未 settle・
//   3 = 引数/gh エラー・期待集合が導出できない・--head 不一致。
// vercel の deploy check は判定から除外する (merge 条件は repo CI のみ)。

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateChecks, expectedPrChecks, normalizeRollup } from './lib/ciWait.mjs';

const POLL_INTERVAL_MS = 40_000;
const WORKFLOWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../.github/workflows');

function usageExit(msg) {
  console.error(msg);
  console.error('usage: node scripts/ci-wait.mjs <PR番号> [--once] [--timeout <分>] [--head <sha>]');
  process.exit(3);
}

const args = process.argv.slice(2);
const prNumber = Number(args[0]);
if (!Number.isInteger(prNumber) || prNumber <= 0) usageExit('PR 番号が不正です');
const once = args.includes('--once');
const timeoutIdx = args.indexOf('--timeout');
const timeoutMin = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 30;
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) usageExit('--timeout が不正です');
const headIdx = args.indexOf('--head');
const expectedHead = headIdx >= 0 ? (args[headIdx + 1] ?? '').trim().toLowerCase() : null;
if (expectedHead !== null && !/^[0-9a-f]{7,40}$/.test(expectedHead)) usageExit('--head が不正です (7〜40 桁の hex)');

let expected;
try {
  expected = expectedPrChecks(WORKFLOWS_DIR).expected;
} catch (err) {
  console.error(`期待 check 集合を導出できません (${WORKFLOWS_DIR}): ${err?.message ?? err}`);
  process.exit(3);
}
if (expected.length === 0) {
  console.error(`期待 check 集合が空です (${WORKFLOWS_DIR} に pull_request で走る job が無い)`);
  process.exit(3);
}

function fetchChecks() {
  const res = spawnSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'statusCheckRollup,headRefOid'],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    console.error(`gh 失敗: ${res.stderr?.trim() || res.stdout?.trim()}`);
    process.exit(3);
  }
  const data = JSON.parse(res.stdout);
  const headRefOid = (data.headRefOid ?? '').toLowerCase();
  if (expectedHead !== null && !headRefOid.startsWith(expectedHead)) {
    console.error(`HEAD 不一致: --head ${expectedHead} に対して PR の head は ${headRefOid || '(不明)'} (stale run か push 漏れ)`);
    process.exit(3);
  }
  return { headSha: headRefOid.slice(0, 7), checks: normalizeRollup(data.statusCheckRollup) };
}

function report(label, headSha, checks, verdict) {
  console.log(
    `${label} head=${headSha} checks=${checks.length} nonSUCCESS=${verdict.failed.length} missing=${verdict.missing.length}`,
  );
  for (const c of checks) console.log(`${c.name}\t${c.conclusion || c.status}`);
  for (const name of verdict.missing) console.log(`${name}\tMISSING`);
}

const deadline = Date.now() + timeoutMin * 60_000;
for (;;) {
  const { headSha, checks } = fetchChecks();
  const verdict = evaluateChecks(checks, expected);
  if (verdict.settled) {
    report('SETTLED', headSha, checks, verdict);
    process.exit(verdict.ok ? 0 : 1);
  }
  if (once) {
    report('PENDING', headSha, checks, verdict);
    process.exit(2);
  }
  if (Date.now() >= deadline) {
    report('TIMEOUT', headSha, checks, verdict);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
