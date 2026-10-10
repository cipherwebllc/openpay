import { describe, expect, it } from 'vitest';
import { classifyNpmCommand, installGuardViolations, parseWorkflowJobs, splitCommands, splitShell } from '../../scripts/lib/workflowRun.mjs';

// Codex レビュー 4 回目 (PR #778) 2: workflow ガードが YAML の別書式 (`run: |`・`run: >-`・引用符付き) と
// 1 step 内の追加コマンド (`npm ci --ignore-scripts && npm rebuild`) を見逃していた。run をこの形まで読み、
// 読めない形は throw する (fail-closed)。

function workflow(stepsYaml: string) {
  return `name: x\non: push\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${stepsYaml}`;
}

describe('parseWorkflowJobs', () => {
  it('reads plain, quoted and block scalar runs into commands', () => {
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
    expect(steps.map((s) => s.commands)).toEqual([
      [],
      ['npm ci --ignore-scripts'],
      ['npm ci --ignore-scripts'],
      ['npm ci --ignore-scripts'],
      ['npm ci --ignore-scripts', 'node scripts/installed-scripts-gate.mjs --rebuild node_modules'],
      ['npm ci --ignore-scripts'],
      ['echo a', 'echo b'],
      ['npm ci --ignore-scripts', 'npm rebuild'],
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
    expect(jobs[0].steps.map((s) => s.commands)).toEqual([['./node_modules/.bin/vitest run tests/a.test.ts'], ['node x.mjs']]);
  });

  it('separates jobs and stops at the next top-level key', () => {
    const source = 'jobs:\n  a:\n    steps:\n      - run: npm ci --ignore-scripts\n  b:\n    runs-on: x\n    steps:\n      - name: n\n        run: node x.mjs\nenv:\n  X: "- run: npm install"\n';
    const jobs = parseWorkflowJobs(source);
    expect(jobs.map((j) => j.job)).toEqual(['a', 'b']);
    expect(jobs[1].steps[0].commands).toEqual(['node x.mjs']);
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
    expect(jobs.map((j) => [j.job, j.steps.map((s) => s.commands)])).toEqual([
      ['build', [[], ['npm install']]],
      ['other', [['npx foo']]],
    ]);
  });

  it('reads trailing comments on job and steps keys and keeps comments inside literal blocks as shell comments', () => {
    const jobs = parseWorkflowJobs('jobs: # c\n  a: # c\n    steps: # c\n      - run: |\n          # shell comment\n          node x.mjs\n');
    expect(jobs[0].steps[0].commands).toEqual(['node x.mjs']);
  });
});

describe('splitCommands / classifyNpmCommand', () => {
  it('splits on shell separators and drops leading time / env assignments', () => {
    expect(splitCommands('time npx playwright test | tee log; FOO=1 npm ci --ignore-scripts || true\n  # comment\nnode x.mjs')).toEqual([
      'npx playwright test', 'tee log', 'npm ci --ignore-scripts', 'true', 'node x.mjs',
    ]);
  });

  it('classifies npm and npx invocations', () => {
    expect(classifyNpmCommand('npm --prefix tools/lighthouse ci --ignore-scripts')).toEqual({ tool: 'npm', subcommand: 'ci', args: ['ci', '--ignore-scripts'], prefix: 'tools/lighthouse' });
    expect(classifyNpmCommand('npm ci --omit=dev --ignore-scripts')).toMatchObject({ subcommand: 'ci' });
    expect(classifyNpmCommand('npx --no playwright test')).toEqual({ tool: 'npx', subcommand: null, args: ['--no', 'playwright', 'test'], prefix: null });
    expect(classifyNpmCommand('node scripts/x.mjs')).toBeNull();
    expect(classifyNpmCommand('./node_modules/.bin/vitest run')).toBeNull();
  });

  // --prefix の別の書き方でも gate の対象 root (tools/…/node_modules) を取り違えない。
  it('reads --prefix=<dir> and -C <dir> as the prefix and rejects a second or empty prefix', () => {
    expect(classifyNpmCommand('npm --prefix=tools/lighthouse ci --ignore-scripts')).toMatchObject({ subcommand: 'ci', prefix: 'tools/lighthouse', args: ['ci', '--ignore-scripts'] });
    expect(classifyNpmCommand('npm -C tools/lighthouse ci --ignore-scripts')).toMatchObject({ subcommand: 'ci', prefix: 'tools/lighthouse' });
    expect(() => classifyNpmCommand('npm --prefix a --prefix=b ci')).toThrow();
    expect(() => classifyNpmCommand('npm --prefix= ci')).toThrow();
    expect(() => classifyNpmCommand('npm ci --prefix')).toThrow();
  });

  // Codex レビュー 5 回目 (PR #778) 2: ラッパー・サブシェル・展開・行継続で npm を先頭以外に置くと分類 (= 検査) を
  // すり抜けていた。npm / npx で始まらないのに npm / npx という語を含むコマンドは一律に throw する。
  it.each([
    ['env', 'env npm install'],
    ['bash -c', "bash -c 'npm install'"],
    ['sh -c', 'sh -c "npm install"'],
    ['command substitution', 'echo "$(npm install)"'],
    ['backticks', 'echo `npm install`'],
    ['xargs', 'ls | xargs npm install'],
    ['a subshell', '(npm install)'],
    ['a brace group', '{ npm install; }'],
    ['sudo', 'sudo npm install'],
    ['exec', 'exec npx foo'],
    ['an absolute path', '/usr/bin/npm install'],
    ['a local bin path', './node_modules/.bin/npm install'],
    ['negation', '! npm install'],
    ['an assignment that stores npm', 'n=npm; $n install'],
    ['an assignment inside the command', 'FOO=1 env npm install'],
    ['a trailing shell comment', 'node x.mjs # then npm install'],
    ['a comment joined with the next line by a line continuation', '# note \\\nnpm install'],
    ['a comment mentioning npx', '# npx would fetch'],
    ['an npm command with a substitution in its arguments', 'npm run "$(npm install)"'],
    ['an npm command with a variable', 'npm ci $FLAGS'],
    ['an npm command with quotes', "npm ci '--ignore-scripts'"],
    ['an npm command with a second npm', 'npm run build npm install'],
    ['an npx command with a subshell', 'npx foo (bar)'],
  ])('throws on npm / npx it cannot read: %s', (_label, shell) => {
    expect(() => splitCommands(shell)).toThrow();
  });

  it('joins line continuations before splitting, like bash', () => {
    expect(splitCommands('np\\\nm install')).toEqual(['npm install']);
    expect(classifyNpmCommand(splitCommands('np\\\nm install')[0])).toMatchObject({ tool: 'npm', subcommand: 'install' });
    expect(splitCommands('npm ci \\\n  --ignore-scripts')).toEqual(['npm ci --ignore-scripts']);
    // block scalar の中の行継続も同じ (本文のインデントを落としてから連結する = bash が見る文字列)
    const jobs = parseWorkflowJobs(workflow('      - run: |\n          np\\\n          m install'));
    expect(jobs[0].steps[0].commands).toEqual(['npm install']);
    const indented = parseWorkflowJobs(workflow('      - run: |\n          np\\\n            m install'));
    expect(indented[0].steps[0].commands).toEqual(['np m install']);
  });

  it('splits on a single & (background) but not on redirections', () => {
    expect(splitCommands('npm ci --ignore-scripts & npm install')).toEqual(['npm ci --ignore-scripts', 'npm install']);
    expect(splitCommands('npm run build 2>&1 | tee build.log')).toEqual(['npm run build 2>&1', 'tee build.log']);
    expect(splitCommands('npm run build &> log |& tee x')).toEqual(['npm run build &> log', 'tee x']);
  });

  it.each([
    './node_modules/.bin/vitest run --no-cache tests/a.test.ts',
    'time ./node_modules/.bin/playwright test --config=playwright.prodflags.config.ts',
    'tools/lighthouse/node_modules/.bin/lhci collect',
    'node scripts/installed-scripts-gate.mjs --rebuild node_modules',
    'echo "::error::secret is not set" && exit 1',
    'code=$(curl -s -o /dev/null -w "%{http_code}" https://example.com)',
  ])('does not throw on commands without npm / npx: %s', (shell) => {
    expect(() => splitCommands(shell)).not.toThrow();
  });
});

// tests/scripts/workflow-guards.test.ts が実 workflow に当てる規則 (lockfile-gate → npm ci --ignore-scripts → 実体 gate の
// rebuild・npx 禁止・npm のサブコマンド) を fixture で確かめる。
describe('installGuardViolations', () => {
  const step = (run: string, extra = '') => `      - run: ${run}${extra}`;
  const SOURCE_GATE = step('node scripts/lockfile-gate.mjs');
  const INSTALL = step('npm ci --ignore-scripts');
  const REBUILD = step('node scripts/installed-scripts-gate.mjs --rebuild node_modules');
  const guard = (...steps: string[]) => installGuardViolations(workflow(steps.join('\n')), 'x.yml');

  it.each([
    ['separate steps', [SOURCE_GATE, INSTALL, REBUILD, step('npm run build')]],
    ['npm ci and the gate in one step', [SOURCE_GATE, step('npm ci --ignore-scripts && node scripts/installed-scripts-gate.mjs --rebuild node_modules')]],
    ['a prefixed install', [SOURCE_GATE, step('npm --prefix tools/x ci --ignore-scripts'), step('node scripts/installed-scripts-gate.mjs --rebuild tools/x/node_modules')]],
    ['local bins and npm run / test', [step('./node_modules/.bin/vitest run'), step('npm run lint'), step('npm --prefix packages/x test')]],
  ])('accepts %s', (_label, steps) => {
    expect(guard(...steps)).toEqual([]);
  });

  it.each([
    ['npx', [step('npx --no vitest run')], /npx is not allowed/],
    ['npm install', [step('npm install')], /forbidden npm subcommand install/],
    ['npm rebuild', [step('npm rebuild')], /forbidden npm subcommand rebuild/],
    ['an unknown subcommand', [step('npm prune')], /unknown npm subcommand prune/],
    ['npm ci without --ignore-scripts', [SOURCE_GATE, step('npm ci'), REBUILD], /--ignore-scripts/],
    ['--no-ignore-scripts', [SOURCE_GATE, step('npm ci --ignore-scripts --no-ignore-scripts'), REBUILD], /undo --ignore-scripts/],
    ['--ignore-scripts=false', [SOURCE_GATE, step('npm ci --ignore-scripts --ignore-scripts=false'), REBUILD], /undo --ignore-scripts/],
    ['no source gate', [INSTALL, REBUILD], /lockfile-gate\.mjs must run before/],
    ['the source gate after the install', [INSTALL, REBUILD, SOURCE_GATE], /lockfile-gate\.mjs must run before/],
    ['continue-on-error on the source gate', [step('node scripts/lockfile-gate.mjs', '\n        continue-on-error: true'), INSTALL, REBUILD], /continue-on-error/],
    ['no installed-scripts gate', [SOURCE_GATE, INSTALL, step('npm run build')], /next command must be/],
    ['the gate for another root', [SOURCE_GATE, step('npm --prefix tools/x ci --ignore-scripts'), REBUILD], /tools\/x\/node_modules/],
    ['continue-on-error on the installed-scripts gate', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules', '\n        continue-on-error: true')], /must not continue on error/],
    ['another command between npm ci and the gate', [SOURCE_GATE, step('npm ci --ignore-scripts && echo ok'), REBUILD], /next command must be/],
    ['the gate two steps later', [SOURCE_GATE, INSTALL, '      - uses: actions/cache@v4', REBUILD], /same step or the next one/],
  ])('reports %s', (_label, steps, message) => {
    const violations = guard(...steps);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join('\n')).toMatch(message);
  });

  // Codex レビュー 6 回目 (PR #778) P1: npm (nopt) は `--ignore-scripts false` の false を値として読み、scripts の無効化を
  // 解除する。--ignore-scripts の存在だけでなく、ちょうど 1 回・値なし・略記や否定なしを求める。
  it.each([
    ['--ignore-scripts false', 'npm ci --ignore-scripts false'],
    ['--ignore-scripts true', 'npm ci --ignore-scripts true'],
    ['--ignore-scripts given twice', 'npm ci --ignore-scripts --ignore-scripts'],
    ['an abbreviated second flag', 'npm ci --ignore-scripts --ignore-scr false'],
    ['a value after a prefixed install', 'npm --prefix tools/x ci --ignore-scripts false'],
  ])('reports npm ci with %s', (_label, install) => {
    const root = install.includes('--prefix tools/x') ? 'tools/x/node_modules' : 'node_modules';
    const violations = guard(SOURCE_GATE, step(install), step(`node scripts/installed-scripts-gate.mjs --rebuild ${root}`));
    expect(violations.join('\n')).toMatch(/--ignore-scripts (must be given exactly once|takes no value)/);
  });

  it('accepts --ignore-scripts followed by another flag', () => {
    expect(guard(SOURCE_GATE, step('npm ci --ignore-scripts --omit=dev'), REBUILD)).toEqual([]);
  });

  // Codex レビュー 6 回目 (PR #778) P2: GitHub の既定の shell (bash -e) に pipefail は無く、gate を tee にパイプする・
  // || true を付ける・バックグラウンドにする・後ろにコマンドを続けると、gate の失敗が step の成功に隠れうる。
  it.each([
    ['piped to tee', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules | tee /dev/null')]],
    ['piped with |&', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules |& tee log')]],
    ['followed by || true', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules || true')]],
    ['run in the background', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules &')]],
    ['followed by ; echo ok', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules; echo ok')]],
    ['followed by && echo ok', [SOURCE_GATE, INSTALL, step('node scripts/installed-scripts-gate.mjs --rebuild node_modules && echo ok')]],
    ['followed by another line', [SOURCE_GATE, INSTALL, step('|\n          node scripts/installed-scripts-gate.mjs --rebuild node_modules\n          echo ok')]],
    ['on the right of a pipe from npm ci', [SOURCE_GATE, step('npm ci --ignore-scripts | node scripts/installed-scripts-gate.mjs --rebuild node_modules')]],
    ['after npm ci in the background', [SOURCE_GATE, step('npm ci --ignore-scripts & node scripts/installed-scripts-gate.mjs --rebuild node_modules')]],
    ['after npm ci ||', [SOURCE_GATE, step('npm ci --ignore-scripts || node scripts/installed-scripts-gate.mjs --rebuild node_modules')]],
    ['after npm ci || continued on the next line', [SOURCE_GATE, step('|\n          npm ci --ignore-scripts ||\n          node scripts/installed-scripts-gate.mjs --rebuild node_modules')]],
    ['the source gate piped to tee', [step('node scripts/lockfile-gate.mjs | tee /dev/null'), INSTALL, REBUILD]],
    ['the source gate followed by || true', [step('node scripts/lockfile-gate.mjs || true'), INSTALL, REBUILD]],
    ['the source gate followed by ; echo ok', [step('node scripts/lockfile-gate.mjs; echo ok'), INSTALL, REBUILD]],
  ])('reports a gate %s', (_label, steps) => {
    expect(guard(...steps).join('\n')).toMatch(/a gate must run on its own at the end of its step/);
  });

  it.each([
    ['after npm ci &&', [SOURCE_GATE, step('npm ci --ignore-scripts && node scripts/installed-scripts-gate.mjs --rebuild node_modules')]],
    ['after npm ci on the previous line', [SOURCE_GATE, step('|\n          npm ci --ignore-scripts\n          node scripts/installed-scripts-gate.mjs --rebuild node_modules')]],
    ['after npm ci ;', [SOURCE_GATE, step('npm ci --ignore-scripts; node scripts/installed-scripts-gate.mjs --rebuild node_modules')]],
    ['timed', [step('time node scripts/lockfile-gate.mjs'), INSTALL, REBUILD]],
  ])('accepts a gate %s', (_label, steps) => {
    expect(guard(...steps)).toEqual([]);
  });
});

describe('splitShell', () => {
  it('returns the separator before and after each command', () => {
    expect(splitShell('a | tee x && b || c; d &\ne\nf |& g')).toEqual([
      { command: 'a', before: '', after: '|' },
      { command: 'tee x', before: '|', after: '&&' },
      { command: 'b', before: '&&', after: '||' },
      { command: 'c', before: '||', after: ';' },
      { command: 'd', before: ';', after: '&' },
      { command: 'e', before: '&', after: '\n' },
      { command: 'f', before: '\n', after: '|&' },
      { command: 'g', before: '|&', after: '' },
    ]);
  });

  it('treats a new line after &&, || or | as the continuation of that operator, like bash', () => {
    expect(splitShell('a ||\n  # comment\nb &&\nc |\nd')).toEqual([
      { command: 'a', before: '', after: '||' },
      { command: 'b', before: '||', after: '&&' },
      { command: 'c', before: '&&', after: '|' },
      { command: 'd', before: '|', after: '' },
    ]);
  });

  it('keeps redirections inside the command and a trailing operator as after', () => {
    expect(splitShell('npm run build 2>&1 &> log;')).toEqual([{ command: 'npm run build 2>&1 &> log', before: '', after: ';' }]);
  });
});
