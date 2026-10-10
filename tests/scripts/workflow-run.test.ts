import { describe, expect, it } from 'vitest';
import { ALLOWED_RUN_LINES, installGuardViolations, parseWorkflowJobs, runLines } from '../../scripts/lib/workflowRun.mjs';

// Codex レビュー 4 回目 (PR #778) 2: workflow ガードが YAML の別書式 (`run: |`・`run: >-`・引用符付き) と
// 1 step 内の追加コマンド (`npm ci --ignore-scripts && npm rebuild`) を見逃していた。run をこの形まで読み、
// 読めない形は throw する (fail-closed)。7 回目以降、run の中身はシェルとして分解せず、npm / npx / gate の名前を
// 含む行を許可リストと完全一致で照合する (installGuardViolations)。

function workflow(stepsYaml: string) {
  return `name: x\non: push\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${stepsYaml}`;
}

describe('parseWorkflowJobs', () => {
  it('reads plain, quoted and block scalar runs', () => {
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
    expect(steps.map((s) => s.run)).toEqual([
      null,
      'npm ci --ignore-scripts',
      'npm ci --ignore-scripts',
      'npm ci --ignore-scripts',
      'npm ci --ignore-scripts\nnode scripts/installed-scripts-gate.mjs --rebuild node_modules',
      'npm ci --ignore-scripts',
      'echo a && echo b',
      'npm ci --ignore-scripts && npm rebuild',
    ]);
    expect(steps[0].keys.uses).toBe('actions/checkout@v4');
    expect(steps[7].keys['continue-on-error']).toBe('true');
    expect(steps[7].keys.env).toBe('');
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

  it.each([
    ['alias', '      - run: *install'],
    ['anchor', '      - run: &install npm ci'],
    ['tag', '      - run: !!str npm ci'],
    ['flow sequence', '      - run: [npm, ci]'],
    ['flow mapping', '      - run: {a: b}'],
    ['indentation indicator', '      - run: |2\n          npm ci'],
    ['unterminated single quote', "      - run: 'npm ci\n          --ignore-scripts'"],
    ['unterminated double quote', '      - run: "npm ci\n          --ignore-scripts"'],
    ['empty block scalar', '      - run: |\n      - run: echo'],
    ['empty run', '      - run:'],
    ['two run keys', '      - run: a\n        run: b'],
  ])('fails closed on %s', (_label, step) => {
    expect(() => parseWorkflowJobs(workflow(step))).toThrow();
  });

  it('fails closed when there is no jobs key', () => {
    expect(() => parseWorkflowJobs('name: x\n')).toThrow();
  });

  // Codex レビュー 5 回目 (PR #778) 3: 有効な YAML なのに読み飛ばして (throw せずに) run を見逃していた形。
  // 「読む形」以外を読み残したら throw する。
  it.each([
    ['a double-quoted step key', '      - "run": npm install'],
    ['a single-quoted step key', "      - 'run': npm install"],
    ['a quoted key after the first one', '      - name: x\n        "run": npm install'],
    ['a plain scalar continued on the next line', '      - run: echo ok &&\n          npm install'],
    ['a continuation line under another key', '      - name: x\n          run: npm install'],
    ['a comment between a plain scalar and its continuation', '      - run: echo ok &&\n          # note\n          npm install'],
    ['an escaped newline in a double-quoted run', '      - run: "echo ok\\nnpm install"'],
    ['any escape in a double-quoted run', '      - run: "npm ci --ignore-scripts\\t"'],
    ['a key deeper than the step keys', '      - name: x\n         run: npm install'],
    ['a key between the dash and the step keys', '      - name: x\n       run: npm install'],
    ['a tab in the indentation', '      - name: x\n\trun: npm install'],
    ['a key without a space after the colon (a plain scalar in YAML)', '      - run:npm install'],
    ['a merge key', '      - <<: *defaults\n        run: echo'],
    ['a complex key', '      - ? run\n        : npm install'],
    ['a flow mapping step', '      - {run: npm install}'],
    ['a step whose keys start on the next line', '      -\n        run: npm install'],
    ['a run value on the next line', '      - run:\n          npm install'],
    ['a folded run with a blank line (kept as a newline)', '      - run: >\n          echo a\n\n          npm install'],
    ['a folded run with a more-indented line (kept as a newline)', '      - run: >\n          echo a\n            npm install'],
    ['a block scalar header with an indentation indicator after chomping', '      - run: |-2\n          npm ci'],
  ])('fails closed on %s', (_label, step) => {
    expect(() => parseWorkflowJobs(workflow(step))).toThrow();
  });

  it.each([
    ['steps given as a flow sequence', 'jobs:\n  a:\n    steps: []\n'],
    ['a job without steps (uses: a reusable workflow)', 'jobs:\n  a:\n    uses: ./.github/workflows/x.yml\n'],
    ['a job with an empty steps key', 'jobs:\n  a:\n    runs-on: x\n    steps:\n  b:\n    steps:\n      - run: echo\n'],
    ['steps followed by a mapping instead of a sequence', 'jobs:\n  a:\n    steps:\n      run: npm install\n'],
    ['jobs at different indentations', 'jobs:\n  a:\n    steps:\n      - run: echo\n   b:\n    steps:\n      - run: npm install\n'],
    ['a step line between the job keys and the items', 'jobs:\n  a:\n    steps:\n      - run: echo\n     - run: npm install\n'],
    ['job keys at different indentations', 'jobs:\n  a:\n    runs-on: x\n     steps:\n      - run: npm install\n'],
    ['a quoted job key', 'jobs:\n  "a":\n    steps:\n      - run: npm install\n'],
    ['a job given as a flow mapping', 'jobs:\n  a: {steps: [{run: npm install}]}\n'],
    ['an empty jobs mapping', 'jobs:\nenv:\n  X: 1\n'],
    ['CR line endings', 'jobs:\r\n  a:\r\n    steps:\r\n      - run: npm install\r\n'],
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

  it('reads trailing comments on job and steps keys and keeps comments inside literal blocks in the run', () => {
    const jobs = parseWorkflowJobs('jobs: # c\n  a: # c\n    steps: # c\n      - run: |\n          # shell comment\n          node x.mjs\n');
    expect(jobs[0].steps[0].run).toBe('# shell comment\nnode x.mjs');
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
    // パイプを含むのは set -o pipefail の後ろでだけ許す build の 1 行だけ
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
    ['the build piped to tee after set -o pipefail', [block('set -o pipefail', 'npm run build 2>&1 | tee build.log', 'node scripts/check-bundle-budget.mjs < build.log')]],
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
