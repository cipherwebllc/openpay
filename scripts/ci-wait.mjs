#!/usr/bin/env node
// PR の CI settle 待ち + conclusion 判定 (CLAUDE.md「自律運転の型」の CI 待ち標準手順)。
//
// 動機: エージェントが CI 待ちのポーリングを毎回即興 bash で書くと、jq クエリの
// 打ち間違い・stale HEAD の見落とし・「成功したはず」の幻覚が混入する
// (2026-07-06 に実害)。settle 判定と conclusion 集計を単一スクリプトに固定し、
// 呼び出し側は出力ファイルを Read して HEAD 一致と exit code だけ確認すればよい。
//
// 判定は「期待する check 名の集合」(正本は scripts/ci-expected-checks.json・workflow とのドリフトは
// tests/scripts/ci-wait.test.ts が検出) に対して行う (第 7 回レビュー E8)。workflow run が
// まだ登録されていない・必須 job が SKIPPED のときに「出てきた分は全部 SUCCESS」で exit 0 に
// ならないよう、期待 check が全部そろって SUCCESS のときだけ 0 を返す。期待集合を適用するのは
// PR の base が main のときだけで、積み上げ PR (base が main 以外) は従来の判定
// (出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED) に戻し、先頭行に expected=skipped(base=…) と出す。
// base が取れない (gh の応答に無い・空) ときは曖昧な fallback をせず exit 3 (掟 13)。
//
// 期待集合は「対象 PR の HEAD にある scripts/ci-expected-checks.json」から読む (gh api contents)。必須 job と
// JSON を同時に足した PR を main 側のスクリプトで監視しても PR 側の集合で判定するため。PR 側にファイルが無い
// (このファイルより前の main から分岐した PR)・取得できない・形が違うときは、base 不明と同じく曖昧な fallback
// (ローカルの集合で代用する等) をせず exit 3 (fail-closed)。PR を main に rebase すれば読める。
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
//   3 = 引数/gh エラー・base 不明・期待集合を PR 側から読めない・--head 不一致 (解決できない短縮 SHA を含む)・
//   ローカルの期待集合 JSON が壊れている (lib の import 時の検証)。
// vercel の deploy check は判定から除外する (merge 条件は repo CI のみ)。

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib は import 時にローカルの scripts/ci-expected-checks.json を検証して読む (壊れていれば throw)。
// その throw が未処理の exit 1 (= 失敗 check あり) と取り違えられないよう exit 3 にする。
let lib;
try {
  lib = await import('./lib/ciWait.mjs');
} catch (err) {
  console.error(`scripts/lib/ciWait.mjs を読み込めません: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(3);
}
const { EXPECTED_CHECKS_PATH, MAIN_BRANCH, evaluateChecks, normalizeRollup, parseExpectedChecksJson } = lib;

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
  // base が分からなければ「main 以外」とみなして従来判定に落とさない (掟 13: 仕様を曖昧にする fallback の禁止)
  const baseRefName = data.baseRefName;
  if (typeof baseRefName !== 'string' || baseRefName.trim() === '') {
    console.error(`PR の base branch が取れません (baseRefName=${JSON.stringify(baseRefName ?? null)})。gh の応答を確認すること`);
    process.exit(3);
  }
  return {
    headRefOid,
    headSha: headRefOid.slice(0, 7),
    baseRefName,
    checks: normalizeRollup(data.statusCheckRollup),
  };
}

/**
 * 対象 PR の HEAD にある scripts/ci-expected-checks.json から期待集合を読む。
 * 取得できない (404 = このファイルより前の main から分岐した PR を含む)・形が違うときは exit 3 (ローカルで代用しない)。
 */
const expectedCache = new Map();
function loadExpectedChecks(headRefOid) {
  if (expectedCache.has(headRefOid)) return expectedCache.get(headRefOid);
  const fail = (why) => {
    console.error(`PR の HEAD ${headRefOid.slice(0, 7)} の ${EXPECTED_CHECKS_PATH} ${why}。PR を main に rebase してから再実行すること`);
    process.exit(3);
  };
  const res = spawnSync('gh', ['api', `repos/{owner}/{repo}/contents/${EXPECTED_CHECKS_PATH}?ref=${headRefOid}`], {
    encoding: 'utf8',
  });
  if (res.status !== 0) fail(`を取得できません (${res.stderr?.trim() || res.stdout?.trim() || 'gh api 失敗'})`);
  let text = '';
  try {
    const body = JSON.parse(res.stdout);
    if (body?.encoding !== 'base64' || typeof body.content !== 'string') {
      throw new Error(`encoding=${JSON.stringify(body?.encoding ?? null)}`);
    }
    text = Buffer.from(body.content, 'base64').toString('utf8');
  } catch (err) {
    fail(`の gh api 応答を読めません (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = parseExpectedChecksJson(text);
  if ('error' in parsed) fail(`を期待集合として読めません (${parsed.error})`);
  expectedCache.set(headRefOid, parsed.checks);
  return parsed.checks;
}

function report(label, { headSha, baseRefName, checks }, expected, verdict) {
  const expectedLabel = expected.length > 0 ? String(expected.length) : `skipped(base=${baseRefName})`;
  console.log(
    `${label} head=${headSha} checks=${checks.length} nonSUCCESS=${verdict.failed.length} missing=${verdict.missing.length} expected=${expectedLabel}`,
  );
  for (const c of checks) console.log(`${c.name}\t${c.conclusion || c.status}`);
  for (const name of verdict.missing) console.log(`${name}\tMISSING`);
}

const deadline = Date.now() + timeoutMin * 60_000;
for (;;) {
  const pr = fetchPr();
  const expected = pr.baseRefName === MAIN_BRANCH ? loadExpectedChecks(pr.headRefOid) : [];
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
