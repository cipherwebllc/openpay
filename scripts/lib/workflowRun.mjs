// GitHub Actions workflow (.github/workflows/*.yml) の step から `run:` を取り出し、依存の install の手順と npm / npx の
// 呼び出しを検査するための純関数群 (tests/scripts/workflow-guards.test.ts が使う)。第三者の YAML パーサを足さない
// (CLAUDE.md 掟 16) 代わりに、このリポの workflow が使う形だけを読み、**読めない形・読み残しうる形は throw する
// (fail-closed)**。
//
// 脅威モデル (docs/DEPLOY_CHECKLIST.md §7.14): 守る相手は、保守者 (AI エージェントを含む) が**うっかり** workflow に
// `npm install` や `npx …` を足すこと。意図的に検査を欺く書き方 (変数に入れたコマンドを後で展開する等) はレビューの
// 範囲。シェルを分解して意味を推測することはせず (引用・コメント・here-doc・演算子の解釈の取り違えが往復の原因だった)、
// npm / npx / 2 つの gate の名前を含む行は「完全一致の許可リスト」だけを通す (installGuardViolations)。
//
// 読む YAML の形 (top-level の `jobs:` 以下だけ):
//   - job / job の key / step の key は引用符なしの `key:` か `key: value`。インデントは各階層の最初の行で決め、
//     揃っていない行は throw。steps は `- ` で始まるブロックシーケンス (インデントなし = indentless も可) で、
//     各 step は `- key: …` の行から始まる。
//   - 値: plain scalar (1 行・行末の " # comment" は落とす) / 1 行の引用符付き ('…' と、`\` を含まない "…") /
//     block scalar (`|` `|-` `|+` `>` `>-` `>+`。`>` は空行・深いインデントの行を含まないものだけ)。
//   throw する形: タブのインデント・CR 改行・引用符付きや複合 (`?` `<<`) の key・flow (`[` `{`)・アンカー / エイリアス
//   (`&` `*`)・タグ (`!`)・block scalar のインデント指示子 (`|2` 等)・複数行の plain / 引用符付き scalar (継続行)・
//   `\` を含む二重引用符・空の run・同じ key の重複・揃っていないインデント・step が 0 件の job (`uses:` の job を含む)。

const KEY_LINE = /^(\w[\w-]*):(?:[ \t]+(.*))?$/;
const BLANK_OR_COMMENT = /^\s*(?:#.*)?$/;

function lineError(line, message) {
  return new Error(`line ${line.at + 1}: ${message}`);
}

/** 空行・コメント行を飛ばした次の行を返す (消費しない)。インデントにタブがあれば throw。 */
function peek(state) {
  for (let at = state.i; at < state.lines.length; at++) {
    const text = state.lines[at];
    if (BLANK_OR_COMMENT.test(text)) continue;
    if (/^ *\t/.test(text)) throw new Error(`line ${at + 1}: a tab in the indentation is not read`);
    const indent = text.search(/\S/);
    return { at, indent, text: text.slice(indent).trimEnd() };
  }
  return null;
}

/** `key:` / `key: value` を読む。引用符付き・複合 (`?` / `<<`)・flow・シーケンスの行は throw。 */
function mappingEntry(line) {
  const m = KEY_LINE.exec(line.text);
  if (!m) throw lineError(line, `unreadable mapping key (quoted / complex / flow / sequence entries are not read): ${line.text}`);
  const value = (m[2] ?? '').trim();
  return { key: m[1], value: value.startsWith('#') ? '' : value };
}

/** key より深い行と空行・コメント行を読み飛ばす (読まない値 = env / with / strategy 等の中身)。 */
function skipNested(state, keyIndent) {
  while (state.i < state.lines.length) {
    const text = state.lines[state.i];
    if (!BLANK_OR_COMMENT.test(text) && text.search(/\S/) <= keyIndent) break;
    state.i++;
  }
}

/** block scalar の本文 (key より深い行) を読む。本文が無ければ ''。 */
function readBlockScalar(state, line, keyIndent, header) {
  const m = /^([|>])([+-]?)(?:\s+#.*)?$/.exec(header);
  if (!m) throw lineError(line, `unsupported block scalar header (indentation indicator etc.): ${header}`);
  const body = [];
  let bodyIndent = null;
  while (state.i < state.lines.length) {
    const text = state.lines[state.i];
    if (text.trim() === '') {
      body.push('');
      state.i++;
      continue;
    }
    const spaces = /^ */.exec(text)[0].length;
    if (text[spaces] === '\t' && (bodyIndent === null || spaces < bodyIndent)) {
      throw new Error(`line ${state.i + 1}: a tab in the indentation is not read`);
    }
    if (bodyIndent === null) {
      if (spaces <= keyIndent) break;
      bodyIndent = spaces;
    }
    // 本文より浅い行 (コメント行を含む) で block scalar は終わる (YAML)。
    if (spaces < bodyIndent) break;
    body.push(text.slice(bodyIndent));
    state.i++;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  if (m[1] === '|') return body.join('\n');
  // folded: 空行と深いインデントの行は改行として残る (YAML) ので、1 行に畳める形だけを読む。
  if (body.some((text) => text === '' || /^\s/.test(text))) {
    throw lineError(line, 'a folded block scalar with blank or more-indented lines is not read');
  }
  return body.join(' ');
}

/** step の key の値を読み、値に属する行を消費する。 */
function readValue(state, line, keyIndent, value) {
  if (value === '') {
    skipNested(state, keyIndent);
    return { kind: 'nested', text: '' };
  }
  if (value[0] === '|' || value[0] === '>') {
    return { kind: 'block', text: readBlockScalar(state, line, keyIndent, value) };
  }
  let text;
  if (value[0] === "'") {
    const m = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(value);
    if (!m) throw lineError(line, `a multi-line or unterminated single-quoted scalar is not read: ${value}`);
    text = m[1].replace(/''/g, "'");
  } else if (value[0] === '"') {
    // `\` の escape (\n 等) は改行や別の文字を作るので、escape を含む二重引用符は読まない。
    const m = /^"([^"\\]*)"(?:\s+#.*)?$/.exec(value);
    if (!m) throw lineError(line, `a double-quoted scalar with escapes (\\), multiple lines or no closing quote is not read: ${value}`);
    text = m[1];
  } else {
    if (/^[&*!\[\]{},%@`]/.test(value) || /^[-?:](?:\s|$)/.test(value)) {
      throw lineError(line, `unsupported YAML (anchor / alias / tag / flow / indicator): ${value}`);
    }
    text = value.replace(/\s+#.*$/, '');
  }
  // plain / 引用符付きの scalar は次の深い行に続けられる (複数行の scalar)。続きは読まないので throw。
  const next = peek(state);
  if (next !== null && next.indent > keyIndent) throw lineError(next, 'a multi-line scalar (continuation line) is not read');
  return { kind: 'scalar', text };
}

/** `- key: …` から始まる 1 step を読む。 */
function parseStep(state, item, seqIndent) {
  const m = /^-( +)(\S.*)$/.exec(item.text);
  if (!m) throw lineError(item, 'a step must have its first key on the "- " line');
  const keyIndent = seqIndent + 1 + m[1].length;
  const keys = {};
  let run = null;
  let line = { at: item.at, indent: keyIndent, text: m[2] };
  state.i = item.at + 1;
  for (;;) {
    const { key, value } = mappingEntry(line);
    if (Object.hasOwn(keys, key) || (key === 'run' && run !== null)) throw lineError(line, `step has two ${key} keys`);
    const read = readValue(state, line, keyIndent, value);
    if (key === 'run') {
      if (read.text.trim() === '') throw lineError(line, 'an empty run (or a run value on the following lines) is not read');
      run = read.text;
    } else {
      keys[key] = read.kind === 'scalar' ? read.text : value;
    }
    const next = peek(state);
    if (next === null || next.indent <= seqIndent) break;
    if (next.indent !== keyIndent) throw lineError(next, `step keys must be at indent ${keyIndent}`);
    line = next;
    state.i = next.at + 1;
  }
  return { keys, run };
}

/** `steps:` の値 (ブロックシーケンス) を読む。 */
function parseSteps(state, keyIndent) {
  const first = peek(state);
  if (first === null || first.indent < keyIndent || !/^-(?:\s|$)/.test(first.text)) {
    throw new Error(`line ${(first?.at ?? state.lines.length - 1) + 1}: steps must be a non-empty block sequence of "- " items`);
  }
  const seqIndent = first.indent;
  const steps = [];
  for (let next = peek(state); next !== null && next.indent >= seqIndent; next = peek(state)) {
    if (next.indent > seqIndent) throw lineError(next, `unexpected indentation in steps (items are at indent ${seqIndent})`);
    if (!/^-(?:\s|$)/.test(next.text)) {
      if (seqIndent === keyIndent) break; // indentless: steps と同じ高さの key で終わる
      throw lineError(next, 'steps items must start with "- "');
    }
    steps.push(parseStep(state, next, seqIndent));
  }
  return steps;
}

/** 1 job の本文 (job の key より深い行) を読み、steps を返す。 */
function parseJob(state, jobIndent, name) {
  const first = peek(state);
  if (first === null || first.indent <= jobIndent) throw new Error(`job ${name} has no body`);
  const keyIndent = first.indent;
  let steps = null;
  for (let next = peek(state); next !== null && next.indent > jobIndent; next = peek(state)) {
    if (next.indent !== keyIndent) throw lineError(next, `keys of job ${name} must be at indent ${keyIndent}`);
    const { key, value } = mappingEntry(next);
    state.i = next.at + 1;
    if (key !== 'steps') {
      skipNested(state, keyIndent);
      continue;
    }
    if (steps !== null) throw lineError(next, `job ${name} has two steps keys`);
    if (value !== '') throw lineError(next, `steps of job ${name} must be a block sequence: ${value}`);
    steps = parseSteps(state, keyIndent);
  }
  // step の無い job (`uses:` で別 workflow を呼ぶ job を含む) は、中で何が走るかをここで読めない。
  if (steps === null || steps.length === 0) throw new Error(`job ${name} has no steps to read (a job without steps, e.g. uses:, is not read)`);
  return steps;
}

/**
 * 1 つの workflow ファイルを job ごとの step 配列に分ける。
 * @param {string} source
 * @returns {Array<{ job: string, steps: Array<{ keys: Record<string, string>, run: string | null }> }>}
 */
export function parseWorkflowJobs(source) {
  if (source.includes('\r')) throw new Error('a workflow with CR line endings is not read');
  const lines = source.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:(?:\s+#.*)?\s*$/.test(line));
  if (jobsAt === -1) throw new Error('workflow has no top-level jobs: (block mapping) to read');
  const state = { lines, i: jobsAt + 1 };
  const first = peek(state);
  if (first === null || first.indent === 0) throw new Error('jobs: has no jobs');
  const jobIndent = first.indent;
  const jobs = [];
  // インデント 0 の行 (jobs: の後ろの top-level key) で jobs は終わる。
  for (let next = peek(state); next !== null && next.indent > 0; next = peek(state)) {
    if (next.indent !== jobIndent) throw lineError(next, `jobs must be at indent ${jobIndent}`);
    const { key, value } = mappingEntry(next);
    if (value !== '') throw lineError(next, `job ${key} must be a block mapping: ${value}`);
    state.i = next.at + 1;
    jobs.push({ job: key, steps: parseJob(state, jobIndent, key) });
  }
  return jobs;
}

// ── 依存の install の手順の検査 ─────────────────────────────────────

// npm / npx / 2 つの gate に関わる行の目印。大文字小文字を問わない部分一致 (pnpm・npm_config_…・NPM_… も含む)。
const SENSITIVE = /npm|npx|lockfile-gate|installed-scripts-gate/i;
const SOURCE_GATE_LINE = 'node scripts/lockfile-gate.mjs';
const installedGateLine = (root) => `node scripts/installed-scripts-gate.mjs --rebuild ${root}`;
// install の行 → 直後の step で走らせる実体 gate の root。
const INSTALL_LINES = new Map([
  ['npm ci --ignore-scripts', 'node_modules'],
  ['npm ci --omit=dev --ignore-scripts', 'node_modules'],
  ['npm --prefix tools/lighthouse ci --ignore-scripts', 'tools/lighthouse/node_modules'],
]);
const GATE_LINES = new Set([SOURCE_GATE_LINE, ...new Set([...INSTALL_LINES.values()].map(installedGateLine))]);
// install / gate 以外で run に書いてよい npm の行 (今の workflow で使っている形だけ。足すときはここをレビューする)。
const OTHER_LINES = new Set([
  'npm run build',
  'npm run e2e',
  'npm run lint',
  'npm run typecheck',
  'npm --prefix packages/x402-sdk test',
]);
// 例外: 同じ run の前の行に `set -o pipefail` があるときだけ許す (パイプでも npm run build の失敗が step の失敗になる)。
const PIPEFAIL_LINES = new Set(['npm run build 2>&1 | tee build.log']);

/** 許可リストの全行 (docs / 報告用)。 */
export const ALLOWED_RUN_LINES = Object.freeze([...INSTALL_LINES.keys(), ...GATE_LINES, ...OTHER_LINES, ...PIPEFAIL_LINES]);

/** run を、bash の行継続 (`\` + 改行) を取り除いてから行に分ける (語を行継続で割った npm も 1 行で見る・前後の空白を除き、空行は落とす)。 */
export function runLines(run) {
  return run.replace(/\\\n/g, '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * workflow 1 本の依存 install の手順と npm / npx の呼び出しを検査し、違反を返す (空配列なら OK・読めない YAML は throw)。
 * 規則 (CLAUDE.md 掟 16・docs/DEPLOY_CHECKLIST.md §7.14):
 *   - run の行 (行継続は連結) のうち npm / npx / lockfile-gate / installed-scripts-gate を含むものは、前後の空白を除いた
 *     行全体が ALLOWED_RUN_LINES のどれかに完全一致しなければ違反。コメント・echo・引用・here-doc の中も区別しない
 *     (= これらの名前を run の中の説明文に書かない)。npx は許可リストに無い = 全面禁止。
 *   - install の行と gate の行は、その step の run がその 1 行だけ (`&&` で繋ぐ・後ろに続ける・パイプは不可)。
 *   - install の step の直後の step の run が、その root の `node scripts/installed-scripts-gate.mjs --rebuild <root>`
 *     だけで continue-on-error なし。同じ job の install より前の step に `node scripts/lockfile-gate.mjs` だけの step が
 *     あり、そこまでの step に continue-on-error が無い。install と実体 gate の step に working-directory / shell を
 *     付けない (どの root に何を走らせるかを行の文字列だけで決める)。
 * @param {string} source workflow の YAML
 * @param {string} [name] 違反メッセージに付けるファイル名
 * @returns {string[]}
 */
export function installGuardViolations(source, name = 'workflow') {
  const violations = [];
  const continueOnError = (step) => step.keys['continue-on-error'] ?? 'false';
  for (const { job, steps } of parseWorkflowJobs(source)) {
    const at = (index) => `${name}/${job} step ${index + 1}`;
    const runOf = (step) => step?.run?.trim() ?? null;
    steps.forEach((step, index) => {
      if (step.run === null) return;
      const lines = runLines(step.run);
      lines.forEach((line, k) => {
        if (!SENSITIVE.test(line)) return;
        if (INSTALL_LINES.has(line) || GATE_LINES.has(line) || OTHER_LINES.has(line)) return;
        if (PIPEFAIL_LINES.has(line) && lines.slice(0, k).includes('set -o pipefail')) return;
        violations.push(
          `${at(index)}: "${line}" mentions npm / npx / a gate but is not an allowed line ` +
            '(exact match only; do not write these names in comments, echo or quotes inside run)',
        );
      });
      for (const line of lines) {
        if ((INSTALL_LINES.has(line) || GATE_LINES.has(line)) && runOf(step) !== line) {
          violations.push(`${at(index)}: "${line}" must be the whole run of its step`);
        }
      }
    });
    steps.forEach((step, index) => {
      const run = runOf(step);
      if (!INSTALL_LINES.has(run)) return;
      const sourceGate = steps.findIndex((s) => runOf(s) === SOURCE_GATE_LINE);
      if (sourceGate === -1 || sourceGate > index) {
        violations.push(`${at(index)}: a step that runs only ${SOURCE_GATE_LINE} must come before the install`);
      } else if (steps.slice(0, sourceGate + 1).some((s) => continueOnError(s) !== 'false')) {
        violations.push(`${name}/${job}: no continue-on-error up to and including the source gate`);
      }
      const gateLine = installedGateLine(INSTALL_LINES.get(run));
      const next = steps[index + 1];
      if (runOf(next) !== gateLine) {
        violations.push(`${at(index)}: the next step must run only ${gateLine}`);
      } else if (continueOnError(next) !== 'false') {
        violations.push(`${at(index + 1)}: the installed-scripts gate must not continue on error`);
      }
      for (const [offset, s] of [[0, step], [1, next]]) {
        if (s !== undefined && (Object.hasOwn(s.keys, 'working-directory') || Object.hasOwn(s.keys, 'shell'))) {
          violations.push(`${at(index + offset)}: the install and the installed-scripts gate steps must not set working-directory or shell`);
        }
      }
    });
  }
  return violations;
}
