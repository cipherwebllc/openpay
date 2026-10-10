// ci-wait の期待集合 (scripts/ci-expected-checks.json) と .github/workflows のドリフト検査用の workflow 解析
// (tests/scripts/ci-wait.test.ts が使う・ci-wait の CLI は使わない)。
//
// 脅威モデル: 守る対象は、保守者が PR で走る workflow / job をうっかり足し (または外し)、期待集合の更新を忘れること。
// 忘れたまま merge すると ci-wait は足された check を待たずに exit 0 する (偽成功)。そのため「必須 / 除外」は、
// 読んだ値が対応する形だと確かめてから判定し、対応する形の外は必ず unsupported にして test を落とす (fail-closed・
// 黙って除外しない)。リポ内で意図的に検査を欺く難読化はレビューで止める範囲。
//
// YAML は `yaml` で読む (scripts/lib/workflowYaml.mjs)。CLI (scripts/ci-wait.mjs) は対象 PR の HEAD の JSON だけを読む
// 設計で YAML を読まないので、`yaml` に依存するこの解析は CLI が import する scripts/lib/ciWait.mjs から分けている。
// 検査は「文書 → トップレベル → on: / jobs:」の順で、文書に問題 (workflowYaml の problems) があれば on: / jobs: は
// 読まない (形の分からない文書から「pull_request が無い」とは言わない)。
//   - トップレベルの key は GitHub の workflow の key (TOP_LEVEL_KEYS) だけ。それ以外 (NBSP で字下げしたつもりの行が
//     トップレベルの key になった等) は、on: の entry を読み落としている疑いがあるので unsupported。
//   - on: イベント名 1 つ / 配列 / mapping のどの形から来ても、各 entry を同じ eventProblem() に通す (イベント名は
//     EVENT_NAME_RE・値は null / mapping か、pull_request 以外の配列 (schedule) だけ)。`on: []` / `{}` / `null` は
//     今の workflow に無い形なので unsupported。
//   - pull_request の値は null か mapping。key は paths / paths-ignore / types (= filtered) と branches /
//     branches-ignore だけで、値は空でない文字列の空でない配列。branches / branches-ignore は完全一致で比べられる
//     文字列だけを受け入れ、glob の特殊文字やエスケープ (`\`) を含むものは unsupported。
//   - jobs: 空でない mapping。check 名が静的に決まらない job (name が文字列でない・式・改行を含む・if / strategy /
//     uses・定義が mapping でない) は、PR で走る workflow のときだけ unsupported に数える。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN_BRANCH } from './ciWait.mjs';
import { isMapping, readWorkflowYaml } from './workflowYaml.mjs';

const TOP_LEVEL_KEYS = new Set(['name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs']);
const PR_FILTER_KEYS = new Set(['paths', 'paths-ignore', 'types']);
const PR_BRANCH_KEYS = new Set(['branches', 'branches-ignore']);
const GLOB_RE = /[*?[\]!+]/;
const EVENT_NAME_RE = /^[a-z][a-z_]*$/;

/** 空でない文字列の空でない配列 (branches / paths 等) ならそれを、そうでなければ null を返す。 */
function stringList(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((item) => typeof item === 'string' && item.trim() !== '') ? value : null;
}

/** pull_request の値 (null か mapping) から filtered / branches を読む。 */
function readPullRequestConfig(value, unsupported) {
  const cfg = { filtered: null, branches: null, branchesIgnore: null };
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (!PR_FILTER_KEYS.has(key) && !PR_BRANCH_KEYS.has(key)) {
      unsupported.push(`on.pull_request.${key}: unsupported key`);
      continue;
    }
    const list = stringList(raw);
    if (list === null) {
      unsupported.push(`on.pull_request.${key}: unreadable list`);
      continue;
    }
    if (PR_FILTER_KEYS.has(key)) {
      cfg.filtered = cfg.filtered ?? key;
      continue;
    }
    // branches / branches-ignore は GitHub の filter pattern (glob・`\` のエスケープ) なので、main との比較は
    // 完全一致で扱える文字列 (glob の特殊文字もエスケープも無いもの) だけで行う。`ma\in` は GitHub では main に一致する。
    // paths / paths-ignore / types は有れば値によらず filtered なので、値の書き方は見ない。
    if (list.some((b) => GLOB_RE.test(b))) {
      unsupported.push(`on.pull_request.${key}: glob pattern (${list.join(', ')})`);
      continue;
    }
    if (list.some((b) => b.includes('\\'))) {
      unsupported.push(`on.pull_request.${key}: escape in pattern (${list.join(', ')})`);
      continue;
    }
    if (key === 'branches') cfg.branches = list;
    else cfg.branchesIgnore = list;
  }
  return cfg;
}

/** on: の値を形によらず [name, value] に揃える。形自体が読めなければ unsupported に積んで null。 */
function eventEntries(on, unsupported) {
  if (on === undefined) {
    unsupported.push('on: missing');
    return null;
  }
  let events = null;
  if (typeof on === 'string') events = [[on, null]];
  else if (Array.isArray(on)) events = on.map((name) => [name, null]);
  else if (isMapping(on)) events = Object.entries(on);
  if (on === null || events?.length === 0) {
    unsupported.push(`on: empty (${JSON.stringify(on)})`);
    return null;
  }
  if (events === null) {
    unsupported.push(`on: unreadable value (${JSON.stringify(on)})`);
    return null;
  }
  return events;
}

/**
 * on: の 1 entry を検査する。イベント名 1 つ / 配列 / mapping のどの形から来ても同じこの関数を通す (形ごとに検査が
 * 違うと、片方だけ素通りする穴になる)。問題があれば理由を返す。値は null / mapping か、pull_request 以外の配列
 * (schedule の cron 等) だけ。非 PR イベントの値の中身は見ない (pull_request の値は readPullRequestConfig が読む)。
 * @param {[unknown, unknown]} event
 */
function eventProblem([name, value]) {
  if (typeof name !== 'string' || !EVENT_NAME_RE.test(name)) return `on: unknown event (${typeof name === 'string' ? name : JSON.stringify(name)})`;
  const ok = value === null || isMapping(value) || (Array.isArray(value) && name !== 'pull_request');
  return ok ? null : `on.${name}: unreadable value (${JSON.stringify(value)})`;
}

/** `on:` を読み、PR trigger の有無と pull_request の設定を返す。 */
function readTriggers(on, unsupported) {
  const result = { pullRequest: false, config: null };
  const events = eventEntries(on, unsupported);
  if (!events) return result;
  // 「pull_request が無いので除外」と言えるのは、on: の全 entry が対応する形のときだけ (呼び出し側が unsupported を見る)
  for (const event of events) {
    const problem = eventProblem(event);
    if (problem) unsupported.push(problem);
  }
  const pr = events.find(([name]) => name === 'pull_request');
  if (!pr) return result;
  result.pullRequest = true;
  if (eventProblem(pr)) return result;
  result.config = readPullRequestConfig(pr[1], unsupported);
  return result;
}

/**
 * job の `name:` の値を check 名として採用できない理由を返す (採用できれば null)。
 * 文字列でない (空・数値・配列等)・式を含む・改行や制御文字を含む名前は、check 名を推測せず採用しない。
 */
function nameProblem(value) {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return 'empty name';
  if (typeof value !== 'string') return 'name is not a string';
  if (value.includes('${{')) return 'expression in name';
  if (/[\r\n]/.test(value)) return 'multi-line name';
  if (/[\p{Cc}\u2028\u2029]/u.test(value)) return 'control character in name';
  return null;
}

/** `jobs:` を読み、job ごとに name / 条件 / needs を返す。読めない形は unsupported に積む。 */
function readJobs(value, unsupported) {
  const jobs = [];
  if (value === undefined) {
    unsupported.push('jobs: missing');
    return jobs;
  }
  if (!isMapping(value) || Object.keys(value).length === 0) {
    unsupported.push(value === null || isMapping(value) ? 'jobs: empty' : `jobs: not a mapping (${JSON.stringify(value)})`);
    return jobs;
  }
  for (const [id, definition] of Object.entries(value)) {
    const job = { id, name: id, conditional: null, needs: [] };
    jobs.push(job);
    if (!isMapping(definition)) {
      job.conditional = definition === null ? 'empty definition' : 'definition that is not a mapping';
      continue;
    }
    for (const [key, field] of Object.entries(definition)) {
      switch (key) {
        case 'name': {
          // check 名が静的に決まらない job は、名前を推測せず「解析できない」として扱う。
          const problem = nameProblem(field);
          if (problem) job.conditional = job.conditional ?? problem;
          else job.name = field;
          break;
        }
        case 'if':
        case 'strategy':
        case 'uses':
          job.conditional = job.conditional ?? `${key}:`;
          break;
        case 'needs': {
          const list = typeof field === 'string' ? [field] : Array.isArray(field) && field.every((n) => typeof n === 'string') ? field : null;
          if (list === null) unsupported.push(`jobs.${id}.needs: unreadable list`);
          else job.needs = list;
          break;
        }
        default:
          break;
      }
    }
  }
  return jobs;
}

/**
 * workflow YAML を読む。文書かトップレベルに問題があれば on: / jobs: は読まない
 * (pullRequest=false・jobs=[] だが、呼び出し側は unsupported を見て除外せず落とす)。
 * @param {string} source
 * @returns {{ pullRequest: boolean, filtered: string | null, branches: string[] | null, branchesIgnore: string[] | null,
 *   jobs: { id: string, name: string, conditional: string | null, needs: string[] }[], unsupported: string[] }}
 */
export function parseWorkflow(source) {
  const unread = (unsupported) => ({ pullRequest: false, filtered: null, branches: null, branchesIgnore: null, jobs: [], unsupported });
  const read = readWorkflowYaml(source);
  if ('problems' in read) return unread(read.problems);
  const unknownKeys = Object.keys(read.data).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) return unread(unknownKeys.map((key) => `top-level: unknown key (${JSON.stringify(key)})`));
  const unsupported = [];
  const triggers = readTriggers(read.data.on, unsupported);
  const jobs = readJobs(read.data.jobs, unsupported);
  return {
    pullRequest: triggers.pullRequest,
    filtered: triggers.config?.filtered ?? null,
    branches: triggers.config?.branches ?? null,
    branchesIgnore: triggers.config?.branchesIgnore ?? null,
    jobs,
    unsupported,
  };
}

/**
 * workflows ディレクトリを解析し、main 向け PR で必ず走る check 名 (required) を返す。
 * excluded = 走らないと分かる workflow (理由付き)。unsupported = 解析できない形 (fail-closed で test を落とす)。
 * @param {string} workflowsDir
 */
export function analyzeWorkflows(workflowsDir) {
  const required = [];
  const excluded = [];
  const unsupported = [];
  const owners = new Map();
  const files = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  for (const file of files) {
    const wf = parseWorkflow(readFileSync(join(workflowsDir, file), 'utf8'));
    // 文書・on: の問題 (= jobs 以外) は PR で走るか分からないので常に unsupported (job も数えない)。
    // jobs の問題は PR で走る workflow のときだけ数える (cron の workflow は matrix / if を自由に使える)
    const blocking = wf.unsupported.filter((r) => !r.startsWith('jobs'));
    if (blocking.length > 0) {
      for (const reason of blocking) unsupported.push({ workflow: file, reason });
      continue;
    }
    if (!wf.pullRequest) {
      excluded.push({ workflow: file, reason: 'no pull_request trigger' });
      continue;
    }
    if (wf.filtered) {
      excluded.push({ workflow: file, reason: `pull_request filtered by ${wf.filtered}` });
      continue;
    }
    if (wf.branches && !wf.branches.includes(MAIN_BRANCH)) {
      excluded.push({ workflow: file, reason: `pull_request branches exclude ${MAIN_BRANCH}` });
      continue;
    }
    if (wf.branchesIgnore?.includes(MAIN_BRANCH)) {
      excluded.push({ workflow: file, reason: `pull_request branches-ignore has ${MAIN_BRANCH}` });
      continue;
    }
    for (const reason of wf.unsupported) unsupported.push({ workflow: file, reason });
    const byId = new Map(wf.jobs.map((j) => [j.id, j]));
    for (const job of wf.jobs) {
      if (job.conditional) {
        unsupported.push({ workflow: file, job: job.id, reason: `job has ${job.conditional}` });
        continue;
      }
      const badNeed = job.needs.find((n) => !byId.has(n) || byId.get(n).conditional);
      if (badNeed) {
        unsupported.push({ workflow: file, job: job.id, reason: `needs ${badNeed} (unknown or conditional)` });
        continue;
      }
      if (owners.has(job.name)) {
        unsupported.push({ workflow: file, job: job.id, reason: `duplicate check name ${job.name} (also ${owners.get(job.name)})` });
        continue;
      }
      owners.set(job.name, file);
      required.push(job.name);
    }
  }
  return { required, excluded, unsupported };
}
