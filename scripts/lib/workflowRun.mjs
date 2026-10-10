// GitHub Actions workflow (.github/workflows/*.yml) の step から `run:` のシェルを取り出し、npm / npx の呼び出しを
// 1 つずつ検査するための純関数群 (tests/scripts/workflow-guards.test.ts が使う)。第三者の YAML パーサを足さない
// (CLAUDE.md 掟 16) 代わりに、このリポの workflow が使う形だけを読み、**読めない形は throw する (fail-closed)**。
//
// 読める形:
//   run: npm ci --ignore-scripts               (plain scalar・行末の " # comment" は落とす)
//   run: 'npm ci' / run: "npm ci"              (1 行の引用符付き)
//   run: |  / |- / |+ / > / >- / >+            (block scalar・key より深いインデントの行を本文とする)
// 読めない形 (throw): アンカー / エイリアス (& *)・タグ (!)・flow (`[` `{`)・複数行の引用符・block scalar の
//   インデント指示子 (|2 等)・step の外や不明な位置の run。
//
// コマンドは `&&` `||` `;` `|` と改行で分け、先頭の `time` と `VAR=value` の環境変数指定を落として、
// 最初の語 (npm / npx / node …) で判定できる形にする。

const STEP_RE = /^(\s*)- /;

/**
 * 1 つの workflow ファイルを job ごとの step 配列に分ける。
 * @param {string} source
 * @returns {Array<{ job: string, steps: Array<{ raw: string, keys: Record<string, string>, run: string | null, commands: string[] }> }>}
 */
export function parseWorkflowJobs(source) {
  const lines = source.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) throw new Error('workflow has no top-level jobs:');
  const jobs = [];
  let job = null;
  let stepsIndent = null;
  let step = null;
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && !/^\s*#/.test(line) && line.trim() !== '') {
      // 別の top-level key (jobs: の後ろに来る env 等) で終わり
      break;
    }
    const jobHead = /^  ([\w-]+):\s*$/.exec(line);
    if (jobHead) {
      job = { job: jobHead[1], steps: [] };
      jobs.push(job);
      stepsIndent = null;
      step = null;
      continue;
    }
    if (job === null) continue;
    if (/^\s+steps:\s*$/.test(line)) {
      stepsIndent = line.search(/\S/);
      continue;
    }
    if (stepsIndent === null) continue;
    const stepHead = STEP_RE.exec(line);
    if (stepHead && stepHead[1].length === stepsIndent + 2 && !/^\s*#/.test(line)) {
      step = { lines: [line.slice(stepHead[0].length)], indent: stepHead[0].length };
      job.steps.push(step);
      continue;
    }
    if (step !== null) {
      if (line.trim() === '') {
        step.lines.push('');
        continue;
      }
      const indent = line.search(/\S/);
      if (/^\s*#/.test(line)) {
        // step より浅いコメントは block scalar を終える (YAML)。深いものは本文の可能性があるので相対インデントを保つ。
        step.lines.push(indent < step.indent ? line.trim() : line.slice(step.indent));
        continue;
      }
      if (indent < step.indent) {
        step = null; // steps の終わり (次の job key 等)
        continue;
      }
      step.lines.push(line.slice(step.indent));
    }
  }
  for (const j of jobs) {
    j.steps = j.steps.map((s) => parseStep(s.lines));
  }
  return jobs;
}

/** step の行 (先頭の "- " を除いた相対インデント) から key と run を読む。 */
function parseStep(lines) {
  const keys = {};
  let run = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([\w-]+):(.*)$/.exec(line);
    if (!kv) continue; // 入れ子 (env の中身・with の中身) か空行
    const key = kv[1];
    let value = kv[2];
    if (key !== 'run') {
      keys[key] = value.trim();
      continue;
    }
    if (run !== null) throw new Error('step has two run keys');
    value = value.replace(/^\s+/, '');
    const head = value.trim();
    if (/^[&*!\[{]/.test(head)) throw new Error(`unsupported YAML in run (anchor/alias/tag/flow): ${head}`);
    const block = /^([|>])([+-]?)\s*(#.*)?$/.exec(head);
    if (block) {
      const body = [];
      let bodyIndent = null;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') {
          body.push('');
          continue;
        }
        const indent = l.search(/\S/);
        if (bodyIndent === null) {
          if (indent === 0) break;
          bodyIndent = indent;
        }
        if (indent < bodyIndent) break;
        body.push(l.slice(bodyIndent));
      }
      if (bodyIndent === null) throw new Error('empty block scalar in run');
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      run = block[1] === '>' ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n');
      i = j - 1;
      continue;
    }
    if (/^[|>]\d/.test(head)) throw new Error(`unsupported block scalar indentation indicator in run: ${head}`);
    if (head.startsWith("'")) {
      const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(head);
      if (!m) throw new Error(`unsupported multi-line or unterminated single-quoted run: ${head}`);
      run = m[1].replace(/''/g, "'");
      continue;
    }
    if (head.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(head);
      if (!m) throw new Error(`unsupported multi-line or unterminated double-quoted run: ${head}`);
      run = m[1].replace(/\\(.)/g, '$1');
      continue;
    }
    if (head === '') throw new Error('empty run');
    run = head.replace(/\s+#.*$/, '');
  }
  return { raw: lines.join('\n'), keys, run, commands: run === null ? [] : splitCommands(run) };
}

/** シェルの 1 行 (複数行可) を個々のコマンドに分ける。先頭の time / 環境変数指定は落とす。 */
export function splitCommands(shell) {
  const out = [];
  for (const line of shell.split('\n')) {
    const stripped = line.replace(/^\s*#.*$/, '').trim();
    if (stripped === '') continue;
    for (const part of stripped.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      while (words.length > 0 && (words[0] === 'time' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
      if (words.length > 0) out.push(words.join(' '));
    }
  }
  return out;
}

/**
 * npm / npx の呼び出し 1 つを分類する。
 * @returns {{ tool: 'npm' | 'npx', subcommand: string | null, args: string[], prefix: string | null }}
 */
export function classifyNpmCommand(command) {
  const words = command.split(/\s+/);
  const tool = words[0];
  if (tool !== 'npm' && tool !== 'npx') return null;
  let prefix = null;
  const rest = [];
  for (let i = 1; i < words.length; i++) {
    if (words[i] === '--prefix' && i + 1 < words.length) {
      prefix = words[i + 1];
      i++;
      continue;
    }
    rest.push(words[i]);
  }
  if (tool === 'npx') return { tool, subcommand: null, args: rest, prefix };
  const subcommand = rest.find((w) => !w.startsWith('-')) ?? null;
  return { tool, subcommand, args: rest, prefix };
}
