import { describe, expect, it } from 'vitest';
import { classifyNpmCommand, parseWorkflowJobs, splitCommands } from '../../scripts/lib/workflowRun.mjs';

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
      '          npx --no vitest run',
      '          tests/a.test.ts',
      '      # 説明のコメント (step より浅い) は本文ではない',
      '      # npm install と書いてあっても無視される',
      '      - run: node x.mjs',
    ].join('\n')));
    expect(jobs[0].steps.map((s) => s.commands)).toEqual([['npx --no vitest run tests/a.test.ts'], ['node x.mjs']]);
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
  });
});
