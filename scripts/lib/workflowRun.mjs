// GitHub Actions workflow (.github/workflows/*.yml) の step から `run:` を取り出し、依存の install の手順と npm / npx の
// 呼び出しを検査するための純関数群 (tests/scripts/workflow-guards.test.ts が使う)。第三者の YAML パーサを足さない
// (CLAUDE.md 掟 16) 代わりに、このリポの workflow が使う形だけを読み、**読めない形・読み残しうる形は throw する
// (fail-closed)**。
//
// 脅威モデル (docs/DEPLOY_CHECKLIST.md §7.14): 守る相手は、保守者 (AI エージェントを含む) が**うっかり** workflow に
// `npm install` や `npx …` を足すこと。意図的に検査を欺く書き方 (変数に入れたコマンドを後で展開する等) はレビューの
// 範囲。シェルを分解して意味を推測することはせず (引用・コメント・here-doc・演算子の解釈の取り違えが往復の原因だった)、
// npm / npx / 2 つの gate の名前を含む行は「完全一致の許可リスト」だけを通す (installGuardViolations)。許可した行の
// 実行のされ方を変える設定 (env の npm_config_*・gate だけを飛ばす if・defaults・shell) も安い規則で止める。
//
// 読む YAML の形 (top-level の key は全て引用符なしの `key:`。中身を読むのは env・defaults の有無・jobs):
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

/**
 * `env:` の値 (ブロックマッピング) の key の一覧を読む。各値は step の key の値と同じ規則で読む (継続行は throw)。
 * インラインの値 (flow・式)・引用符付きの key・揃っていないインデントは throw (env で npm の設定を変えていないかを
 * 読めない形を通さない)。
 */
function readMappingKeys(state, line, keyIndent, value) {
  if (value !== '') throw lineError(line, `env must be a block mapping (flow / expression values are not read): ${value}`);
  const keys = [];
  const first = peek(state);
  if (first === null || first.indent <= keyIndent) return keys;
  const childIndent = first.indent;
  for (let next = peek(state); next !== null && next.indent > keyIndent; next = peek(state)) {
    if (next.indent !== childIndent) throw lineError(next, `env keys must be at indent ${childIndent}`);
    const { key, value: entryValue } = mappingEntry(next);
    keys.push(key);
    state.i = next.at + 1;
    // 値は step の key と同じ規則で読む (継続行・アンカー等は throw = 深い行に key を隠させない)。
    readValue(state, next, childIndent, entryValue);
  }
  return keys;
}

/** `- key: …` から始まる 1 step を読む。 */
function parseStep(state, item, seqIndent) {
  const m = /^-( +)(\S.*)$/.exec(item.text);
  if (!m) throw lineError(item, 'a step must have its first key on the "- " line');
  const keyIndent = seqIndent + 1 + m[1].length;
  const keys = {};
  // 各 key の値の形 ('scalar' = 1 行の scalar・'nested' = 次の行からの値・'block' = block scalar・'mapping' = env)。
  const kinds = {};
  let envKeys = [];
  let run = null;
  let line = { at: item.at, indent: keyIndent, text: m[2] };
  state.i = item.at + 1;
  for (;;) {
    const { key, value } = mappingEntry(line);
    if (Object.hasOwn(keys, key) || (key === 'run' && run !== null)) throw lineError(line, `step has two ${key} keys`);
    if (key === 'env') {
      envKeys = readMappingKeys(state, line, keyIndent, value);
      keys.env = value;
      kinds.env = 'mapping';
    } else {
      const read = readValue(state, line, keyIndent, value);
      if (key === 'run') {
        if (read.text.trim() === '') throw lineError(line, 'an empty run (or a run value on the following lines) is not read');
        run = read.text;
      } else {
        keys[key] = read.kind === 'scalar' ? read.text : value;
        kinds[key] = read.kind;
      }
    }
    const next = peek(state);
    if (next === null || next.indent <= seqIndent) break;
    if (next.indent !== keyIndent) throw lineError(next, `step keys must be at indent ${keyIndent}`);
    line = next;
    state.i = next.at + 1;
  }
  return { keys, kinds, envKeys, run };
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

/** 1 job の本文 (job の key より深い行) を読み、steps と env の key・defaults の有無を返す。 */
function parseJob(state, jobIndent, name) {
  const first = peek(state);
  if (first === null || first.indent <= jobIndent) throw new Error(`job ${name} has no body`);
  const keyIndent = first.indent;
  let steps = null;
  let envKeys = null;
  let hasDefaults = false;
  for (let next = peek(state); next !== null && next.indent > jobIndent; next = peek(state)) {
    if (next.indent !== keyIndent) throw lineError(next, `keys of job ${name} must be at indent ${keyIndent}`);
    const { key, value } = mappingEntry(next);
    state.i = next.at + 1;
    if (key === 'env') {
      if (envKeys !== null) throw lineError(next, `job ${name} has two env keys`);
      envKeys = readMappingKeys(state, next, keyIndent, value);
      continue;
    }
    if (key !== 'steps') {
      if (key === 'defaults') hasDefaults = true;
      skipNested(state, keyIndent);
      continue;
    }
    if (steps !== null) throw lineError(next, `job ${name} has two steps keys`);
    if (value !== '') throw lineError(next, `steps of job ${name} must be a block sequence: ${value}`);
    steps = parseSteps(state, keyIndent);
  }
  // step の無い job (`uses:` で別 workflow を呼ぶ job を含む) は、中で何が走るかをここで読めない。
  if (steps === null || steps.length === 0) throw new Error(`job ${name} has no steps to read (a job without steps, e.g. uses:, is not read)`);
  return { job: name, steps, envKeys: envKeys ?? [], hasDefaults };
}

/** `jobs:` の値 (job のブロックマッピング) を読む。インデント 0 の行 (次の top-level key) で終わる。 */
function parseJobs(state, line, value) {
  if (value !== '') throw lineError(line, `jobs must be a block mapping: ${value}`);
  const first = peek(state);
  if (first === null || first.indent === 0) throw new Error('jobs: has no jobs');
  const jobIndent = first.indent;
  const jobs = [];
  for (let next = peek(state); next !== null && next.indent > 0; next = peek(state)) {
    if (next.indent !== jobIndent) throw lineError(next, `jobs must be at indent ${jobIndent}`);
    const { key, value: jobValue } = mappingEntry(next);
    if (jobValue !== '') throw lineError(next, `job ${key} must be a block mapping: ${jobValue}`);
    state.i = next.at + 1;
    jobs.push(parseJob(state, jobIndent, key));
  }
  return jobs;
}

/**
 * workflow 1 本を読む: top-level の env の key・defaults の有無と、job ごとの steps (と job の env の key・defaults)。
 * top-level の行は全て引用符なしの `key:` でなければ throw (引用符付きの `"env":` 等を読み飛ばさない)。
 * @param {string} source
 * @returns {{ envKeys: string[], hasDefaults: boolean, jobs: Array<{ job: string, envKeys: string[], hasDefaults: boolean,
 *   steps: Array<{ keys: Record<string, string>, kinds: Record<string, string>, envKeys: string[], run: string | null }> }> }}
 */
export function parseWorkflow(source) {
  if (source.includes('\r')) throw new Error('a workflow with CR line endings is not read');
  const state = { lines: source.split('\n'), i: 0 };
  const seen = new Set();
  let envKeys = [];
  let hasDefaults = false;
  let jobs = null;
  for (let next = peek(state); next !== null; next = peek(state)) {
    if (next.indent !== 0) throw lineError(next, 'unexpected indentation at the top level');
    const { key, value } = mappingEntry(next);
    if (seen.has(key)) throw lineError(next, `duplicate top-level key ${key}`);
    seen.add(key);
    state.i = next.at + 1;
    if (key === 'jobs') {
      jobs = parseJobs(state, next, value);
    } else if (key === 'env') {
      envKeys = readMappingKeys(state, next, 0, value);
    } else {
      if (key === 'defaults') hasDefaults = true;
      skipNested(state, 0);
    }
  }
  if (jobs === null) throw new Error('workflow has no top-level jobs: (block mapping) to read');
  return { envKeys, hasDefaults, jobs };
}

/** parseWorkflow の jobs だけ。 */
export function parseWorkflowJobs(source) {
  return parseWorkflow(source).jobs;
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
// 例外: パイプを含む build の行。step の run 全体が下の固定テンプレート (ci.yml の build の step) と完全一致するときだけ
// 許す (前に `set -o pipefail` があるだけでは、関数の中での set や途中の `set +o pipefail` で効かない形を通してしまう)。
const PIPEFAIL_LINES = new Set(['npm run build 2>&1 | tee build.log']);
/** パイプの build の行を許す run (runLines で比べる・コメント行も含めて行の並びと中身が一致すること)。 */
export const PIPEFAIL_BUILD_RUN = Object.freeze([
  '# build の失敗を tee の終了コードで隠さない (pipefail が無いと予算スクリプトのパース失敗頼みになる・第 7 回レビュー E12)',
  'set -o pipefail',
  '# build ログを保存して、後で bundle 予算チェックに食わせる',
  'npm run build 2>&1 | tee build.log',
  '# Route 別 First Load JS の予算超過を fail させる',
  'node scripts/check-bundle-budget.mjs < build.log',
  '# サーバーバンドル内の Lua (EVAL 用 CAS) が minifier に壊されていないか (2026-09-06 実害)',
  'node scripts/check-lua-bundle.mjs',
]);
// npm が設定として読む環境変数 (registry・ignore-scripts 等を env で差し替えさせない)。
const NPM_CONFIG_ENV = /^npm_config_/i;

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
 *   - install・source gate・実体 gate の step の `if:` は、無いか、install の step の `if:` と同じ 1 行の文字列だけ
 *     (gate だけが飛ばされる条件を書かない)。job の `if:` は job 全体なので見ない。
 *   - workflow / job / step の env に `npm_config_*` (大文字小文字を問わない) を置かない。workflow / job の `defaults:`
 *     (run.shell / run.working-directory) を使わない。npm / npx / gate の名前を含む行がある step に `shell:` を付けない
 *     (GitHub の既定の bash -e 以外では許可した行の失敗が step の成功に変わりうる)。
 *   - パイプを含む build の行は、step の run 全体が PIPEFAIL_BUILD_RUN と完全一致するときだけ。
 * @param {string} source workflow の YAML
 * @param {string} [name] 違反メッセージに付けるファイル名
 * @returns {string[]}
 */
export function installGuardViolations(source, name = 'workflow') {
  const violations = [];
  const continueOnError = (step) => step.keys['continue-on-error'] ?? 'false';
  const workflow = parseWorkflow(source);
  const npmConfig = (keys, where) => {
    for (const key of keys.filter((k) => NPM_CONFIG_ENV.test(k))) violations.push(`${where}: env ${key} changes npm's configuration (registry, ignore-scripts, …)`);
  };
  npmConfig(workflow.envKeys, name);
  if (workflow.hasDefaults) violations.push(`${name}: defaults (run.shell / run.working-directory) changes how the allowed lines run`);
  for (const { job, steps, envKeys, hasDefaults } of workflow.jobs) {
    const at = (index) => `${name}/${job} step ${index + 1}`;
    const runOf = (step) => step?.run?.trim() ?? null;
    npmConfig(envKeys, `${name}/${job}`);
    if (hasDefaults) violations.push(`${name}/${job}: defaults (run.shell / run.working-directory) changes how the allowed lines run`);
    steps.forEach((step, index) => {
      npmConfig(step.envKeys, at(index));
      if (step.run === null) return;
      const lines = runLines(step.run);
      const pipefailTemplate = lines.length === PIPEFAIL_BUILD_RUN.length && lines.every((line, k) => line === PIPEFAIL_BUILD_RUN[k]);
      lines.forEach((line) => {
        if (!SENSITIVE.test(line)) return;
        if (INSTALL_LINES.has(line) || GATE_LINES.has(line) || OTHER_LINES.has(line)) return;
        if (PIPEFAIL_LINES.has(line) && pipefailTemplate) return;
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
      if (lines.some((line) => SENSITIVE.test(line)) && Object.hasOwn(step.keys, 'shell')) {
        violations.push(`${at(index)}: a step that runs npm / a gate must not set shell (the default bash -e decides its failure)`);
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
      // Codex レビュー 8 回目 (PR #778): gate だけが飛ばされる `if:` (Pimlico の実体 gate だけ条件を変える・source gate に
      // だけ push 条件を付ける) を通さない。if は無いか、install の step と同じ 1 行の文字列だけ。
      if (Object.hasOwn(step.kinds, 'if') && step.kinds.if !== 'scalar') {
        violations.push(`${at(index)}: the if of the install step must be a single-line value`);
      }
      const installIf = step.keys.if;
      for (const gateIndex of [sourceGate, index + 1]) {
        const gate = steps[gateIndex];
        if (gateIndex === -1 || gate === undefined || !Object.hasOwn(gate.keys, 'if')) continue;
        if (gate.kinds.if !== 'scalar' || gate.keys.if !== installIf) {
          violations.push(`${at(gateIndex)}: the if of a gate step must be absent or the same as the install step's (${installIf ?? 'none'})`);
        }
      }
    });
  }
  return violations;
}
