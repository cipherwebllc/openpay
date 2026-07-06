#!/usr/bin/env node
// PR の CI settle 待ち + conclusion 判定 (CLAUDE.md「自律運転の型」の CI 待ち標準手順)。
//
// 動機: エージェントが CI 待ちのポーリングを毎回即興 bash で書くと、jq クエリの
// 打ち間違い・stale HEAD の見落とし・「成功したはず」の幻覚が混入する
// (2026-07-06 に実害)。settle 判定と conclusion 集計を単一スクリプトに固定し、
// 呼び出し側は出力ファイルを Read して HEAD 一致と exit code だけ確認すればよい。
//
// 使い方:
//   node scripts/ci-wait.mjs <PR番号>            # settle まで待つ (既定 30 分)
//   node scripts/ci-wait.mjs <PR番号> --once     # 現在の状態を出力して即終了
//   node scripts/ci-wait.mjs <PR番号> --timeout 45  # 待ち上限 (分)
//
// 出力 (stdout): SETTLED/PENDING/TIMEOUT 行 (headSha 付き) + check 一覧 TSV。
// exit code: 0 = 全 check SUCCESS/NEUTRAL・1 = 失敗 check あり・2 = timeout・3 = 引数/gh エラー。
// vercel の deploy check は判定から除外する (merge 条件は repo CI のみ)。

import { spawnSync } from 'node:child_process';

const POLL_INTERVAL_MS = 40_000;
const PENDING_STATES = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'EXPECTED']);
const PASS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function usageExit(msg) {
  console.error(msg);
  console.error('usage: node scripts/ci-wait.mjs <PR番号> [--once] [--timeout <分>]');
  process.exit(3);
}

const args = process.argv.slice(2);
const prNumber = Number(args[0]);
if (!Number.isInteger(prNumber) || prNumber <= 0) usageExit('PR 番号が不正です');
const once = args.includes('--once');
const timeoutIdx = args.indexOf('--timeout');
const timeoutMin = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 30;
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) usageExit('--timeout が不正です');

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
  const checks = (data.statusCheckRollup ?? [])
    .map((c) => ({
      name: c.name ?? c.context ?? '(unnamed)',
      status: c.status ?? c.state ?? '',
      conclusion: c.conclusion ?? c.state ?? '',
    }))
    .filter((c) => !/vercel/i.test(c.name));
  return { headSha: (data.headRefOid ?? '').slice(0, 7), checks };
}

function report(label, headSha, checks) {
  const failed = checks.filter((c) => !PASS_CONCLUSIONS.has(c.conclusion));
  console.log(`${label} head=${headSha} checks=${checks.length} nonSUCCESS=${failed.length}`);
  for (const c of checks) console.log(`${c.name}\t${c.conclusion || c.status}`);
  return failed.length;
}

const deadline = Date.now() + timeoutMin * 60_000;
for (;;) {
  const { headSha, checks } = fetchChecks();
  const pending = checks.filter((c) => PENDING_STATES.has(c.status));
  if (checks.length > 0 && pending.length === 0) {
    process.exit(report('SETTLED', headSha, checks) === 0 ? 0 : 1);
  }
  if (once) {
    report('PENDING', headSha, checks);
    process.exit(2);
  }
  if (Date.now() >= deadline) {
    report('TIMEOUT', headSha, checks);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
