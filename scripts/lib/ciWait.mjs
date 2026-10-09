// scripts/ci-wait.mjs の純関数部 (期待 check 集合の導出と判定)。
//
// 動機 (第 7 回レビュー E8): 以前の ci-wait は「出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED なら
// exit 0」だった。push 直後に CI の job だけが check として登録され、e2e / lighthouse の workflow run
// がまだ現れていない瞬間に呼ぶと、そこだけで SETTLED / exit 0 になりうる。また必須 job が
// SKIPPED でも緑扱いだった。merge 判定は「必須 check が全部そろって SUCCESS」を肯定形で確認する
// (memory: feedback_merge_gate_ci_wait_only)。
//
// 期待集合は .github/workflows/*.yml から導出する (手書きの定数を持たない)。PR で必ず走る check =
// `on:` に pull_request を持ち (paths / paths-ignore / types で絞っていない) workflow の、
// `if:` / `strategy:` の無い job。check 名は job の `name:`、無ければ job id (GitHub の既定)。
// 本格的な YAML parser は依存に無いので、GitHub Actions workflow の定型 (2 スペース indent の
// top-level `on:` / `jobs:`) だけを読む行指向の parser にしている。tests/scripts/ci-wait.test.ts が
// 今の workflow から導出した集合を固定し、job の追加 / 削除・書式の逸脱をドリフトとして検出する。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PENDING_STATES = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'EXPECTED']);
// 期待集合に無い check (将来足された第三者 app 等) に対する従来どおりの合格条件。
export const PASS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
// vercel の deploy check は判定から除外する (merge 条件は repo CI のみ)。
const IGNORED_CHECK_RE = /vercel/i;

const PR_FILTER_KEYS = ['paths', 'paths-ignore', 'types'];

function stripComment(line) {
  // 行コメントと末尾コメント (値に '#' を含む workflow は無い前提。quote 内は考慮しない)
  if (/^\s*#/.test(line)) return '';
  return line.replace(/\s+#.*$/, '');
}

function unquote(value) {
  const v = value.trim();
  const m = v.match(/^(['"])(.*)\1$/);
  return m ? m[2] : v;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** `key: value` の行を分解する。key の後に `:` が無ければ null。 */
function splitKey(line) {
  const m = line.trim().match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
  return m ? { key: m[1], value: (m[2] ?? '').trim() } : null;
}

/** top-level `key:` の行 index と、その block (次の top-level key の手前まで) の行配列を返す。 */
function topLevelBlock(lines, key) {
  const start = lines.findIndex((l) => indentOf(l) === 0 && splitKey(l)?.key === key);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && indentOf(lines[i]) === 0) {
      end = i;
      break;
    }
  }
  return { head: splitKey(lines[start]), body: lines.slice(start + 1, end) };
}

/** inline の `on: push` / `on: [push, pull_request]` を event 名の配列へ。 */
function inlineEvents(value) {
  const v = value.trim();
  if (!v) return [];
  if (v.startsWith('[')) {
    return v
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => unquote(s))
      .filter(Boolean);
  }
  return [unquote(v)];
}

/**
 * workflow YAML を読み、PR trigger の有無・絞り込み・job 一覧を返す。
 * @param {string} source
 * @returns {{ pullRequest: boolean, filtered: string | null, jobs: { id: string, name: string, conditional: string | null }[] }}
 */
export function parseWorkflow(source) {
  const lines = source.split(/\r?\n/).map(stripComment);

  let pullRequest = false;
  let filtered = null;
  const on = topLevelBlock(lines, 'on');
  if (on) {
    if (on.head.value) {
      pullRequest = inlineEvents(on.head.value).includes('pull_request');
    } else {
      for (let i = 0; i < on.body.length; i++) {
        const line = on.body[i];
        if (line.trim() === '' || indentOf(line) !== 2) continue;
        const entry = splitKey(line);
        if (entry?.key !== 'pull_request') continue;
        pullRequest = true;
        // pull_request の sub-block (indent 4) に paths / paths-ignore / types があれば「走らないことがある」
        for (let j = i + 1; j < on.body.length; j++) {
          const sub = on.body[j];
          if (sub.trim() === '') continue;
          if (indentOf(sub) <= 2) break;
          const subKey = splitKey(sub)?.key;
          if (indentOf(sub) === 4 && subKey && PR_FILTER_KEYS.includes(subKey)) {
            filtered = subKey;
            break;
          }
        }
        break;
      }
    }
  }

  const jobs = [];
  const jobsBlock = topLevelBlock(lines, 'jobs');
  if (jobsBlock) {
    let current = null;
    for (const line of jobsBlock.body) {
      if (line.trim() === '') continue;
      const indent = indentOf(line);
      if (indent === 2) {
        const entry = splitKey(line);
        if (!entry) continue;
        current = { id: entry.key, name: entry.key, conditional: null };
        jobs.push(current);
      } else if (indent === 4 && current) {
        const entry = splitKey(line);
        if (!entry) continue;
        if (entry.key === 'name' && entry.value) current.name = unquote(entry.value);
        else if (entry.key === 'if' && !current.conditional) current.conditional = 'if';
        else if (entry.key === 'strategy' && !current.conditional) current.conditional = 'strategy';
      }
    }
  }

  return { pullRequest, filtered, jobs };
}

/**
 * workflows ディレクトリから「PR で必ず走る check 名」の集合を導出する。
 * 除外した workflow / job は理由付きで返す (呼び出し側が表示できるように)。
 * @param {string} workflowsDir
 * @returns {{ expected: string[], excluded: { workflow: string, job?: string, reason: string }[] }}
 */
export function expectedPrChecks(workflowsDir) {
  const expected = new Set();
  const excluded = [];
  const files = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  for (const file of files) {
    const wf = parseWorkflow(readFileSync(join(workflowsDir, file), 'utf8'));
    if (!wf.pullRequest) {
      excluded.push({ workflow: file, reason: 'no pull_request trigger' });
      continue;
    }
    if (wf.filtered) {
      excluded.push({ workflow: file, reason: `pull_request filtered by ${wf.filtered}` });
      continue;
    }
    for (const job of wf.jobs) {
      if (job.conditional) {
        excluded.push({ workflow: file, job: job.id, reason: `job has ${job.conditional}:` });
        continue;
      }
      expected.add(job.name);
    }
  }
  return { expected: [...expected], excluded };
}

/**
 * `gh pr view --json statusCheckRollup` の配列を name/status/conclusion に揃え、vercel を除外する。
 * CheckRun は name/status/conclusion、StatusContext は context/state を持つ。
 */
export function normalizeRollup(rollup) {
  return (rollup ?? [])
    .map((c) => ({
      name: c.name ?? c.context ?? '(unnamed)',
      status: c.status ?? c.state ?? '',
      conclusion: c.conclusion ?? c.state ?? '',
    }))
    .filter((c) => !IGNORED_CHECK_RE.test(c.name));
}

/**
 * 判定。settled = pending 無し かつ 期待 check が全部そろっている。ok = settled かつ失敗無し。
 * 期待 check は SUCCESS のみ合格 (SKIPPED / NEUTRAL は必須 job が走っていないので失敗)。
 * 期待集合に無い check は従来どおり PASS_CONCLUSIONS で判定する。
 * @param {{ name: string, status: string, conclusion: string }[]} checks
 * @param {readonly string[]} expected
 */
export function evaluateChecks(checks, expected) {
  const expectedSet = new Set(expected);
  const present = new Set(checks.map((c) => c.name));
  const pending = checks.filter((c) => PENDING_STATES.has(c.status));
  const missing = expected.filter((name) => !present.has(name));
  const failed = checks.filter((c) =>
    expectedSet.has(c.name) ? c.conclusion !== 'SUCCESS' : !PASS_CONCLUSIONS.has(c.conclusion),
  );
  const settled = checks.length > 0 && pending.length === 0 && missing.length === 0;
  return { pending, missing, failed, settled, ok: settled && failed.length === 0 };
}
