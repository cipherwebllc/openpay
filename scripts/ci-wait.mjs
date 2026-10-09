#!/usr/bin/env node
// PR の CI settle 待ち + conclusion 判定 (CLAUDE.md「自律運転の型」の CI 待ち標準手順)。
//
// 動機: エージェントが CI 待ちのポーリングを毎回即興 bash で書くと、jq クエリの
// 打ち間違い・stale HEAD の見落とし・「成功したはず」の幻覚が混入する
// (2026-07-06 に実害)。settle 判定と conclusion 集計を単一スクリプトに固定し、
// 呼び出し側は出力ファイルを Read して HEAD 一致と exit code だけ確認すればよい。
//
// 判定は「期待する check 名の集合」(scripts/lib/ciWait.mjs の EXPECTED_PR_CHECKS・workflow との
// ドリフトは tests/scripts/ci-wait.test.ts が検出) に対して行う (第 7 回レビュー E8)。workflow run が
// まだ登録されていない・必須 job が SKIPPED のときに「出てきた分は全部 SUCCESS」で exit 0 に
// ならないよう、期待 check が全部そろって SUCCESS のときだけ 0 を返す。期待集合を適用するのは
// PR の base が main のときだけで、積み上げ PR (base が main 以外) は従来の判定
// (出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED) に戻し、先頭行に expected=skipped(base=…) と出す。
//
// 使い方:
//   node scripts/ci-wait.mjs <PR番号>            # settle まで待つ (既定 30 分)
//   node scripts/ci-wait.mjs <PR番号> --once     # 現在の状態を出力して即終了
//   node scripts/ci-wait.mjs <PR番号> --timeout 45  # 待ち上限 (分)
//   node scripts/ci-wait.mjs <PR番号> --head <sha>  # PR の head が <sha> でなければ exit 3
//       (短縮 SHA はローカルの git rev-parse で完全 OID に解決できるときだけ受け付ける)
//
// 出力 (stdout): SETTLED/PENDING/TIMEOUT 行 (headSha 付き・missing=期待 check のうち未登録の数・
//   expected=期待 check 数 か skipped(base=<base>)) + check 一覧 TSV (未登録の期待 check は `<name>\tMISSING`)。
// exit code: 0 = 期待 check 全部 SUCCESS (他も合格)・1 = 失敗 check あり・2 = timeout / 未 settle・
//   3 = 引数/gh エラー・--head 不一致 (解決できない短縮 SHA を含む)。
// vercel の deploy check は判定から除外する (merge 条件は repo CI のみ)。

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateChecks, expectedChecksFor, normalizeRollup } from './lib/ciWait.mjs';

const POLL_INTERVAL_MS = 40_000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
const headArg = headIdx >= 0 ? (args[headIdx + 1] ?? '').trim().toLowerCase() : null;
if (headArg !== null && !/^[0-9a-f]{7,40}$/.test(headArg)) usageExit('--head が不正です (7〜40 桁の hex)');

/** --head を完全 OID に解決する。40 桁ならそのまま、短縮ならローカルの git に聞く (解決できなければ exit 3)。 */
function resolveExpectedHead(sha) {
  if (sha === null) return null;
  if (sha.length === 40) return sha;
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const full = res.status === 0 ? res.stdout.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(full)) {
    console.error(`--head ${sha} をローカルの git で完全 OID に解決できません (fetch 漏れか typo)。完全 OID を渡すこと`);
    process.exit(3);
  }
  return full;
}
const expectedHead = resolveExpectedHead(headArg);

function fetchPr() {
  const res = spawnSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'statusCheckRollup,headRefOid,baseRefName'],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    console.error(`gh 失敗: ${res.stderr?.trim() || res.stdout?.trim()}`);
    process.exit(3);
  }
  const data = JSON.parse(res.stdout);
  const headRefOid = (data.headRefOid ?? '').toLowerCase();
  if (expectedHead !== null && headRefOid !== expectedHead) {
    console.error(`HEAD 不一致: --head ${expectedHead} に対して PR の head は ${headRefOid || '(不明)'} (stale run か push 漏れ)`);
    process.exit(3);
  }
  return {
    headSha: headRefOid.slice(0, 7),
    baseRefName: data.baseRefName ?? '',
    checks: normalizeRollup(data.statusCheckRollup),
  };
}

function report(label, { headSha, baseRefName, checks }, expected, verdict) {
  const expectedLabel = expected.length > 0 ? String(expected.length) : `skipped(base=${baseRefName || '?'})`;
  console.log(
    `${label} head=${headSha} checks=${checks.length} nonSUCCESS=${verdict.failed.length} missing=${verdict.missing.length} expected=${expectedLabel}`,
  );
  for (const c of checks) console.log(`${c.name}\t${c.conclusion || c.status}`);
  for (const name of verdict.missing) console.log(`${name}\tMISSING`);
}

const deadline = Date.now() + timeoutMin * 60_000;
for (;;) {
  const pr = fetchPr();
  const expected = expectedChecksFor(pr.baseRefName);
  const verdict = evaluateChecks(pr.checks, expected);
  if (verdict.settled) {
    report('SETTLED', pr, expected, verdict);
    process.exit(verdict.ok ? 0 : 1);
  }
  if (once) {
    report('PENDING', pr, expected, verdict);
    process.exit(2);
  }
  if (Date.now() >= deadline) {
    report('TIMEOUT', pr, expected, verdict);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
