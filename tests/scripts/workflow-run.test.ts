import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_RUN_LINES, installGuardViolations, parseWorkflowJobs, runLines } from '../../scripts/lib/workflowRun.mjs';

// Codex レビュー 4 回目 (PR #778) 2: workflow ガードが YAML の別書式 (`run: |`・`run: >-`・引用符付き) と
// 1 step 内の追加コマンド (`npm ci --ignore-scripts && npm rebuild`) を見逃していた。7 回目以降、run の中身はシェルと
// して分解せず、npm / npx / gate の名前を含む行を許可リストと完全一致で照合する (installGuardViolations)。
// YAML は `yaml` で読み (scripts/lib/workflowYaml.mjs)、パースエラー・アンカー / エイリアス / タグ・重複キー・想定外の型は
// throw する (fail-closed)。以前の手書きの読み取りが throw していた別書式のうち YAML として意味が明確なものは、値として
// 読んだうえで許可リストで判定する。

function workflow(stepsYaml: string) {
  return `name: x\non: push\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${stepsYaml}`;
}

describe('parseWorkflowJobs', () => {
  it('reads plain, quoted and block scalar runs as YAML values (keys are the step mapping)', () => {
    const jobs = parseWorkflowJobs(workflow([
      '      - uses: actions/checkout@v4',
      '      - run: npm ci --ignore-scripts # comment',
      "      - run: 'npm ci --ignore-scripts'",
      '      - run: "npm ci --ignore-scripts"',
      '      - name: block',
      '        run: |',
      '          npm ci --ignore-scripts',
      '          node scripts/installed-scripts-gate.mjs --rebuild node_modules',
      '      - name: folded',
      '        run: >-',
      '          npm ci',
      '          --ignore-scripts',
      '      - name: keep',
      '        run: |+',
      '          echo a && echo b',
      '',
      '      - name: chained',
      '        run: npm ci --ignore-scripts && npm rebuild',
      '        env:',
      '          FOO: bar',
      '        continue-on-error: true',
    ].join('\n')));
    expect(jobs).toHaveLength(1);
    const steps = jobs[0].steps;
    // block scalar の末尾の改行 (`|` は 1 つ・`|+` は空行も) は YAML のとおり残る (runLines が落とす)
    expect(steps.map((s) => s.run)).toEqual([
      null,
      'npm ci --ignore-scripts',
      'npm ci --ignore-scripts',
      'npm ci --ignore-scripts',
      'npm ci --ignore-scripts\nnode scripts/installed-scripts-gate.mjs --rebuild node_modules\n',
      'npm ci --ignore-scripts',
      'echo a && echo b\n\n',
      'npm ci --ignore-scripts && npm rebuild',
    ]);
    expect(steps[0].keys.uses).toBe('actions/checkout@v4');
    expect(steps[7].keys['continue-on-error']).toBe(true);
    expect(steps[7].keys.env).toEqual({ FOO: 'bar' });
    expect(steps[7].envKeys).toEqual(['FOO']);
  });

  it('ends a block scalar at a comment that is shallower than the step (ci.yml の run: >- の後の説明文)', () => {
    const jobs = parseWorkflowJobs(workflow([
      '      - name: folded',
      '        run: >-',
      '          ./node_modules/.bin/vitest run',
      '          tests/a.test.ts',
      '      # 説明のコメント (step より浅い) は本文ではない',
      '      # npm install と書いてあっても無視される',
      '      - run: node x.mjs',
    ].join('\n')));
    expect(jobs[0].steps.map((s) => s.run)).toEqual(['./node_modules/.bin/vitest run tests/a.test.ts', 'node x.mjs']);
  });

  it('separates jobs and stops at the next top-level key', () => {
    const source = 'jobs:\n  a:\n    steps:\n      - run: npm ci --ignore-scripts\n  b:\n    runs-on: x\n    steps:\n      - name: n\n        run: node x.mjs\nenv:\n  X: "- run: npm install"\n';
    const jobs = parseWorkflowJobs(source);
    expect(jobs.map((j) => j.job)).toEqual(['a', 'b']);
    expect(jobs[1].steps[0].run).toBe('node x.mjs');
  });

  // YAML として読めない・検査に使わない形 (workflowYaml の problems) と、想定外の型は throw する。
  it.each([
    ['alias', '      - run: *install'],
    ['anchor', '      - run: &install npm ci'],
    ['tag', '      - run: !!str npm ci'],
    ['a merge key', '      - <<: *defaults\n        run: echo'],
    ['a merge key with an inline mapping', '      - <<: {run: npm install}\n        name: x'],
    ['a flow sequence run (not a string)', '      - run: [npm, ci]'],
    ['a flow mapping run (not a string)', '      - run: {a: b}'],
    ['a number run (not a string)', '      - run: 1'],
    ['an empty block scalar', '      - run: |\n      - run: echo'],
    ['an empty run', '      - run:'],
    ['a blank quoted run', '      - run: "  "'],
    ['two run keys', '      - run: a\n        run: b'],
    ['a quoted and a plain run key', '      - run: a\n        "run": b'],
    ['an unterminated single quote', "      - run: 'npm ci"],
    ['an unterminated double quote', '      - run: "npm ci'],
    ['a continuation line under another key', '      - name: x\n          run: npm install'],
    ['a comment between a plain scalar and its continuation', '      - run: echo ok &&\n          # note\n          npm install'],
    ['a key deeper than the step keys', '      - name: x\n         run: npm install'],
    ['a key between the dash and the step keys', '      - name: x\n       run: npm install'],
    ['a tab in the indentation', '      - name: x\n\trun: npm install'],
    ['a key without a space after the colon (a plain scalar step in YAML)', '      - run:npm install'],
    ['an empty step', '      -'],
    ['a non-string key', '      - run: echo\n        1: npm install'],
  ])('fails closed on %s', (_label, step) => {
    expect(() => parseWorkflowJobs(workflow(step))).toThrow();
  });

  it('fails closed when there is no jobs key', () => {
    expect(() => parseWorkflowJobs('name: x\n')).toThrow();
  });

  // 以前の手書きの読み取りが throw していた形のうち、YAML として意味が明確なもの (引用符付きの key・継続行・escape・
  // 次の行から始まる値・flow 形式・block scalar の字下げ指示子・folded の改行) は値として読み、npm の行を許可リストで判定する
  // (読めない形として止めるのではなく、読んだうえで違反にする)。
  it.each([
    ['a double-quoted step key', '      - "run": npm install', 'npm install'],
    ['a single-quoted step key', "      - 'run': npm install", 'npm install'],
    ['a quoted key after the first one', '      - name: x\n        "run": npm install', 'npm install'],
    ['a plain scalar continued on the next line', '      - run: echo ok &&\n          npm install', 'echo ok && npm install'],
    ['a multi-line single-quoted run', "      - run: 'echo ok &&\n          npm install'", 'echo ok && npm install'],
    ['a multi-line double-quoted run', '      - run: "echo ok &&\n          npm install"', 'echo ok && npm install'],
    ['an escaped newline in a double-quoted run', '      - run: "echo ok\\nnpm install"', 'echo ok\nnpm install'],
    ['a complex key', '      - ? run\n        : npm install', 'npm install'],
    ['a flow mapping step', '      - {run: npm install}', 'npm install'],
    ['a step whose keys start on the next line', '      -\n        run: npm install', 'npm install'],
    ['a run value on the next line', '      - run:\n          npm install', 'npm install'],
    ['a folded run with a blank line (kept as a newline)', '      - run: >\n          echo a\n\n          npm install', 'echo a\nnpm install\n'],
    ['a folded run with a more-indented line (kept as a newline)', '      - run: >\n          echo a\n            npm install', 'echo a\n  npm install\n'],
    ['a block scalar header with an indentation indicator', '      - run: |2\n          npm install', 'npm install\n'],
    ['an indentation indicator after chomping', '      - run: |-2\n          npm install', 'npm install'],
  ])('reads %s and reports the npm line', (_label, step, run) => {
    expect(parseWorkflowJobs(workflow(step))[0].steps.map((s) => s.run)).toEqual([run]);
    expect(installGuardViolations(workflow(step), 'x.yml').join('\n')).toMatch(/npm install" mentions npm \/ npx \/ a gate but is not an allowed line/);
  });

  it('reads an escape in a double-quoted run as its character (a trailing tab is trimmed like any space)', () => {
    expect(parseWorkflowJobs(workflow('      - run: "npm ci --ignore-scripts\\t"'))[0].steps[0].run).toBe('npm ci --ignore-scripts\t');
  });

  it.each([
    ['steps given as an empty flow sequence', 'jobs:\n  a:\n    steps: []\n'],
    ['a job without steps (uses: a reusable workflow)', 'jobs:\n  a:\n    uses: ./.github/workflows/x.yml\n'],
    ['a job with an empty steps key', 'jobs:\n  a:\n    runs-on: x\n    steps:\n  b:\n    steps:\n      - run: echo\n'],
    ['steps followed by a mapping instead of a sequence', 'jobs:\n  a:\n    steps:\n      run: npm install\n'],
    ['jobs at different indentations', 'jobs:\n  a:\n    steps:\n      - run: echo\n   b:\n    steps:\n      - run: npm install\n'],
    ['a step line between the job keys and the items', 'jobs:\n  a:\n    steps:\n      - run: echo\n     - run: npm install\n'],
    ['job keys at different indentations', 'jobs:\n  a:\n    runs-on: x\n     steps:\n      - run: npm install\n'],
    ['a job that is not a mapping', 'jobs:\n  a: npm install\n'],
    ['an empty jobs mapping', 'jobs:\nenv:\n  X: 1\n'],
    ['jobs given as a list', 'jobs:\n  - steps:\n      - run: npm install\n'],
    ['a lone CR (a line break for GitHub, a character for YAML 1.2)', 'jobs:\n  a:\n    steps:\n      - run: echo\r        npm install\n'],
    ['two documents', 'jobs:\n  a:\n    steps:\n      - run: echo\n---\njobs:\n  a:\n    steps:\n      - run: npm install\n'],
    ['a %YAML directive', '%YAML 1.1\n---\njobs:\n  a:\n    steps:\n      - run: echo\n'],
    ['a top level that is not a mapping', '- jobs\n'],
  ])('fails closed on %s', (_label, source) => {
    expect(() => parseWorkflowJobs(source)).toThrow();
  });

  // インデントが 2 でない job・indentless な steps は有効な YAML なので、読み飛ばさずに読む (空配列で終わらせない)。
  it('reads jobs at another indentation and indentless steps instead of skipping them', () => {
    const source = 'jobs:\n    build:\n        runs-on: x\n        steps:\n        - uses: actions/checkout@v4\n        - run: npm install\n        env:\n            A: b\n    other:\n        steps:\n          -   name: wide\n              run: npx foo\n';
    const jobs = parseWorkflowJobs(source);
    expect(jobs.map((j) => [j.job, j.steps.map((s) => s.run)])).toEqual([
      ['build', [null, 'npm install']],
      ['other', ['npx foo']],
    ]);
  });

  // 引用符付きの job id・flow 形式の job・CRLF も YAML として読む (以前は throw)。
  it('reads a quoted job key, a job given as a flow mapping and CRLF line endings', () => {
    expect(parseWorkflowJobs('jobs:\n  "a":\n    steps:\n      - run: npm install\n').map((j) => [j.job, j.steps[0].run])).toEqual([['a', 'npm install']]);
    expect(parseWorkflowJobs('jobs:\n  a: {steps: [{run: npm install}]}\n').map((j) => [j.job, j.steps[0].run])).toEqual([['a', 'npm install']]);
    expect(parseWorkflowJobs('jobs:\r\n  a:\r\n    steps:\r\n      - run: npm install\r\n').map((j) => [j.job, j.steps[0].run])).toEqual([['a', 'npm install']]);
    expect(installGuardViolations('jobs:\n  a: {steps: [{run: npm install}]}\n', 'x.yml').join('\n')).toMatch(/x\.yml\/a step 1: "npm install" .* is not an allowed line/);
  });

  it('reads trailing comments on job and steps keys and keeps comments inside literal blocks in the run', () => {
    const jobs = parseWorkflowJobs('jobs: # c\n  a: # c\n    steps: # c\n      - run: |\n          # shell comment\n          node x.mjs\n');
    expect(jobs[0].steps[0].run).toBe('# shell comment\nnode x.mjs\n');
  });
});


describe('runLines', () => {
  it('joins bash line continuations before splitting, trims lines and drops blank ones', () => {
    expect(runLines('np\\\nm install\n\n  npm ci \\\n  --ignore-scripts  \n# c')).toEqual(['npm install', 'npm ci   --ignore-scripts', '# c']);
  });
});

// Codex レビュー 7 回目 (PR #778) で、シェルを分解して意味を推測する方式をやめた (`--` 以降の位置引数・ハイフン 1 個の
// 否定・行末コメント・引用の中の gate の名前で、判定と bash の解釈がずれ続けたため)。npm / npx / 2 つの gate の名前を
// 含む行は、前後の空白を除いた行全体が許可リストに完全一致するものだけを通す。
describe('installGuardViolations', () => {
  const step = (run: string, extra = '') => `      - run: ${run}${extra}`;
  const block = (...lines: string[]) => `      - run: |\n${lines.map((line) => `          ${line}`).join('\n')}`;
  const SOURCE_GATE = step('node scripts/lockfile-gate.mjs');
  const INSTALL = step('npm ci --ignore-scripts');
  const REBUILD = step('node scripts/installed-scripts-gate.mjs --rebuild node_modules');
  const guard = (...steps: string[]) => installGuardViolations(workflow(steps.join('\n')), 'x.yml');
  // ci.yml の build の step の run (パイプの build の行を許す唯一の形)
  const CI_BUILD_RUN = runLines(parseWorkflowJobs(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'))
    .flatMap((job) => job.steps).find((step) => step.run?.includes('tee build.log'))!.run!);

  it('allows exactly the lines the workflows use, without comment, separator, expansion or quote characters', () => {
    expect([...ALLOWED_RUN_LINES]).toEqual([
      'npm ci --ignore-scripts',
      'npm ci --omit=dev --ignore-scripts',
      'npm --prefix tools/lighthouse ci --ignore-scripts',
      'node scripts/lockfile-gate.mjs',
      'node scripts/installed-scripts-gate.mjs --rebuild node_modules',
      'node scripts/installed-scripts-gate.mjs --rebuild tools/lighthouse/node_modules',
      'npm run build',
      'npm run e2e',
      'npm run lint',
      'npm run typecheck',
      'npm --prefix packages/x402-sdk test',
      'npm run build 2>&1 | tee build.log',
    ]);
    // パイプを含むのは、run 全体が ci.yml の build の step と一致するときだけ許す build の 1 行だけ
    expect(ALLOWED_RUN_LINES.filter((line) => /[|&]/.test(line))).toEqual(['npm run build 2>&1 | tee build.log']);
    for (const line of ALLOWED_RUN_LINES) {
      expect(line).not.toMatch(/[#;$`'"\\(){}]|(^|\s)--(\s|$)|npx/);
    }
  });

  it.each([
    ['separate steps', [SOURCE_GATE, INSTALL, REBUILD, step('npm run build')]],
    ['production deps only', [SOURCE_GATE, step('npm ci --omit=dev --ignore-scripts'), REBUILD]],
    ['a second install under tools/lighthouse', [SOURCE_GATE, INSTALL, REBUILD, step('npm --prefix tools/lighthouse ci --ignore-scripts'), step('node scripts/installed-scripts-gate.mjs --rebuild tools/lighthouse/node_modules')]],
    ['allowed npm lines and local bins inside a longer run', [block('./node_modules/.bin/vitest run', 'npm run lint', 'npm --prefix packages/x402-sdk test', 'echo done')]],
    ['the build piped to tee in the run of the ci.yml build step', [block(...CI_BUILD_RUN)]],
    ['a YAML comment after a plain run (bash never sees it)', [SOURCE_GATE, step('npm ci --ignore-scripts # see docs'), REBUILD]],
    ['quoted runs', [step("'node scripts/lockfile-gate.mjs'"), step('"npm ci --ignore-scripts"'), REBUILD]],
    ['a source gate without an install (the audit job)', [SOURCE_GATE, step('node scripts/audit-gate.mjs')]],
    ['lines without npm / npx / gate names', [block('echo "::error::secret is not set" && exit 1', 'code=$(curl -s -o /dev/null -w "%{http_code}" https://example.com)', 'tools/lighthouse/node_modules/.bin/lhci collect')]],
  ])('accepts %s', (_label, steps) => {
    expect(guard(...steps)).toEqual([]);
  });

  // これまでの回帰 (4〜7 回目) をすべて「許可リストに無い行」として拒否する。
  it.each([
    // 5 回目: ラッパー・サブシェル・展開・行継続・コメント
    ['env', ['env npm install']],
    ['bash -c', ["bash -c 'npm install'"]],
    ['sh -c', ['sh -c "npm install"']],
    ['command substitution', ['echo "$(npm install)"']],
    ['backticks', ['echo `npm install`']],
    ['xargs', ['ls | xargs npm install']],
    ['a subshell', ['(npm install)']],
    ['a brace group', ['{ npm install; }']],
    ['sudo', ['sudo npm install']],
    ['exec npx', ['exec npx foo']],
    ['an absolute path', ['/usr/bin/npm install']],
    ['a local npm bin path', ['./node_modules/.bin/npm install']],
    ['negation', ['! npm install']],
    ['an assignment that stores npm', ['n=npm; $n install']],
    ['an assignment before a wrapper', ['FOO=1 env npm install']],
    ['a trailing shell comment', ['node x.mjs # then npm install']],
    ['a comment joined with the next line', ['# note \\', 'npm install']],
    ['a comment mentioning npx', ['# npx would fetch']],
    ['a line continuation inside the word', ['np\\', 'm install']],
    ['a substitution in npm arguments', ['npm run "$(npm install)"']],
    ['a variable in npm arguments', ['npm ci $FLAGS']],
    ['quoted npm arguments', ["npm ci '--ignore-scripts'"]],
    ['a second npm in one line', ['npm run build npm install']],
    ['a background install', ['npm ci --ignore-scripts & npm install']],
    ['npx with a subshell', ['npx foo (bar)']],
    // 4・5 回目: npx・サブコマンド・prefix の別の書き方
    ['npx --no', ['npx --no vitest run']],
    ['npx', ['npx playwright test']],
    ['npm install', ['npm install']],
    ['npm i', ['npm i']],
    ['npm rebuild', ['npm rebuild']],
    ['npm exec', ['npm exec foo']],
    ['npm prune', ['npm prune']],
    ['npm test (not used by the workflows)', ['npm test']],
    ['npm audit (not used by the workflows)', ['npm audit']],
    ['an npm run script that is not listed', ['npm run test:run']],
    ['--prefix=', ['npm --prefix=tools/lighthouse ci --ignore-scripts']],
    ['-C', ['npm -C tools/lighthouse ci --ignore-scripts']],
    ['two prefixes', ['npm --prefix a --prefix=b ci --ignore-scripts']],
    ['another prefix', ['npm --prefix tools/x ci --ignore-scripts']],
    // 4〜6 回目: --ignore-scripts の打ち消し・値・重複
    ['npm ci without --ignore-scripts', ['npm ci']],
    ['--no-ignore-scripts', ['npm ci --ignore-scripts --no-ignore-scripts']],
    ['--ignore-scripts=false', ['npm ci --ignore-scripts --ignore-scripts=false']],
    ['--ignore-scripts false', ['npm ci --ignore-scripts false']],
    ['--ignore-scripts true', ['npm ci --ignore-scripts true']],
    ['--ignore-scripts twice', ['npm ci --ignore-scripts --ignore-scripts']],
    ['an abbreviated second flag', ['npm ci --ignore-scripts --ignore-scr false']],
    ['a value after a prefixed install', ['npm --prefix tools/lighthouse ci --ignore-scripts false']],
    // 7 回目 P1: `--` 以降は位置引数・ハイフン 1 個の否定・行末コメントの中の --ignore-scripts
    ['--ignore-scripts after --', ['npm ci -- --ignore-scripts']],
    ['a single-hyphen negation', ['npm ci --ignore-scripts -no-ignore-scripts']],
    ['--ignore-scripts only in a trailing comment', ['npm ci # install policy: --ignore-scripts']],
    // 6 回目: gate の失敗を隠す書き方
    ['a gate piped to tee', ['node scripts/installed-scripts-gate.mjs --rebuild node_modules | tee /dev/null']],
    ['a gate piped with |&', ['node scripts/installed-scripts-gate.mjs --rebuild node_modules |& tee log']],
    ['a gate followed by || true', ['node scripts/installed-scripts-gate.mjs --rebuild node_modules || true']],
    ['a gate in the background', ['node scripts/installed-scripts-gate.mjs --rebuild node_modules &']],
    ['a gate followed by ; echo ok', ['node scripts/installed-scripts-gate.mjs --rebuild node_modules; echo ok']],
    ['a gate followed by && echo ok', ['node scripts/installed-scripts-gate.mjs --rebuild node_modules && echo ok']],
    ['npm ci piped into the gate', ['npm ci --ignore-scripts | node scripts/installed-scripts-gate.mjs --rebuild node_modules']],
    ['npm ci || the gate', ['npm ci --ignore-scripts || node scripts/installed-scripts-gate.mjs --rebuild node_modules']],
    ['npm ci && the gate on one line (not used by the workflows)', ['npm ci --ignore-scripts && node scripts/installed-scripts-gate.mjs --rebuild node_modules']],
    ['the source gate piped to tee', ['node scripts/lockfile-gate.mjs | tee /dev/null']],
    ['the source gate followed by || true', ['node scripts/lockfile-gate.mjs || true']],
    ['the source gate timed', ['time node scripts/lockfile-gate.mjs']],
    ['the source gate under another path', ['node ./scripts/lockfile-gate.mjs']],
    ['the installed-scripts gate without --rebuild', ['node scripts/installed-scripts-gate.mjs node_modules']],
    ['the installed-scripts gate for an unknown root', ['node scripts/installed-scripts-gate.mjs --rebuild tools/x/node_modules']],
    // 7 回目 P2 (fail-closed 側): 説明文の中の gate の名前も行全体の完全一致を求める
    ['a gate name inside echo', ['echo "usage; node scripts/lockfile-gate.mjs; done"']],
    // 部分一致 (大文字小文字を問わない) で拾う別のパッケージマネージャ・npm の設定
    ['pnpm', ['pnpm install']],
    ['corepack', ['corepack npm install']],
    ['an npm_config_ assignment', ['npm_config_ignore_scripts=false npm ci --ignore-scripts']],
    ['an NPM_CONFIG_ export', ['export NPM_CONFIG_REGISTRY=https://registry.example']],
    ['the build piped to tee without set -o pipefail', ['npm run build 2>&1 | tee build.log']],
  ])('reports a line that is not allowed: %s', (_label, lines) => {
    expect(guard(block(...lines)).join('\n')).toMatch(/is not an allowed line/);
  });

  it.each([
    ['the install with another line in its step', [SOURCE_GATE, block('npm ci --ignore-scripts', 'node scripts/installed-scripts-gate.mjs --rebuild node_modules')], /"npm ci --ignore-scripts" must be the whole run of its step/],
    ['the install split by a line continuation', [SOURCE_GATE, block('npm ci \\', '--ignore-scripts'), REBUILD], /must be the whole run of its step/],
    ['the gate followed by another line', [SOURCE_GATE, INSTALL, block('node scripts/installed-scripts-gate.mjs --rebuild node_modules', 'echo ok')], /must be the whole run of its step/],
    // 7 回目 P1: `true || # source check` + 改行 + gate は、bash では gate が走らない
    ['the source gate after `true || # comment`', [block('true || # source check', 'node scripts/lockfile-gate.mjs'), INSTALL, REBUILD], /must be the whole run of its step[\s\S]*must come before the install/],
    // 7 回目 P2: 説明文に gate の名前を書いた行は、本物の gate の step があっても違反 (run の中に書かない)
    ['a gate name in an echo before the real gate', [block('echo "usage; node scripts/lockfile-gate.mjs; done"'), SOURCE_GATE, INSTALL, REBUILD], /is not an allowed line/],
    ['no source gate', [INSTALL, REBUILD], /must come before the install/],
    ['the source gate after the install', [INSTALL, REBUILD, SOURCE_GATE], /must come before the install/],
    ['continue-on-error on the source gate', [step('node scripts/lockfile-gate.mjs', '\n        continue-on-error: true'), INSTALL, REBUILD], /continue-on-error/],
    ['continue-on-error before the source gate', [step('echo a', '\n        continue-on-error: true'), SOURCE_GATE, INSTALL, REBUILD], /continue-on-error/],
    ['no installed-scripts gate', [SOURCE_GATE, INSTALL, step('npm run build')], /next step must run only node scripts\/installed-scripts-gate\.mjs --rebuild node_modules/],
    ['the gate for another root', [SOURCE_GATE, step('npm --prefix tools/lighthouse ci --ignore-scripts'), REBUILD], /next step must run only node scripts\/installed-scripts-gate\.mjs --rebuild tools\/lighthouse\/node_modules/],
    ['continue-on-error on the installed-scripts gate', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', '\n        continue-on-error: true')], /must not continue on error/],
    ['the gate two steps later', [SOURCE_GATE, INSTALL, '      - uses: actions/cache@v4', REBUILD], /next step must run only/],
    ['working-directory on the install', [SOURCE_GATE, step('npm ci --ignore-scripts', '\n        working-directory: packages/x'), REBUILD], /working-directory or shell/],
    ['shell on the installed-scripts gate', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', '\n        shell: sh')], /working-directory or shell/],
  ])('reports %s', (_label, steps, message) => {
    expect(guard(...steps).join('\n')).toMatch(message);
  });
});

// Codex レビュー 8 回目 (PR #778): 許可した行のままでも、env による npm の設定の差し替え・gate だけを飛ばす if・
// pipefail が効かない run・defaults / shell による実行のされ方の変更で偽 green になっていた。
describe('installGuardViolations: env, if, the pipefail build run, defaults and shell', () => {
  const step = (run: string, extra = '') => `      - run: ${run}${extra}`;
  const block = (...lines: string[]) => `      - run: |\n${lines.map((line) => `          ${line}`).join('\n')}`;
  const SOURCE_GATE = step('node scripts/lockfile-gate.mjs');
  const INSTALL = step('npm ci --ignore-scripts');
  const REBUILD = step('node scripts/installed-scripts-gate.mjs --rebuild node_modules');
  const full = (steps: string[], { top = '', job = '', tail = '' } = {}) =>
    `name: x\non: push\npermissions:\n  contents: read\n${top}jobs:\n  build:\n    runs-on: ubuntu-latest\n${job}    steps:\n${steps.join('\n')}\n${tail}`;
  const guard = (steps: string[], options: { top?: string, job?: string, tail?: string } = {}) => installGuardViolations(full(steps, options), 'x.yml');
  const SEQUENCE = [SOURCE_GATE, INSTALL, REBUILD];
  const CI_BUILD_RUN = runLines(parseWorkflowJobs(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'))
    .flatMap((job) => job.steps).find((step) => step.run?.includes('tee build.log'))!.run!);
  const IF_SKIP = "\n        if: steps.secrets.outputs.skip != 'true'";

  it('keeps the pipefail template identical to the ci.yml build step', async () => {
    const { PIPEFAIL_BUILD_RUN } = await import('../../scripts/lib/workflowRun.mjs');
    expect([...PIPEFAIL_BUILD_RUN]).toEqual(CI_BUILD_RUN);
  });

  it.each([
    ['the install sequence with ordinary env at every level', [step('npm ci --ignore-scripts', '\n        env:\n          TZ: UTC'), REBUILD], { top: 'env:\n  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: \'true\'\n', job: '    env:\n      NEXT_PUBLIC_NETWORK_ENV: testnet\n' }],
    ['the Pimlico shape (no if on the source gate, the same if on the install and the gate)', [SOURCE_GATE, step('npm ci --omit=dev --ignore-scripts', IF_SKIP), step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', IF_SKIP)], {}],
    ['a job-level if (it applies to the whole job)', SEQUENCE, { job: "    if: github.event_name == 'push'\n" }],
    ['shell on a step without npm / npx / gate lines', [...SEQUENCE, step('echo hi', '\n        shell: bash {0}')], {}],
    // continue-on-error: false (YAML の真偽値) は「なし」と同じ
    ['continue-on-error: false on the gates', [step('node scripts/lockfile-gate.mjs', '\n        continue-on-error: false'), INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', '\n        continue-on-error: false')], {}],
    // 引用符付きの if は install と同じ文字列なら同じ if
    ['a quoted if on the gate equal to the install if', [SOURCE_GATE, step('npm ci --omit=dev --ignore-scripts', IF_SKIP), step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', "\n        if: \"steps.secrets.outputs.skip != 'true'\"")], {}],
  ])('accepts %s', (_label, steps, options) => {
    const allSteps = steps[0] === SOURCE_GATE ? steps : [SOURCE_GATE, ...steps];
    expect(guard(allSteps, options)).toEqual([]);
  });

  // 1. env による npm の設定 (取得元・ignore-scripts) の差し替え
  it.each([
    ['workflow env', SEQUENCE, { top: 'env:\n  NPM_CONFIG_REGISTRY: https://mirror.example/\n' }, /x\.yml: env NPM_CONFIG_REGISTRY/],
    ['workflow env after jobs', SEQUENCE, { tail: 'env:\n  npm_config_registry: https://mirror.example/\n' }, /x\.yml: env npm_config_registry/],
    ['job env', SEQUENCE, { job: '    env:\n      npm_config_registry: https://mirror.example/\n' }, /x\.yml\/build: env npm_config_registry/],
    ['install step env', [SOURCE_GATE, step('npm ci --ignore-scripts', '\n        env:\n          NPM_CONFIG_REGISTRY: https://mirror.example/'), REBUILD], {}, /step 2: env NPM_CONFIG_REGISTRY/],
    ['env of another step', [...SEQUENCE, step('npm run build', "\n        env:\n          npm_config_ignore_scripts: 'false'")], {}, /step 4: env npm_config_ignore_scripts/],
    // YAML として読める別書式 (以前は throw): flow mapping・引用符付きの key
    ['a flow mapping at the workflow level', SEQUENCE, { top: 'env: {NPM_CONFIG_REGISTRY: https://mirror.example/}\n' }, /x\.yml: env NPM_CONFIG_REGISTRY/],
    ['a quoted env key', SEQUENCE, { job: '    env:\n      "NPM_CONFIG_REGISTRY": https://mirror.example/\n' }, /x\.yml\/build: env NPM_CONFIG_REGISTRY/],
    ['a quoted top-level env key', SEQUENCE, { top: '"env":\n  NPM_CONFIG_REGISTRY: x\n' }, /x\.yml: env NPM_CONFIG_REGISTRY/],
  ])('reports npm_config_* in %s', (_label, steps, options, message) => {
    expect(guard(steps, options).join('\n')).toMatch(message);
  });

  it.each([
    ['an expression at the step level', [SOURCE_GATE, step('npm ci --ignore-scripts', '\n        env: ${{ fromJSON(vars.ENV) }}'), REBUILD], {}],
    ['an expression at the workflow level', SEQUENCE, { top: 'env: ${{ fromJSON(vars.ENV) }}\n' }],
    ['env given as a list', SEQUENCE, { job: '    env:\n      - NPM_CONFIG_REGISTRY=x\n' }],
    ['misaligned env keys', SEQUENCE, { job: '    env:\n      A: b\n       NPM_CONFIG_REGISTRY: x\n' }],
    ['two top-level env keys', SEQUENCE, { top: 'env:\n  A: b\n', tail: 'env:\n  NPM_CONFIG_REGISTRY: x\n' }],
    ['an env key hidden by an anchor and a merge key', SEQUENCE, { top: 'x-npm: &npm\n  NPM_CONFIG_REGISTRY: x\nenv:\n  <<: *npm\n' }],
  ])('fails closed on env it cannot read: %s', (_label, steps, options) => {
    expect(() => guard(steps, options)).toThrow();
  });

  // 2. gate だけが飛ばされる if (Codex の 2 例ほか)
  it.each([
    ['the Pimlico installed-scripts gate with another condition', [SOURCE_GATE, step('npm ci --omit=dev --ignore-scripts', IF_SKIP), step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', "\n        if: steps.secrets.outputs.skip == 'true'")], /step 3: the if of a gate step/],
    ['the CI source gate only on push', [step('node scripts/lockfile-gate.mjs', "\n        if: github.event_name == 'push'"), INSTALL, REBUILD], /step 1: the if of a gate step/],
    ['the installed-scripts gate with an if the install does not have', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', '\n        if: always()')], /step 3: the if of a gate step/],
    ['a block scalar if on the gate', [SOURCE_GATE, step('npm ci --ignore-scripts', '\n        if: |\n          true'), step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', '\n        if: |\n          false')], /the if of (the install step|a gate step)/],
    // if は文字列だけ (YAML の真偽値は install と同じでも 1 行の文字列ではない)
    ['a boolean if on the install and the gate', [SOURCE_GATE, step('npm ci --ignore-scripts', '\n        if: true'), step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', '\n        if: true')], /step 2: the if of the install step must be a single-line string[\s\S]*step 3: the if of a gate step/],
    // 引用符の有無は値に関係しない (同じ文字列なら同じ if)
    ['a quoted if that differs only in spaces', [SOURCE_GATE, step('npm ci --ignore-scripts', IF_SKIP), step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', "\n        if: \"steps.secrets.outputs.skip  != 'true'\"")], /step 3: the if of a gate step/],
    // continue-on-error は無いか YAML の false だけ (式・文字列の 'false' は続行しうる値として扱う)
    ['continue-on-error given as an expression on the installed-scripts gate', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', '\n        continue-on-error: ${{ always() }}')], /must not continue on error/],
    ["continue-on-error given as the string 'false' on the source gate", [step('node scripts/lockfile-gate.mjs', "\n        continue-on-error: 'false'"), INSTALL, REBUILD], /no continue-on-error up to and including the source gate/],
  ])('reports %s', (_label, steps, message) => {
    expect(guard(steps).join('\n')).toMatch(message);
  });

  // 3. pipefail が build のときに効く保証が無い run
  it.each([
    // set -o pipefail の行はあるが、呼ばれないサブシェル関数の中なので build には効かない
    ['pipefail set only inside a subshell function', CI_BUILD_RUN.flatMap((line) => (line === 'set -o pipefail' ? ['enable() (', line, ')'] : [line]))],
    ['pipefail turned off before the build', CI_BUILD_RUN.flatMap((line) => (line.startsWith('npm run build') ? ['set +o pipefail', line] : [line]))],
    ['only set -o pipefail before the build line', ['set -o pipefail', 'npm run build 2>&1 | tee build.log']],
    ['the template with an extra line at the end', [...CI_BUILD_RUN, 'echo done']],
  ])('reports the piped build in a run that is not the template: %s', (_label, lines) => {
    expect(guard([...SEQUENCE, block(...lines)]).join('\n')).toMatch(/"npm run build 2>&1 \| tee build\.log" .* is not an allowed line/);
  });

  // 4. defaults と shell
  it.each([
    ['workflow defaults.run.shell', SEQUENCE, { top: 'defaults:\n  run:\n    shell: bash {0}\n' }, /x\.yml: defaults/],
    ['job defaults.run.working-directory', SEQUENCE, { job: '    defaults:\n      run:\n        working-directory: packages/x\n' }, /x\.yml\/build: defaults/],
    ['shell on a step with an allowed npm line', [...SEQUENCE, step('npm run lint', '\n        shell: bash {0}')], {}, /step 4: a step that runs npm \/ a gate must not set shell/],
    ['shell on the source gate', [step('node scripts/lockfile-gate.mjs', '\n        shell: bash {0}'), INSTALL, REBUILD], {}, /step 1: a step that runs npm \/ a gate must not set shell/],
    ['shell on the pipefail build step', [...SEQUENCE, `${block(...CI_BUILD_RUN)}\n        shell: bash {0}`], {}, /step 4: a step that runs npm \/ a gate must not set shell/],
  ])('reports %s', (_label, steps, options, message) => {
    expect(guard(steps, options).join('\n')).toMatch(message);
  });
});
