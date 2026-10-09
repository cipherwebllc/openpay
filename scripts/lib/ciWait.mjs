// scripts/ci-wait.mjs の純関数部 (期待 check 集合と判定)。
//
// 動機 (第 7 回レビュー E8): 以前の ci-wait は「出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED なら
// exit 0」だった。push 直後に CI の job だけが check として登録され、e2e / lighthouse の workflow run
// がまだ現れていない瞬間に呼ぶと、そこだけで SETTLED / exit 0 になりうる。また必須 job が
// SKIPPED でも緑扱いだった。merge 判定は「必須 check が全部そろって SUCCESS」を肯定形で確認する
// (memory: feedback_merge_gate_ci_wait_only)。
//
// 期待集合は EXPECTED_PR_CHECKS の定数 (main 向け PR で必ず走る check 名)。実行時にローカルの
// workflow から導出すると、監視している PR の HEAD と結び付かない (job を足した PR を main から
// 監視すると旧集合で exit 0) ので、定数にして tests/scripts/ci-wait.test.ts が workflow とのドリフトを
// 検出する: analyzeWorkflows() が .github/workflows を解析し、PR で必ず走る job 名の集合が定数と
// 一致すること・解析できない形 (未対応の on の形・matrix・reusable workflow・式や複数行の name・
// if/needs の組み合わせ・flow 形式の jobs) が PR trigger の workflow に現れたら unsupported として
// test を落とす (fail-closed・黙って除外しない)。
//
// CLI は定数を「対象 PR の HEAD にあるこのファイル」から読む (parseExpectedChecks): 必須 job と定数を
// 同時に足した PR を main 側のスクリプトで監視しても、PR 側の集合で判定するため。配列リテラルの形は
// parseExpectedChecks が読めるもの (quote 付き文字列の配列・行コメント可) に固定し、test が自分自身を
// 読んで定数と一致することを確かめる。
//
// 期待集合を適用するのは PR の base が main のときだけ。積み上げ PR (base が main 以外) では
// 届かない check を待ち続けないよう、従来の判定 (出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED) に戻す。

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAIN_BRANCH = 'main';

// main 向け PR で必ず走る check 名 (job の name: か job id)。workflow の job を足す / 外す PR はここも更新する。
export const EXPECTED_PR_CHECKS = Object.freeze([
  'audit', // ci.yml
  'e2e-prodflags', // e2e.yml
  'lighthouse', // lighthouse.yml
  'lua-real', // ci.yml
  'playwright', // e2e.yml
  'test', // ci.yml
]);

export const PENDING_STATES = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'EXPECTED']);
// 期待集合に無い check (将来足された第三者 app 等)・base が main 以外のときの従来どおりの合格条件。
export const PASS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
// vercel の deploy check は判定から除外する (merge 条件は repo CI のみ)。
const IGNORED_CHECK_RE = /vercel/i;

// ---------------------------------------------------------------------------
// workflow 解析 (ドリフト検出用・実行時には使わない)
//
// 本格的な YAML parser は依存に無いので、GitHub Actions workflow の定型 (2 スペース indent) だけを
// 読む行指向の parser。読めない形は黙って解釈せず unsupported に積む。
// ---------------------------------------------------------------------------

const PR_FILTER_KEYS = new Set(['paths', 'paths-ignore', 'types']);
const PR_BRANCH_KEYS = new Set(['branches', 'branches-ignore']);
const GLOB_RE = /[*?[\]!+]/;

/** 行コメントと (quote の外の) 末尾コメントを落とす。 */
function stripComment(line) {
  if (/^\s*#/.test(line)) return '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function unquote(value) {
  const v = value.trim();
  const m = v.match(/^(['"])(.*)\1$/);
  return m ? m[2] : v;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** `key: value` の行を分解する (key は quote 可)。key の後に `:` が無ければ null。 */
function splitKey(line) {
  const m = line.trim().match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*)):(?:\s+(.*))?$/);
  if (!m) return null;
  return { key: m[1] ?? m[2] ?? m[3], value: (m[4] ?? '').trim() };
}

/** flow 形式の `[a, b]` / `{a: 1, b: {c: d}}` を、ネストを尊重して要素ごとに分ける。 */
function splitFlow(inner) {
  const parts = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** `[a, b]` → ['a', 'b']。flow seq でなければ null。 */
function flowList(value) {
  const v = value.trim();
  if (!v.startsWith('[') || !v.endsWith(']')) return null;
  return splitFlow(v.slice(1, -1)).map(unquote).filter(Boolean);
}

/** `{a: x, b: {..}}` → [{key, value}]。flow map でなければ null。 */
function flowMap(value) {
  const v = value.trim();
  if (!v.startsWith('{') || !v.endsWith('}')) return null;
  const inner = v.slice(1, -1).trim();
  if (!inner) return [];
  const entries = [];
  for (const part of splitFlow(inner)) {
    const entry = splitKey(part) ?? (part.match(/^([\w-]+):$/) ? { key: part.slice(0, -1), value: '' } : null);
    if (!entry) return undefined; // 読めない
    entries.push(entry);
  }
  return entries;
}

/** value が「空の map」(null / {} / 空) か。 */
function isEmptyValue(value) {
  const v = value.trim();
  return v === '' || v === '{}' || v === 'null' || v === '~';
}

/** top-level `key:` の行と、その block (次の top-level key の手前まで) を返す。 */
function topLevelBlock(lines, key) {
  const start = lines.findIndex((l) => l.trim() !== '' && indentOf(l) === 0 && splitKey(l)?.key === key);
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

/** `- item` 行 (指定 indent) を集める。他の形が混ざれば null。 */
function blockList(lines, indent) {
  const out = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (indentOf(line) !== indent || !line.trim().startsWith('- ')) return null;
    out.push(unquote(line.trim().slice(2)));
  }
  return out;
}

/** pull_request の設定 (flow map の entries か、block の行) から filtered / branches を読む。 */
function readPullRequestConfig(entries, unsupported) {
  const cfg = { filtered: null, branches: null, branchesIgnore: null };
  for (const { key, value, sub } of entries) {
    if (PR_FILTER_KEYS.has(key)) {
      cfg.filtered = cfg.filtered ?? key;
      continue;
    }
    if (PR_BRANCH_KEYS.has(key)) {
      let list = flowList(value);
      if (list === null && isEmptyValue(value) && sub) list = blockList(sub, 6);
      if (list === null) {
        unsupported.push(`on.pull_request.${key}: unreadable list`);
        continue;
      }
      if (list.some((b) => GLOB_RE.test(b))) {
        unsupported.push(`on.pull_request.${key}: glob pattern (${list.join(', ')})`);
        continue;
      }
      if (key === 'branches') cfg.branches = list;
      else cfg.branchesIgnore = list;
      continue;
    }
    unsupported.push(`on.pull_request.${key}: unsupported key`);
  }
  return cfg;
}

/** `on:` を読み、PR trigger の有無と pull_request の設定を返す。 */
function readTriggers(lines, unsupported) {
  const result = { pullRequest: false, config: null };
  const on = topLevelBlock(lines, 'on');
  if (!on) {
    unsupported.push('on: missing');
    return result;
  }
  const value = on.head.value;
  if (value) {
    const list = flowList(value);
    const map = flowMap(value);
    if (list) {
      result.pullRequest = list.includes('pull_request');
      if (result.pullRequest) result.config = readPullRequestConfig([], unsupported);
    } else if (map) {
      const pr = map.find((e) => e.key === 'pull_request');
      if (pr) {
        result.pullRequest = true;
        const inner = isEmptyValue(pr.value) ? [] : flowMap(pr.value);
        if (inner === null || inner === undefined) unsupported.push('on.pull_request: unreadable flow map');
        else result.config = readPullRequestConfig(inner, unsupported);
      }
    } else if (map === undefined) {
      unsupported.push('on: unreadable flow value');
    } else if (/^[\w-]+$/.test(unquote(value))) {
      result.pullRequest = unquote(value) === 'pull_request';
      if (result.pullRequest) result.config = readPullRequestConfig([], unsupported);
    } else {
      unsupported.push(`on: unreadable value (${value})`);
    }
    return result;
  }
  // block 形式: `- event` の列か `event:` の map
  const body = on.body.filter((l) => l.trim() !== '');
  if (body.length === 0) {
    unsupported.push('on: empty');
    return result;
  }
  if (body.every((l) => indentOf(l) === 2 && l.trim().startsWith('- '))) {
    const list = blockList(body, 2);
    result.pullRequest = list.includes('pull_request');
    if (result.pullRequest) result.config = readPullRequestConfig([], unsupported);
    return result;
  }
  for (let i = 0; i < on.body.length; i++) {
    const line = on.body[i];
    if (line.trim() === '') continue;
    if (indentOf(line) !== 2) continue; // sub-block は各 event のところで読む
    const entry = splitKey(line);
    if (!entry) {
      unsupported.push(`on: unreadable line (${line.trim()})`);
      continue;
    }
    if (entry.key !== 'pull_request') continue;
    result.pullRequest = true;
    // sub-block (indent 4 の key と、その下 indent 6 の行)
    const sub = [];
    for (let j = i + 1; j < on.body.length; j++) {
      const l = on.body[j];
      if (l.trim() === '') continue;
      if (indentOf(l) <= 2) break;
      sub.push(l);
    }
    if (!isEmptyValue(entry.value)) {
      const inner = flowMap(entry.value);
      if (inner === null || inner === undefined || sub.length > 0) {
        unsupported.push('on.pull_request: unreadable value');
        continue;
      }
      result.config = readPullRequestConfig(inner, unsupported);
      continue;
    }
    const entries = [];
    for (let k = 0; k < sub.length; k++) {
      if (indentOf(sub[k]) !== 4) {
        if (entries.length === 0) unsupported.push(`on.pull_request: unreadable line (${sub[k].trim()})`);
        continue; // indent 6 以深は直前の key の sub として下で拾う
      }
      const e = splitKey(sub[k]);
      if (!e) {
        unsupported.push(`on.pull_request: unreadable line (${sub[k].trim()})`);
        continue;
      }
      const deeper = [];
      for (let m = k + 1; m < sub.length && indentOf(sub[m]) > 4; m++) deeper.push(sub[m]);
      entries.push({ key: e.key, value: e.value, sub: deeper });
    }
    result.config = readPullRequestConfig(entries, unsupported);
  }
  return result;
}

/** `jobs:` を読み、job ごとに name / 条件 / needs を返す。読めない形は unsupported に積む。 */
function readJobs(lines, unsupported) {
  const jobs = [];
  const block = topLevelBlock(lines, 'jobs');
  if (!block) {
    unsupported.push('jobs: missing');
    return jobs;
  }
  // `jobs: {a: {...}}` (flow 形式) は job 名を読めないので unsupported (黙って jobs=[] にしない)
  if (block.head.value) {
    unsupported.push(`jobs: inline value (${block.head.value})`);
    return jobs;
  }
  let current = null;
  for (let i = 0; i < block.body.length; i++) {
    const line = block.body[i];
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    if (indent === 2) {
      const entry = splitKey(line);
      if (!entry) {
        unsupported.push(`jobs: unreadable line (${line.trim()})`);
        current = null;
        continue;
      }
      current = { id: entry.key, name: entry.key, conditional: null, needs: [] };
      // `test: {name: x, runs-on: y}` (flow 形式の job) は name: 等を読めないので unsupported
      if (entry.value) current.conditional = 'inline value';
      jobs.push(current);
      continue;
    }
    if (indent !== 4 || !current) continue;
    const entry = splitKey(line);
    if (!entry) continue;
    const label = `jobs.${current.id}.${entry.key}`;
    switch (entry.key) {
      case 'name': {
        // check 名が静的に決まらない job は、名前を推測せず「解析できない」として扱う
        const raw = entry.value;
        if (!raw || /^[|>]/.test(raw)) current.conditional = current.conditional ?? 'block scalar or empty name';
        else if (raw.includes('${{')) current.conditional = current.conditional ?? 'expression in name';
        else current.name = unquote(raw);
        break;
      }
      case 'if':
        current.conditional = current.conditional ?? 'if:';
        break;
      case 'strategy':
        current.conditional = current.conditional ?? 'strategy:';
        break;
      case 'uses':
        current.conditional = current.conditional ?? 'uses:';
        break;
      case 'needs': {
        let list = flowList(entry.value);
        if (list === null && entry.value && /^[\w-]+$/.test(unquote(entry.value))) list = [unquote(entry.value)];
        if (list === null && isEmptyValue(entry.value)) {
          const sub = [];
          for (let j = i + 1; j < block.body.length; j++) {
            const l = block.body[j];
            if (l.trim() === '') continue;
            if (indentOf(l) <= 4) break;
            sub.push(l);
          }
          list = blockList(sub, 6);
        }
        if (list === null) unsupported.push(`${label}: unreadable list`);
        else current.needs = list;
        break;
      }
      default:
        break;
    }
  }
  return jobs;
}

/**
 * workflow YAML を読む。
 * @param {string} source
 * @returns {{ pullRequest: boolean, filtered: string | null, branches: string[] | null, branchesIgnore: string[] | null,
 *   jobs: { id: string, name: string, conditional: string | null, needs: string[] }[], unsupported: string[] }}
 */
export function parseWorkflow(source) {
  const lines = source.split(/\r?\n/).map(stripComment);
  const unsupported = [];
  const triggers = readTriggers(lines, unsupported);
  const jobs = readJobs(lines, unsupported);
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
    // on: が読めない workflow は PR で走るか分からないので常に unsupported (job も数えない)
    const onProblems = wf.unsupported.filter((r) => r.startsWith('on'));
    if (onProblems.length > 0) {
      for (const reason of onProblems) unsupported.push({ workflow: file, reason });
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
    for (const reason of wf.unsupported.filter((r) => !r.startsWith('on'))) unsupported.push({ workflow: file, reason });
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

// ---------------------------------------------------------------------------
// 対象 PR の HEAD にあるこのファイルから定数を読む
// ---------------------------------------------------------------------------

/**
 * このファイルのソースから EXPECTED_PR_CHECKS の配列リテラルを読む。読めなければ null。
 * 形は `EXPECTED_PR_CHECKS = Object.freeze([ 'a', // comment \n 'b' ])` (quote 付き文字列のみ)。
 * @param {string} source
 * @returns {string[] | null}
 */
export function parseExpectedChecks(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const m = stripped.match(/EXPECTED_PR_CHECKS\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]\s*\)/);
  if (!m) return null;
  const items = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const names = [];
  for (const item of items) {
    const q = item.match(/^(['"])([^'"]+)\1$/);
    if (!q) return null;
    names.push(q[2]);
  }
  if (names.length === 0 || new Set(names).size !== names.length) return null;
  return names;
}

/** git の blob hash (GitHub contents API の sha と同じ)。 */
export function blobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

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

/** base branch から期待集合を決める。main 以外 (積み上げ PR) は空 = 従来の判定。 */
export function expectedChecksFor(baseRefName) {
  return baseRefName === MAIN_BRANCH ? [...EXPECTED_PR_CHECKS] : [];
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
