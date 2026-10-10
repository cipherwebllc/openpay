// GitHub Actions workflow (.github/workflows/*.yml) の step から `run:` のシェルを取り出し、npm / npx の呼び出しを
// 1 つずつ検査するための純関数群 (tests/scripts/workflow-guards.test.ts が使う)。第三者の YAML パーサを足さない
// (CLAUDE.md 掟 16) 代わりに、このリポの workflow が使う形だけを読み、**読めない形・読み残しうる形は throw する
// (fail-closed)**。
//
// 脅威モデル (docs/DEPLOY_CHECKLIST.md §7.14): 守る相手は、保守者 (AI エージェントを含む) が**うっかり** workflow に
// `npm install` や `npx …` を足すこと。意図的に検査を欺く書き方 (変数に入れたコマンドを後で展開する等) はレビューの
// 範囲。ただし npm / npx という語を含むのに読めない形 (ラッパー・サブシェル・展開・引用・コメント内) と、run を
// 読み残しうる YAML の書式は必ず throw し、うっかりの別書式を黙って通さない。
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
//
// シェル (splitCommands): `\` + 改行 (行継続) を bash と同じく先に取り除き、`&&` `||` `;` `|` `|&` `&` と改行で分け、
// 先頭の `time` と `VAR=value` を落として最初の語 (npm / npx / node …) で判定できる形にする。シェル構文の完全な解析は
// しない代わりに、npm / npx を含む行で読めないもの (上記) を throw する。

const NPM_WORD = /\b(?:npm|npx)\b/;
const KEY_LINE = /^(\w[\w-]*):(?:[ \t]+(.*))?$/;
const BLANK_OR_COMMENT = /^\s*(?:#.*)?$/;
// 区切り: && / || / |& / ; / | / & (ただし 2>&1 や &> のリダイレクトの & は区切りにしない)
const SEPARATOR = /\s*(?:&&|\|\||\|&|;|\||(?<![<>])&(?!>))\s*/;

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
  let commands = [];
  if (run !== null) {
    try {
      commands = splitCommands(run);
    } catch (error) {
      throw lineError(item, error.message);
    }
  }
  return { raw: state.lines.slice(item.at, state.i).join('\n'), keys, run, commands };
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
 * @returns {Array<{ job: string, steps: Array<{ raw: string, keys: Record<string, string>, run: string | null, commands: string[] }> }>}
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

/** シェル (複数行可) を個々のコマンドに分ける。先頭の time / 環境変数指定は落とす。npm / npx を読めない形は throw。 */
export function splitCommands(shell) {
  // 行継続は bash と同じく `\` + 改行をそのまま取り除く (`np\` + 改行 + `m install` = `npm install`)。
  const joined = shell.replace(/\\\n/g, '');
  const out = [];
  for (const line of joined.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) {
      // シェルのコメント。npm / npx を含むもの (行継続でコメントに連結された行・複数行の文字列の中身かもしれない) は読めない。
      if (NPM_WORD.test(trimmed)) throw new Error(`npm / npx in a shell comment is not read: ${trimmed}`);
      continue;
    }
    for (const part of trimmed.split(SEPARATOR)) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      while (words.length > 0 && (words[0] === 'time' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
      const command = words.join(' ');
      if (words[0] === 'npm' || words[0] === 'npx') {
        // 引数の展開・サブシェル・引用・escape、同じコマンド内の別の npm / npx は、実際に渡る引数を読めない。
        if (/[`$(){}'"\\]/.test(command) || NPM_WORD.test(words.slice(1).join(' '))) {
          throw new Error(`an npm / npx command with expansions, subshells, quotes or another npm / npx is not read: ${part.trim()}`);
        }
      } else if (NPM_WORD.test(part)) {
        // env npm … / bash -c 'npm …' / "$(npm …)" / xargs npm … / (npm …) / /usr/bin/npm … / n=npm 等。
        throw new Error(`npm / npx not at the head of the command (wrapper / subshell / expansion / quote / path / assignment) is not read: ${part.trim()}`);
      }
      if (words.length > 0) out.push(command);
    }
  }
  return out;
}

/**
 * npm / npx の呼び出し 1 つを分類する (npm / npx で始まらなければ null)。
 * `--prefix <dir>` / `--prefix=<dir>` / `-C <dir>` は prefix として取り出す (2 回以上・空は throw)。
 * @returns {{ tool: 'npm' | 'npx', subcommand: string | null, args: string[], prefix: string | null } | null}
 */
export function classifyNpmCommand(command) {
  const words = command.split(/\s+/);
  const tool = words[0];
  if (tool !== 'npm' && tool !== 'npx') return null;
  let prefix = null;
  const rest = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    let value;
    if (word === '--prefix' || word === '-C') {
      value = words[i + 1] ?? '';
      i++;
    } else if (word.startsWith('--prefix=')) {
      value = word.slice('--prefix='.length);
    } else {
      rest.push(word);
      continue;
    }
    if (prefix !== null || value === '') throw new Error(`npm --prefix must be given once with a directory: ${command}`);
    prefix = value;
  }
  if (tool === 'npx') return { tool, subcommand: null, args: rest, prefix };
  const subcommand = rest.find((w) => !w.startsWith('-')) ?? null;
  return { tool, subcommand, args: rest, prefix };
}

const LOCKFILE_GATE = 'node scripts/lockfile-gate.mjs';
const INSTALLED_SCRIPTS_GATE = 'node scripts/installed-scripts-gate.mjs';
// gate 以外の経路で install script を走らせる / 依存を取りに行く npm のサブコマンド。
const FORBIDDEN_NPM_SUBCOMMANDS = ['install', 'i', 'add', 'rebuild', 'exec', 'x', 'update', 'up'];
// それ以外で workflow から呼んでよいもの (未知のサブコマンドは足す前にレビューする)。
const ALLOWED_NPM_SUBCOMMANDS = ['run', 'run-script', 'test', 'audit', 'view', 'pack', 'publish'];

/**
 * workflow 1 本の依存 install の手順と npm / npx の呼び出しを検査し、違反を返す (空配列なら OK・読めない形は throw)。
 * 規則 (CLAUDE.md 掟 16・docs/DEPLOY_CHECKLIST.md §7.14):
 *   - npm ci のある job は、最初の npm ci より前に `node scripts/lockfile-gate.mjs` を走らせ、そこまでの step に
 *     continue-on-error を付けない。
 *   - npx は全面禁止 (`npx --no` でも global の bin や npx の cache を実行しうる)。bin は `npm run <script>` か
 *     `./node_modules/.bin/<bin>` で呼ぶ。`--no-ignore-scripts` / `--ignore-scripts=…` は書かない。
 *   - npm ci は `--ignore-scripts` 付きで、直後のコマンド (同じ step か次の step) が
 *     `node scripts/installed-scripts-gate.mjs --rebuild <root>/node_modules` で continue-on-error なし。
 *   - その他の npm は ALLOWED_NPM_SUBCOMMANDS だけ (install / rebuild / exec 等は禁止)。
 * @param {string} source workflow の YAML
 * @param {string} [name] 違反メッセージに付けるファイル名
 * @returns {string[]}
 */
export function installGuardViolations(source, name = 'workflow') {
  const violations = [];
  const continueOnError = (step) => step.keys['continue-on-error'] ?? 'false';
  for (const { job, steps } of parseWorkflowJobs(source)) {
    const commands = steps.flatMap((step, stepIndex) => step.commands.map((command) => ({ command, step, stepIndex })));
    const install = commands.findIndex(({ command }) => {
      const npm = classifyNpmCommand(command);
      return npm?.tool === 'npm' && npm.subcommand === 'ci';
    });
    if (install !== -1) {
      const gate = commands.findIndex(({ command }) => command === LOCKFILE_GATE);
      if (gate === -1 || gate > install) {
        violations.push(`${name}/${job}: ${LOCKFILE_GATE} must run before the first npm ci (pre-install source gate)`);
      } else if (commands.slice(0, gate + 1).some(({ step }) => continueOnError(step) !== 'false')) {
        violations.push(`${name}/${job}: no continue-on-error up to and including the source gate`);
      }
    }
    commands.forEach(({ command, step, stepIndex }, index) => {
      const npm = classifyNpmCommand(command);
      if (npm === null) return;
      const where = `${name}/${job}: "${command}"`;
      if (npm.tool === 'npx') {
        violations.push(`${where}: npx is not allowed; call ./node_modules/.bin/<bin> or npm run <script>`);
        return;
      }
      // `--no-ignore-scripts` / `--ignore-scripts=false` は後ろに書くと --ignore-scripts を打ち消す。
      if (/--no-ignore-scripts|--ignore-scripts=/.test(npm.args.join(' '))) {
        violations.push(`${where}: --no-ignore-scripts / --ignore-scripts=<value> undo --ignore-scripts`);
      }
      if (npm.subcommand === 'ci') {
        if (!npm.args.includes('--ignore-scripts')) violations.push(`${where}: npm ci must not run install scripts (--ignore-scripts)`);
        const root = npm.prefix ? `${npm.prefix}/node_modules` : 'node_modules';
        const next = commands[index + 1];
        if (next?.command !== `${INSTALLED_SCRIPTS_GATE} --rebuild ${root}`) {
          violations.push(`${where}: the next command must be ${INSTALLED_SCRIPTS_GATE} --rebuild ${root}`);
        } else {
          if (continueOnError(next.step) !== 'false') violations.push(`${where}: the installed-scripts gate must not continue on error`);
          if (next.stepIndex - stepIndex > 1) violations.push(`${where}: the installed-scripts gate must be in the same step or the next one`);
        }
        return;
      }
      if (FORBIDDEN_NPM_SUBCOMMANDS.includes(npm.subcommand)) {
        violations.push(`${where}: forbidden npm subcommand ${npm.subcommand} (installs or runs scripts outside the gate)`);
      } else if (!ALLOWED_NPM_SUBCOMMANDS.includes(npm.subcommand)) {
        violations.push(`${where}: unknown npm subcommand ${npm.subcommand ?? '(none)'}`);
      }
    });
  }
  return violations;
}
