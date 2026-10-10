// GitHub Actions workflow (.github/workflows/*.yml) の step から `run:` を取り出し、依存の install の手順と npm / npx の
// 呼び出しを検査するための純関数群 (tests/scripts/workflow-guards.test.ts が使う)。YAML は `yaml` (eemeli/yaml) で読み
// (scripts/lib/workflowYaml.mjs)、**読めない形・想定外の型は throw する (fail-closed)**。
//
// 脅威モデル (docs/DEPLOY_CHECKLIST.md §7.14): 守る相手は、保守者 (AI エージェントを含む) が**うっかり** workflow に
// `npm install` や `npx …` を足すこと。意図的に検査を欺く書き方 (変数に入れたコマンドを後で展開する等) はレビューの
// 範囲。シェルを分解して意味を推測することはせず (引用・コメント・here-doc・演算子の解釈の取り違えが往復の原因だった)、
// npm / npx / 2 つの gate の名前を含む行は「完全一致の許可リスト」だけを通す (installGuardViolations)。許可した行の
// 実行のされ方を変える設定 (env の npm_config_*・gate だけを飛ばす if・defaults・shell) も安い規則で止める。
//
// 読む値の形 (引用符・block scalar・flow・インデントの違いは YAML として読むので問わない):
//   - jobs: 空でない mapping。各 job は mapping で、steps は空でない配列 (step の無い job = `uses:` の job は読めない)。
//     各 step は mapping。run は空白だけでない文字列 (block scalar の末尾の改行は runLines が落とす)。
//   - env (workflow / job / step): 無い・null・mapping (key を読む)。式などの mapping でない値は throw。
//   - defaults (workflow / job) は有無だけを見る。
//   throw する形: workflowYaml の problems (パースエラー・警告・複数ドキュメント・アンカー / エイリアス / タグ・重複キー・
//   文字列でない key・`<<`・制御文字・ディレクティブ) と、上の型に合わない値。

import { isMapping, readWorkflowYaml } from './workflowYaml.mjs';

/** env の値から key の一覧を読む (無い・null は空)。mapping でなければ throw (env で npm の設定を変えていないかを読めない形を通さない)。 */
function envKeysOf(value, where) {
  if (value === undefined || value === null) return [];
  if (!isMapping(value)) throw new Error(`${where}: env must be a mapping (an expression or other value is not read): ${JSON.stringify(value)}`);
  return Object.keys(value);
}

/** 1 step を読む。keys は step の mapping そのもの (run・env を含む)。 */
function parseStep(step, where) {
  if (!isMapping(step)) throw new Error(`${where}: a step must be a mapping: ${JSON.stringify(step)}`);
  let run = null;
  if (Object.hasOwn(step, 'run')) {
    if (typeof step.run !== 'string' || step.run.trim() === '') throw new Error(`${where}: run must be a non-empty string: ${JSON.stringify(step.run)}`);
    run = step.run;
  }
  return { keys: step, envKeys: envKeysOf(step.env, where), run };
}

/** 1 job を読み、steps と env の key・defaults の有無を返す。 */
function parseJob(name, job) {
  if (!isMapping(job)) throw new Error(`job ${name} must be a mapping: ${JSON.stringify(job)}`);
  const { steps } = job;
  // step の無い job (`uses:` で別 workflow を呼ぶ job を含む) は、中で何が走るかをここで読めない。
  if (!Array.isArray(steps) || steps.length === 0) throw new Error(`job ${name} has no steps to read (a job without steps, e.g. uses:, is not read)`);
  return {
    job: name,
    steps: steps.map((step, index) => parseStep(step, `job ${name} step ${index + 1}`)),
    envKeys: envKeysOf(job.env, `job ${name}`),
    hasDefaults: Object.hasOwn(job, 'defaults'),
  };
}

/**
 * workflow 1 本を読む: top-level の env の key・defaults の有無と、job ごとの steps (と job の env の key・defaults)。
 * @param {string} source
 * @returns {{ envKeys: string[], hasDefaults: boolean, jobs: Array<{ job: string, envKeys: string[], hasDefaults: boolean,
 *   steps: Array<{ keys: Record<string, unknown>, envKeys: string[], run: string | null }> }> }}
 */
export function parseWorkflow(source) {
  const read = readWorkflowYaml(source);
  if ('problems' in read) throw new Error(`the workflow is not read: ${read.problems.join('; ')}`);
  const { data } = read;
  if (!isMapping(data.jobs) || Object.keys(data.jobs).length === 0) throw new Error('workflow has no top-level jobs: (a non-empty mapping) to read');
  return {
    envKeys: envKeysOf(data.env, 'workflow'),
    hasDefaults: Object.hasOwn(data, 'defaults'),
    jobs: Object.entries(data.jobs).map(([name, job]) => parseJob(name, job)),
  };
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
 *     だけで continue-on-error なし (無いか false)。同じ job の install より前の step に `node scripts/lockfile-gate.mjs` だけの step が
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
  // continue-on-error は無いか false (YAML の真偽値) だけを「なし」とみなす (true・式・文字列は続行しうる)。
  const continuesOnError = (step) => Object.hasOwn(step.keys, 'continue-on-error') && step.keys['continue-on-error'] !== false;
  const singleLineString = (value) => typeof value === 'string' && !/[\r\n]/.test(value);
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
      } else if (steps.slice(0, sourceGate + 1).some(continuesOnError)) {
        violations.push(`${name}/${job}: no continue-on-error up to and including the source gate`);
      }
      const gateLine = installedGateLine(INSTALL_LINES.get(run));
      const next = steps[index + 1];
      if (runOf(next) !== gateLine) {
        violations.push(`${at(index)}: the next step must run only ${gateLine}`);
      } else if (continuesOnError(next)) {
        violations.push(`${at(index + 1)}: the installed-scripts gate must not continue on error`);
      }
      for (const [offset, s] of [[0, step], [1, next]]) {
        if (s !== undefined && (Object.hasOwn(s.keys, 'working-directory') || Object.hasOwn(s.keys, 'shell'))) {
          violations.push(`${at(index + offset)}: the install and the installed-scripts gate steps must not set working-directory or shell`);
        }
      }
      // Codex レビュー 8 回目 (PR #778): gate だけが飛ばされる `if:` (Pimlico の実体 gate だけ条件を変える・source gate に
      // だけ push 条件を付ける) を通さない。if は無いか、install の step と同じ 1 行の文字列だけ。
      if (Object.hasOwn(step.keys, 'if') && !singleLineString(step.keys.if)) {
        violations.push(`${at(index)}: the if of the install step must be a single-line string`);
      }
      const installIf = step.keys.if;
      for (const gateIndex of [sourceGate, index + 1]) {
        const gate = steps[gateIndex];
        if (gateIndex === -1 || gate === undefined || !Object.hasOwn(gate.keys, 'if')) continue;
        if (!singleLineString(gate.keys.if) || gate.keys.if !== installIf) {
          violations.push(`${at(gateIndex)}: the if of a gate step must be absent or the same as the install step's (${installIf ?? 'none'})`);
        }
      }
    });
  }
  return violations;
}
