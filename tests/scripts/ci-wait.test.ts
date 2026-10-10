// @vitest-environment node
// scripts/ci-wait.mjs (merge の唯一の判定) の「期待する check 名の集合」フェンス (第 7 回レビュー E8)。
//
// 以前は「出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED」で exit 0 だったので、e2e / lighthouse の
// workflow run がまだ check として現れていない瞬間や、必須 job が skip された場合も緑扱いになりえた。
// ここでは (1) 正本 scripts/ci-expected-checks.json (= EXPECTED_PR_CHECKS) が今の workflow から解析した集合と
// 一致すること (ドリフト検出)・解析できない形 (対応する形の外) が現れたら除外せず落ちること (fail-closed)
// (2) 欠けた check は settle しないこと (3) 期待 check は SUCCESS のみ合格であること (4) base が main 以外では
// 期待集合を使わないこと (5) --head は完全 OID で比較すること (6) CLI は対象 PR の HEAD の JSON だけを読み、
// 形が違えば exit 3 にすることを固定する。workflow は `yaml` で読む (scripts/lib/ciWaitWorkflows.mjs) ので、
// 引用符付きの key・flow 形式・複数行の値など YAML として意味が明確な別書式は読み、ドリフトとして数える。
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPECTED_CHECKS_PATH,
  EXPECTED_PR_CHECKS,
  evaluateChecks,
  expectedChecksFor,
  normalizeRollup,
  parseExpectedChecksJson,
} from '../../scripts/lib/ciWait.mjs';
import { analyzeWorkflows, parseWorkflow } from '../../scripts/lib/ciWaitWorkflows.mjs';

const SCRIPT = resolve('scripts/ci-wait.mjs');
const WORKFLOWS = resolve('.github/workflows');
const FULL_HEAD = '4981cc5deadbeef0000000000000000000000000';
const LOCAL_JSON = readFileSync(resolve(EXPECTED_CHECKS_PATH), 'utf8');

/** 期待集合 JSON の正規形 (scripts/ci-expected-checks.json と同じ整形)。 */
function expectedJson(checks: readonly string[]) {
  return `${JSON.stringify({ checks }, null, 2)}\n`;
}

function run(name: string, status: string, conclusion: string) {
  return { __typename: 'CheckRun', name, status, conclusion, context: null, state: null };
}
const VERCEL_ENTRIES = [
  { __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS', name: null, status: null, conclusion: null },
  run('Vercel Preview Comments', 'COMPLETED', 'SUCCESS'),
];
function rollupOf(names: readonly string[], overrides: Record<string, { status?: string; conclusion?: string }> = {}) {
  return [
    ...names.map((n) => run(n, overrides[n]?.status ?? 'COMPLETED', overrides[n]?.conclusion ?? 'SUCCESS')),
    ...VERCEL_ENTRIES,
  ];
}

const JOB = 'jobs:\n  a:\n    runs-on: x\n';

/** 一時ディレクトリに workflow を書いて analyzeWorkflows の結果を返す (ディレクトリは消す)。 */
function analyze(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-wait-wf-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return analyzeWorkflows(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 文書として読めない (on: / jobs: を読まずに止まる) こと。理由はすべて document: で始まる。 */
function expectDocumentProblem(src: string) {
  const wf = parseWorkflow(src);
  expect(wf.unsupported.length, src).toBeGreaterThan(0);
  for (const reason of wf.unsupported) expect(reason, src).toMatch(/^document: /);
  expect(wf).toMatchObject({ pullRequest: false, jobs: [] });
}

describe('期待 check 集合の正本 (JSON) と workflow のドリフト検出 (fail-closed)', () => {
  it('正本の JSON は正規形で読め、EXPECTED_PR_CHECKS はそれと同じ (JS 側に別の値を持たない)', () => {
    expect(EXPECTED_CHECKS_PATH).toBe('scripts/ci-expected-checks.json');
    const parsed = parseExpectedChecksJson(LOCAL_JSON);
    expect(parsed).toEqual({ checks: [...EXPECTED_PR_CHECKS] });
    expect(LOCAL_JSON).toBe(expectedJson(EXPECTED_PR_CHECKS));
  });

  it('正本の JSON は今の .github/workflows から解析した「main 向け PR で必ず走る job」と一致する', () => {
    const { required, excluded, unsupported } = analyzeWorkflows(WORKFLOWS);
    expect(unsupported, '解析できない形の workflow / job がある (parser を広げるか job を見直す)').toEqual([]);
    expect([...required].sort()).toEqual([...EXPECTED_PR_CHECKS].sort());
    expect(excluded.map((e) => e.workflow).sort()).toEqual([
      'jpyc-activity-cron.yml',
      'kv-backup-watch.yml',
      'kv-backup.yml',
      'pimlico-balance.yml',
      'post-deploy-verify.yml',
      'reverify-cron.yml',
      'upstash-usage-watch.yml',
    ]);
    for (const e of excluded) expect(e.reason).toBe('no pull_request trigger');
  });

  it('on の形: string / 配列 / map / map の値が null・{} / 引用符付きの on / block 配列 / flow map / 複数行の flow を読む', () => {
    expect(parseWorkflow(`on: pull_request\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on: push\n${JOB}`).pullRequest).toBe(false);
    expect(parseWorkflow(`on: [push, pull_request]\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on: [push]\n${JOB}`).pullRequest).toBe(false);
    expect(parseWorkflow(`"on": pull_request\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`'on': pull_request\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on:\n  push:\n    branches: [main]\n  pull_request:\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on:\n  pull_request: {}\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on:\n  pull_request: null\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on:\n  - push\n  - pull_request\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on: {pull_request: {}}\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on: {push: {branches: [main]}}\n${JOB}`).pullRequest).toBe(false);
    expect(parseWorkflow(`on:\n  schedule:\n    - cron: "0 0 * * *"\n${JOB}`).pullRequest).toBe(false);
    // pull_request_target は別イベント (PR の head では走らない) なので PR trigger と数えない
    expect(parseWorkflow(`on:\n  pull_request_target:\n${JOB}`).pullRequest).toBe(false);
    for (const src of [
      `on: pull_request\n${JOB}`,
      `on: {pull_request: {}}\n${JOB}`,
      `on:\n  pull_request: {}\n${JOB}`,
      `on:\n  - pull_request\n${JOB}`,
      // YAML として意味が明確な別書式 (以前の手書きの読み取りは unsupported にしていた)
      `on: {push, pull_request}\n${JOB}`,
      `on: [push,\n  pull_request]\n${JOB}`,
      `on:\n  ? pull_request\n${JOB}`,
      `---\non: pull_request\n${JOB}...\n`,
    ]) {
      expect(parseWorkflow(src), src).toMatchObject({ pullRequest: true, unsupported: [] });
    }
  });

  it('paths / paths-ignore / types は block でも flow map でも (引用符付きの値でも) filtered に出す', () => {
    expect(parseWorkflow(`on:\n  pull_request:\n    paths:\n      - docs/**\n${JOB}`).filtered).toBe('paths');
    expect(parseWorkflow(`on:\n  pull_request:\n    paths-ignore: [docs/**.md]\n${JOB}`).filtered).toBe('paths-ignore');
    expect(parseWorkflow(`on:\n  pull_request:\n    types: [labeled]\n${JOB}`).filtered).toBe('types');
    expect(parseWorkflow(`on:\n  pull_request: {paths: [docs/**]}\n${JOB}`).filtered).toBe('paths');
    expect(parseWorkflow(`on: {pull_request: {paths: [docs/**], branches: [main]}}\n${JOB}`).filtered).toBe('paths');
    expect(parseWorkflow(`on:\n  pull_request:\n    branches: [main]\n${JOB}`).filtered).toBeNull();
    expect(parseWorkflow(`on:\n  pull_request:\n    paths:\n      - "docs/**"\n${JOB}`)).toMatchObject({ filtered: 'paths', unsupported: [] });
    expect(parseWorkflow(`on:\n  pull_request:\n    paths-ignore: ["**.md"]\n${JOB}`)).toMatchObject({ filtered: 'paths-ignore', unsupported: [] });
    // 配列でない・空・文字列でない要素は読まない (除外ではなく unsupported)
    expect(parseWorkflow(`on:\n  pull_request:\n    paths: docs/**\n${JOB}`).unsupported).toEqual(['on.pull_request.paths: unreadable list']);
    expect(parseWorkflow(`on:\n  pull_request:\n    types: []\n${JOB}`).unsupported).toEqual(['on.pull_request.types: unreadable list']);
    expect(parseWorkflow(`on:\n  pull_request:\n    paths: [docs, {a: b}]\n${JOB}`).unsupported).toEqual(['on.pull_request.paths: unreadable list']);
    expect(parseWorkflow(`on:\n  pull_request:\n    tags: [v1]\n${JOB}`).unsupported).toEqual(['on.pull_request.tags: unsupported key']);
  });

  it('branches は main を含むときだけ main 向け PR の check に数える (block list / flow list / 引用符付き / branches-ignore)', () => {
    expect(parseWorkflow(`on:\n  pull_request:\n    branches: [main]\n${JOB}`).branches).toEqual(['main']);
    expect(parseWorkflow(`on:\n  pull_request:\n    branches:\n      - main\n      - release\n${JOB}`).branches).toEqual(['main', 'release']);
    expect(parseWorkflow(`on:\n  pull_request:\n    branches-ignore: [main]\n${JOB}`).branchesIgnore).toEqual(['main']);
    const glob = parseWorkflow(`on:\n  pull_request:\n    branches: [release/**]\n${JOB}`);
    expect(glob.unsupported.join()).toContain('glob');
    expect(parseWorkflow(`on:\n  pull_request:\n    branches: ["main"]\n${JOB}`)).toMatchObject({ branches: ['main'], unsupported: [] });
    expect(parseWorkflow(`on:\n  pull_request:\n    branches:\n      - 'main'\n${JOB}`)).toMatchObject({ branches: ['main'], unsupported: [] });
    expect(parseWorkflow(`on:\n  pull_request:\n    branches: []\n${JOB}`).unsupported).toEqual(['on.pull_request.branches: unreadable list']);
    // filter pattern のエスケープ (`ma\in` は GitHub では main に一致) は完全一致で比べられないので unsupported
    // (branches では「main を除外」、branches-ignore では「main を含まない」と誤って判定しない)
    expect(parseWorkflow(`on:\n  pull_request:\n    branches: ['ma\\in']\n${JOB}`)).toMatchObject({
      branches: null,
      unsupported: ['on.pull_request.branches: escape in pattern (ma\\in)'],
    });
    expect(parseWorkflow(`on:\n  pull_request:\n    branches-ignore: ["ma\\\\in"]\n${JOB}`)).toMatchObject({
      branchesIgnore: null,
      unsupported: ['on.pull_request.branches-ignore: escape in pattern (ma\\in)'],
    });
    expect(analyze({
      'esc.yml': `on:\n  pull_request:\n    branches: ['ma\\in']\njobs:\n  esc:\n    runs-on: x\n`,
      'ign.yml': `on:\n  pull_request:\n    branches-ignore: ['ma\\in']\njobs:\n  ign:\n    runs-on: x\n`,
    })).toEqual({
      required: [],
      excluded: [],
      unsupported: [
        { workflow: 'esc.yml', reason: 'on.pull_request.branches: escape in pattern (ma\\in)' },
        { workflow: 'ign.yml', reason: 'on.pull_request.branches-ignore: escape in pattern (ma\\in)' },
      ],
    });
    const r = analyze({
      'release.yml': `on:\n  pull_request:\n    branches: [release]\njobs:\n  rel:\n    runs-on: x\n`,
      'ignore.yml': `on:\n  pull_request:\n    branches-ignore: [main]\njobs:\n  ign:\n    runs-on: x\n`,
      'main.yml': `on:\n  pull_request:\n    branches: [main]\njobs:\n  ok:\n    runs-on: x\n`,
    });
    expect(r.unsupported).toEqual([]);
    expect(r.required).toEqual(['ok']);
    expect(r.excluded).toEqual([
      { workflow: 'ignore.yml', reason: 'pull_request branches-ignore has main' },
      { workflow: 'release.yml', reason: 'pull_request branches exclude main' },
    ]);
  });

  it('job の check 名は name: があればそれ (引用符の中の # も含む)、無ければ job id', () => {
    const wf = parseWorkflow([
      'on: pull_request',
      'jobs:',
      '  plain: # job',
      '    runs-on: ubuntu-latest',
      '  named:',
      '    name: "check #1"',
      '    runs-on: ubuntu-latest',
      '  single:',
      "    name: 'Pretty Name' # trailing",
      '    runs-on: ubuntu-latest',
      '',
    ].join('\n'));
    expect(wf.unsupported).toEqual([]);
    expect(wf.jobs.map((j) => [j.id, j.name])).toEqual([
      ['plain', 'plain'],
      ['named', 'check #1'],
      ['single', 'Pretty Name'],
    ]);
  });

  it('on: のイベント名は YAML の値で判定する (引用符付きでも pull_request と読む・未知の名前は unsupported)', () => {
    for (const src of [
      `on:\n  push:\n  "pull_request":\n${JOB}`,
      `on:\n  push:\n  'pull_request':\n${JOB}`,
      `on: [push, "pull_request"]\n${JOB}`,
      `on: "pull_request"\n${JOB}`,
      `on:\n  - push\n  - "pull_request"\n${JOB}`,
      `on: {"pull_request": {}}\n${JOB}`,
      `on: {push: {}, "pull_request": {}}\n${JOB}`,
    ]) {
      expect(parseWorkflow(src), src).toMatchObject({ pullRequest: true, unsupported: [] });
    }
    expect(parseWorkflow(`on:\n  "pull_request_target":\n${JOB}`)).toMatchObject({ pullRequest: false, unsupported: [] });
    const cases: [string, string[]][] = [
      [`on:\n  Push:\n${JOB}`, ['on: unknown event (Push)']],
      [`on: [Push]\n${JOB}`, ['on: unknown event (Push)']],
      [`on:\n  - Push\n${JOB}`, ['on: unknown event (Push)']],
      [`on: Push\n${JOB}`, ['on: unknown event (Push)']],
      [`on: [push, pull_request: {}]\n${JOB}`, ['on: unknown event ({"pull_request":{}})']],
      [`on:\n  - push:\n${JOB}`, ['on: unknown event ({"push":null})']],
      [`on: [push, 1]\n${JOB}`, ['on: unknown event (1)']],
    ];
    for (const [src, expected] of cases) {
      expect(parseWorkflow(src).unsupported, src).toEqual(expected);
    }
    // 対応する形だけで書かれ pull_request が無いときだけ「除外」になる
    expect(parseWorkflow(`on:\n  push:\n    branches: [main]\n  schedule:\n    - cron: "0 0 * * *"\n  workflow_dispatch: {}\n${JOB}`).unsupported).toEqual([]);
    expect(parseWorkflow(`on: [push, workflow_dispatch]\n${JOB}`)).toMatchObject({ pullRequest: false, unsupported: [] });
  });

  it('既存の cron workflow に "pull_request": を足すと除外のままにならず必須 job が増え、ドリフト検査が赤になる (kv-backup-watch.yml の再現)', () => {
    const original = readFileSync(join(WORKFLOWS, 'kv-backup-watch.yml'), 'utf8');
    const mutated = original.replace(/^on:\n/m, 'on:\n  "pull_request":\n');
    expect(mutated).not.toBe(original);
    const r = analyze({ 'kv-backup-watch.yml': mutated });
    expect(r).toEqual({ required: ['watch'], excluded: [], unsupported: [] });
    expect(EXPECTED_PR_CHECKS).not.toContain('watch');
    // PR 以外のイベントを足しただけなら除外のまま
    const pushOnly = analyze({ 'kv-backup-watch.yml': original.replace(/^on:\n {2}schedule:\n/m, 'on:\n  push: {}\n  schedule:\n') });
    expect(pushOnly).toEqual({ required: [], excluded: [{ workflow: 'kv-backup-watch.yml', reason: 'no pull_request trigger' }], unsupported: [] });
  });

  it('jobs の引用符付き key (job id・field) も YAML の値として読む', () => {
    const wf = parseWorkflow('on: pull_request\njobs:\n  "test":\n    runs-on: x\n  a:\n    "name": b\n    runs-on: x\n');
    expect(wf.unsupported).toEqual([]);
    expect(wf.jobs.map((j) => [j.id, j.name, j.conditional])).toEqual([['test', 'test', null], ['a', 'b', null]]);
  });

  it('name は YAML の値で読む (複数行の引用符・継続行・folded は 1 行に畳む・エスケープと二重の引用符を解く)', () => {
    const wf = parseWorkflow([
      'on: pull_request',
      'jobs:',
      '  dq:',
      '    name: "added',
      '      check"',
      '    runs-on: x',
      '  sq:',
      "    name: 'single",
      "      quoted'",
      '    runs-on: x',
      '  plain:',
      '    name: plain',
      '      continued',
      '    runs-on: x',
      '  folded:',
      '    name: >-',
      '      long',
      '      name',
      '    runs-on: x',
      '  esc:',
      '    name: "a\\"b"',
      '    runs-on: x',
      '  dup:',
      "    name: 'it''s'",
      '    runs-on: x',
      '',
    ].join('\n'));
    expect(wf.unsupported).toEqual([]);
    expect(wf.jobs.map((j) => [j.id, j.name, j.conditional])).toEqual([
      ['dq', 'added check', null],
      ['sq', 'single quoted', null],
      ['plain', 'plain continued', null],
      ['folded', 'long name', null],
      ['esc', 'a"b', null],
      ['dup', "it's", null],
    ]);
  });

  it('check 名として採用できない name (文字列でない・空・改行や制御文字を含む・式) は誤採用せず job ごとに unsupported', () => {
    const wf = parseWorkflow([
      'on: pull_request',
      'jobs:',
      '  flow:',
      '    name: [a, b]',
      '    runs-on: x',
      '  number:',
      '    name: 123',
      '    runs-on: x',
      '  empty:',
      '    name:',
      '    runs-on: x',
      '  blank:',
      '    name: "  "',
      '    runs-on: x',
      '  literal:',
      '    name: |',
      '      two',
      '      lines',
      '    runs-on: x',
      '  newline:',
      '    name: "a\\nb"',
      '    runs-on: x',
      '  tab:',
      '    name: "a\\tb"',
      '    runs-on: x',
      '  expr:',
      '    name: Build ${{ matrix.os }}',
      '    runs-on: x',
      '',
    ].join('\n'));
    expect(wf.unsupported).toEqual([]);
    expect(wf.jobs.map((j) => [j.id, j.name, j.conditional])).toEqual([
      ['flow', 'flow', 'name is not a string'],
      ['number', 'number', 'name is not a string'],
      ['empty', 'empty', 'empty name'],
      ['blank', 'blank', 'empty name'],
      ['literal', 'literal', 'multi-line name'],
      ['newline', 'newline', 'multi-line name'],
      ['tab', 'tab', 'control character in name'],
      ['expr', 'expr', 'expression in name'],
    ]);
  });

  it('解析できない形 (式や複数行の name・matrix・if・reusable workflow・条件付き親への needs・重複名・未対応の on) は unsupported', () => {
    const r = analyze({
      'a.yml': [
        'on: pull_request',
        'jobs:',
        '  expr:',
        '    name: Build ${{ matrix.os }}',
        '    runs-on: x',
        '  multi:',
        '    name: |',
        '      long',
        '      name',
        '    runs-on: x',
        '  matrix:',
        '    strategy:',
        '      matrix:',
        '        node: [20, 22]',
        '    runs-on: x',
        '  gated:',
        '    if: always()',
        '    runs-on: x',
        '  child:',
        '    needs: gated',
        '    runs-on: x',
        '  orphan:',
        '    needs: [nobody]',
        '    runs-on: x',
        '  reusable:',
        '    uses: ./.github/workflows/shared.yml',
        '  fine:',
        '    needs:',
        '      - plain',
        '    runs-on: x',
        '  plain:',
        '    runs-on: x',
        '  badneeds:',
        '    needs: {a: b}',
        '    runs-on: x',
        '',
      ].join('\n'),
      'b.yml': 'on: pull_request\njobs:\n  plain:\n    runs-on: x\n',
      'c.yml': 'on: !!binary abc\njobs:\n  c:\n    runs-on: x\n',
      'd.yml': 'on:\n  pull_request:\n    branches: main\njobs:\n  d:\n    runs-on: x\n',
    });
    expect(r.required).toEqual(['fine', 'plain', 'badneeds']);
    const reasons = r.unsupported.map((u) => `${u.workflow}:${u.job ?? ''}:${u.reason}`);
    expect(reasons).toEqual([
      'a.yml::jobs.badneeds.needs: unreadable list',
      'a.yml:expr:job has expression in name',
      'a.yml:multi:job has multi-line name',
      'a.yml:matrix:job has strategy:',
      'a.yml:gated:job has if:',
      'a.yml:child:needs gated (unknown or conditional)',
      'a.yml:orphan:needs nobody (unknown or conditional)',
      'a.yml:reusable:job has uses:',
      'b.yml:plain:duplicate check name plain (also a.yml)',
      'c.yml::document: tag (tag:yaml.org,2002:binary)',
      'd.yml::on.pull_request.branches: unreadable list',
    ]);
  });

  it('jobs の問題は PR で走る workflow のときだけ数える (cron の workflow は matrix / if を自由に使える)', () => {
    const r = analyze({ 'cron.yml': 'on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  m:\n    if: always()\n    strategy:\n      matrix:\n        n: [1, 2]\n    runs-on: x\n' });
    expect(r).toEqual({ required: [], excluded: [{ workflow: 'cron.yml', reason: 'no pull_request trigger' }], unsupported: [] });
  });
});

describe('文書とトップレベルを先に検査する (検査に使ってよい文書だと確かめてから除外を判定する)', () => {
  it('2 つ目のドキュメントに PR trigger を足しても、先頭だけ読んで除外しない (kv-backup-watch.yml の再現)', () => {
    const original = readFileSync(join(WORKFLOWS, 'kv-backup-watch.yml'), 'utf8');
    const line = original.split('\n').length; // 足した `---` の行番号
    const r = analyze({ 'kv-backup-watch.yml': `${original}---\non: pull_request\njobs:\n  added:\n    runs-on: x\n` });
    expect(r).toEqual({
      required: [],
      excluded: [],
      unsupported: [{ workflow: 'kv-backup-watch.yml', reason: `document: MULTIPLE_DOCS (line ${line})` }],
    });
  });

  it('先頭の BOM・`---`・末尾の `...` は 1 つのドキュメントとして読む (2 つ目のドキュメント・`--- 内容` の後の block は unsupported)', () => {
    expect(parseWorkflow(`---\non: pull_request\n${JOB}`)).toMatchObject({ pullRequest: true, unsupported: [] });
    expect(parseWorkflow(`\uFEFF# head\n--- # doc\non: pull_request\n${JOB}`)).toMatchObject({ pullRequest: true, unsupported: [] });
    expect(parseWorkflow(`on: pull_request\n${JOB}...\n`)).toMatchObject({ pullRequest: true, unsupported: [] });
    expect(parseWorkflow(`---\n---\non: push\n${JOB}`).unsupported).toEqual(['document: MULTIPLE_DOCS (line 2)']);
    expect(parseWorkflow(`on: push\n${JOB}...\non: pull_request\n`).unsupported).toEqual(['document: MULTIPLE_DOCS (line 6)']);
    expectDocumentProblem(`--- {on: pull_request}\n${JOB}`);
  });

  it('タブの字下げ・揃わない字下げ・閉じない引用符は YAML のエラーとして文書ごと unsupported', () => {
    expect(parseWorkflow(`on:\n\tpull_request:\n${JOB}`).unsupported).toEqual(['document: TAB_AS_INDENT (line 2)']);
    expect(parseWorkflow('on:\n  push:\njobs:\n\tadded:\n    runs-on: x\n').unsupported).toEqual(['document: TAB_AS_INDENT (line 4)']);
    expect(parseWorkflow('on: pull_request\njobs:\n  a:\n    runs-on: x\n   b:\n    runs-on: x\n').unsupported).toEqual(['document: BAD_INDENT (line 5)']);
    expect(parseWorkflow('on: pull_request\njobs:\n    a:\n        runs-on: x\n  b:\n    runs-on: x\n').unsupported).toEqual(['document: BAD_INDENT (line 5)']);
    expect(parseWorkflow('on:\n    push:\n  pull_request:\njobs:\n  a:\n    runs-on: x\n').unsupported).toEqual(['document: BAD_INDENT (line 2)']);
    expectDocumentProblem(`on: push\n  pull_request:\n${JOB}`);
    expectDocumentProblem(`on: [push,, pull_request]\n${JOB}`);
    expectDocumentProblem(`on:\n  pull_request:\n    paths: [a]\n      - b\n${JOB}`);
    expectDocumentProblem(`on: "pull_request\n${JOB}`);
    expectDocumentProblem(`  on: pull_request\n${JOB}`);
    // 字下げ以外のタブ (値の前の区切り) は YAML の空白として読む
    expect(parseWorkflow(`on:\tpull_request\n${JOB}`)).toMatchObject({ pullRequest: true, unsupported: [] });
  });

  it('BOM 以外の制御文字 (単独の CR・U+0085・U+2028・途中の BOM・NUL) は unsupported・CRLF は読む', () => {
    expect(parseWorkflow(`on: pull_request\r\njobs:\r\n  a:\r\n    runs-on: x\r\n`)).toMatchObject({ pullRequest: true, unsupported: [] });
    const cases: [string, string][] = [
      [`on: push\r  pull_request:\n${JOB}`, 'U+000D at line 1'],
      [`on:\n  push:\u0085  pull_request:\n${JOB}`, 'U+0085 at line 2'],
      [`on:\n  push:\u2028  pull_request:\n${JOB}`, 'U+2028 at line 2'],
      [`on: push\uFEFF\n${JOB}`, 'U+FEFF at line 1'],
      [`on: push\u0000\n${JOB}`, 'U+0000 at line 1'],
    ];
    for (const [src, where] of cases) {
      expect(parseWorkflow(src).unsupported, JSON.stringify(src)).toEqual([`document: control character (${where})`]);
    }
  });

  it('引用符付きのトップレベルの key は YAML の値として読み、重複 key (引用符の有無を問わない)・ディレクティブ・`<<`・アンカー / エイリアスは unsupported', () => {
    for (const src of [`"on": pull_request\n${JOB}`, `'on': pull_request\n${JOB}`, 'on: pull_request\n"jobs":\n  a:\n    runs-on: x\n']) {
      expect(parseWorkflow(src), src).toMatchObject({ pullRequest: true, unsupported: [] });
    }
    const cases: [string, string[]][] = [
      [`on: push\n"on": pull_request\n${JOB}`, ['document: DUPLICATE_KEY (line 2)']],
      [`on: push\n${JOB}jobs:\n  b:\n    runs-on: x\n`, ['document: DUPLICATE_KEY (line 5)']],
      [`on: push\n? jobs\n${JOB}`, ['document: DUPLICATE_KEY (line 3)']],
      [`on: push\n<<: *defaults\n${JOB}`, ['document: merge key (<<)', 'document: alias (*defaults)']],
      [`on: push\n<<: {jobs: {a: {runs-on: x}}}\n`, ['document: merge key (<<)']],
      [`%YAML 1.2\n---\non: push\n${JOB}`, ['document: directive (%YAML 1.2)']],
      // YAML 1.1 では on が真偽値の key になる (GitHub と読み方がずれる) ので、ディレクティブごと読まない
      [`%YAML 1.1\n---\non: pull_request\n${JOB}`, ['document: directive (%YAML 1.1)', 'document: non-string key (true)']],
      [`%TAG !e! tag:example.com,2000:\n---\non: push\n${JOB}`, ['document: directive (%TAG !e! tag:example.com,2000:)']],
      // 既定の prefix を再宣言する %TAG は解決後の tags が既定と同じになるが、directive の存在そのものを拒否する
      [`%TAG !! tag:yaml.org,2002:\n---\non: push\n${JOB}`, ['document: directive (%TAG !! tag:yaml.org,2002:)']],
      // GitHub は key の中の式も展開するので、式を含む key は (評価せず) どの階層でも読まない
      [`"\${{ 'on' }}": pull_request\n${JOB}`, ["document: expression in key (${{ 'on' }})"]],
      [`on:\n  "\${{ 'pull_request' }}":\n${JOB}`, ["document: expression in key (${{ 'pull_request' }})"]],
      [`on: pull_request\njobs:\n  "\${{ 'added' }}":\n    runs-on: x\n`, ["document: expression in key (${{ 'added' }})"]],
      [`on: pull_request\njobs:\n  a:\n    "\${{ 'name' }}": x\n    runs-on: x\n`, ["document: expression in key (${{ 'name' }})"]],
      [`on: push\n1: x\n${JOB}`, ['document: non-string key (1)']],
      [`on: push\n? [a, b]\n: x\n${JOB}`, ['document: non-string key (["a","b"])']],
      [`- on: pull_request\n`, ['document: the top level is not a mapping']],
      ['', ['document: the top level is not a mapping']],
    ];
    for (const [src, expected] of cases) {
      expect(parseWorkflow(src).unsupported, src).toEqual(expected);
    }
    // "jobs": に足した必須 job も読んでドリフトとして数える (jobs=[] で黙って通らない)
    expect(analyze({ 'a.yml': 'on: pull_request\n"jobs":\n  added:\n    runs-on: x\n' })).toEqual({ required: ['added'], excluded: [], unsupported: [] });
  });

  it('トップレベルの key は workflow の key だけ (NBSP で字下げしたつもりの行がトップレベルの key になった形を除外しない)', () => {
    const nbsp = parseWorkflow(`on:\n  push:\n\u00A0 pull_request:\n${JOB}`);
    expect(nbsp).toMatchObject({ pullRequest: false, unsupported: [`top-level: unknown key (${JSON.stringify('\u00A0 pull_request')})`] });
    expect(analyze({ 'a.yml': `on:\n  push:\n\u00A0 pull_request:\n${JOB}` })).toEqual({
      required: [],
      excluded: [],
      unsupported: [{ workflow: 'a.yml', reason: `top-level: unknown key (${JSON.stringify('\u00A0 pull_request')})` }],
    });
    expect(parseWorkflow(`name: x\nrun-name: y\non: push\npermissions:\n  contents: read\nenv:\n  A: b\ndefaults:\n  run:\n    shell: bash\nconcurrency:\n  group: g\n${JOB}`).unsupported).toEqual([]);
  });
});

describe('アンカー / エイリアス / タグは今の workflow に無い形なので、どこにあっても文書ごと unsupported', () => {
  it('on: の値・job の name・flow map の中のアンカー / エイリアス / タグ', () => {
    const cases: [string, string[]][] = [
      [`on: {push: &cfg {}}\n${JOB}`, ['document: anchor (&cfg)']],
      [`on:\n  push: &cfg {}\n${JOB}`, ['document: anchor (&cfg)']],
      [`on: {push: *cfg}\n${JOB}`, ['document: alias (*cfg)']],
      [`on:\n  pull_request: *x\n${JOB}`, ['document: alias (*x)']],
      [`on: {push: !!map {}}\n${JOB}`, ['document: tag (tag:yaml.org,2002:map)']],
      [`on:\n  pull_request: !!map {}\n${JOB}`, ['document: tag (tag:yaml.org,2002:map)']],
      [`on: {push: {branches: *b}}\n${JOB}`, ['document: alias (*b)']],
      [`on:\n  push: &x\n    branches: [main]\n  pull_request: *x\n${JOB}`, ['document: anchor (&x)', 'document: alias (*x)']],
      ['on: pull_request\njobs:\n  a:\n    name: &n test\n    runs-on: x\n  b:\n    name: *n\n    runs-on: x\n', ['document: anchor (&n)', 'document: alias (*n)']],
      ['on: pull_request\njobs:\n  a:\n    name: !!str test\n    runs-on: x\n', ['document: tag (tag:yaml.org,2002:str)']],
      ['on: pull_request\njobs:\n  a:\n    name: ! test\n    runs-on: x\n', ['document: tag (!)']],
    ];
    for (const [src, expected] of cases) {
      expect(parseWorkflow(src).unsupported, src).toEqual(expected);
    }
    expect(analyze({ 'a.yml': `on: {push: &cfg {}}\n${JOB}` })).toEqual({
      required: [],
      excluded: [],
      unsupported: [{ workflow: 'a.yml', reason: 'document: anchor (&cfg)' }],
    });
  });
});

describe('on: の entry は block map / flow map / flow 配列 / block 配列のどれでも同じ検査を通す', () => {
  it('重複したイベントは unsupported・対応する flow map の値 (引用符付きを含む) は読む', () => {
    expect(parseWorkflow(`on: {push: {}, push: {}}\n${JOB}`).unsupported).toEqual(['document: DUPLICATE_KEY (line 1)']);
    expect(parseWorkflow(`on:\n  push:\n  push:\n${JOB}`).unsupported).toEqual(['document: DUPLICATE_KEY (line 2)']);
    expect(parseWorkflow(`on: {push: {branches: [main]}, workflow_dispatch: {inputs: {x: {type: boolean}}}}\n${JOB}`).unsupported).toEqual([]);
    expect(parseWorkflow(`on: {push: {branches: ["main"]}}\n${JOB}`).unsupported).toEqual([]);
  });

  it('イベントの値は null / mapping / (pull_request 以外の) 配列だけ', () => {
    const cases: [string, string[]][] = [
      [`on:\n  push: main\n${JOB}`, ['on.push: unreadable value ("main")']],
      [`on: {push: 1}\n${JOB}`, ['on.push: unreadable value (1)']],
      [`on:\n  pull_request:\n    - main\n${JOB}`, ['on.pull_request: unreadable value (["main"])']],
    ];
    for (const [src, expected] of cases) {
      expect(parseWorkflow(src).unsupported, src).toEqual(expected);
    }
    // schedule の cron は配列
    expect(parseWorkflow(`on:\n  schedule:\n    - cron: '0 0 * * *'\n${JOB}`).unsupported).toEqual([]);
  });

  it('on: [] / {} / null / ~ / 無い (今の workflow に無い形)・文字列でも配列でも mapping でもない on: は unsupported', () => {
    const cases: [string, string[]][] = [
      [`on: []\n${JOB}`, ['on: empty ([])']],
      [`on: {}\n${JOB}`, ['on: empty ({})']],
      [`on: null\n${JOB}`, ['on: empty (null)']],
      [`on: ~\n${JOB}`, ['on: empty (null)']],
      [`on:\n${JOB}`, ['on: empty (null)']],
      [`on: [ ]\n${JOB}`, ['on: empty ([])']],
      [`on: 1\n${JOB}`, ['on: unreadable value (1)']],
      [JOB, ['on: missing']],
    ];
    for (const [src, expected] of cases) {
      expect(parseWorkflow(src).unsupported, src).toEqual(expected);
    }
  });
});

describe('flow 形式の jobs も YAML の値として読む (以前は unsupported)', () => {
  it('jobs: {added-required: {...}} の job と test: {name: actual-check, ...} の name を読み、ドリフトとして数える', () => {
    const wf = parseWorkflow('on: pull_request\njobs: {added-required: {runs-on: x}}\n');
    expect(wf.unsupported).toEqual([]);
    expect(wf.jobs).toEqual([{ id: 'added-required', name: 'added-required', conditional: null, needs: [] }]);
    const r = analyze({
      'a.yml': 'on: pull_request\njobs:\n  test: {name: actual-check, runs-on: x}\n  plain:\n    runs-on: x\n',
      'b.yml': 'on: pull_request\njobs: {added-required: {runs-on: x}}\n',
    });
    expect(r).toEqual({ required: ['actual-check', 'plain', 'added-required'], excluded: [], unsupported: [] });
  });
});

describe('indent は YAML が決める (2 でも 4 でも・揃わなければ文書ごと unsupported)', () => {
  const fourSpace = [
    'on:',
    '    pull_request:',
    '        branches:',
    '            - main',
    'jobs:',
    '    added-required:',
    '        name: "added check"',
    '        runs-on: ubuntu-latest',
    '        needs:',
    '            - base',
    '    base:',
    '        runs-on: ubuntu-latest',
    '        steps:',
    '            - run: echo hi',
    '',
  ].join('\n');

  it('4 スペースの workflow も on / jobs / needs / branches を読む', () => {
    const wf = parseWorkflow(fourSpace);
    expect(wf.unsupported).toEqual([]);
    expect(wf.pullRequest).toBe(true);
    expect(wf.branches).toEqual(['main']);
    expect(wf.jobs.map((j) => [j.id, j.name, j.needs])).toEqual([
      ['added-required', 'added check', ['base']],
      ['base', 'base', []],
    ]);
  });

  it('4 スペースの workflow で必須 job を足したらドリフト検査が検出する (jobs=[] で黙って通らない)', () => {
    const r = analyze({ 'four.yml': fourSpace });
    expect(r.unsupported).toEqual([]);
    expect(r.required).toEqual(['added check', 'base']);
    expect([...r.required].sort()).not.toEqual([...EXPECTED_PR_CHECKS].sort());
  });

  it('jobs: が mapping でない・空・定義が mapping でない job は unsupported', () => {
    const list = parseWorkflow('on: pull_request\njobs:\n  - a\n');
    expect(list.jobs).toEqual([]);
    expect(list.unsupported).toEqual(['jobs: not a mapping (["a"])']);
    expect(parseWorkflow('on: pull_request\njobs:\n').unsupported).toEqual(['jobs: empty']);
    expect(parseWorkflow('on: pull_request\njobs: {}\n').unsupported).toEqual(['jobs: empty']);
    expect(parseWorkflow('on: pull_request\n').unsupported).toEqual(['jobs: missing']);
    const bare = parseWorkflow('on: pull_request\njobs:\n  a:\n  b:\n    runs-on: x\n  c: x\n');
    expect(bare.jobs.map((j) => [j.id, j.conditional])).toEqual([['a', 'empty definition'], ['b', null], ['c', 'definition that is not a mapping']]);
  });
});

describe('期待集合 JSON の形の検証 (parseExpectedChecksJson)', () => {
  it('正規形の {"checks": [空でない文字列…]} だけを受け付ける', () => {
    expect(parseExpectedChecksJson(expectedJson(['audit', 'test']))).toEqual({ checks: ['audit', 'test'] });
    expect(parseExpectedChecksJson(expectedJson(['check #1', 'e2e (Playwright)']))).toEqual({ checks: ['check #1', 'e2e (Playwright)'] });
  });

  it('壊れ方ごとに理由を返し、部分採用しない (配列でない・重複・空・JSON でない・余計なキー・正規形でない)', () => {
    const cases: [string, string][] = [
      ['{"checks": "audit"}\n', 'checks が配列ではありません'],
      [`${JSON.stringify({ checks: { audit: true } }, null, 2)}\n`, 'checks が配列ではありません'],
      [expectedJson(['audit', 'test', 'audit']), 'checks に重複があります (audit)'],
      [expectedJson([]), 'checks が空です'],
      [`${JSON.stringify({ checks: ['audit', ''] }, null, 2)}\n`, 'checks[1] が空でない文字列ではありません ("")'],
      [`${JSON.stringify({ checks: ['audit', 1] }, null, 2)}\n`, 'checks[1] が空でない文字列ではありません (1)'],
      [`${JSON.stringify({ checks: ['audit'], extra: [] }, null, 2)}\n`, 'キーは checks だけにすること (checks, extra)'],
      [`${JSON.stringify({ expected: ['audit'] }, null, 2)}\n`, 'キーは checks だけにすること (expected)'],
      ['{}\n', 'キーは checks だけにすること (キー無し)'],
      ['["audit"]\n', 'トップレベルが object ではありません'],
      ['null\n', 'トップレベルが object ではありません'],
      ['{"checks": ["audit",]}\n', 'JSON として読めません'],
      ["export const EXPECTED_PR_CHECKS = Object.freeze(['audit']);\n", 'JSON として読めません'],
      ['', 'JSON として読めません'],
      // JSON.parse は重複キーを黙って後勝ちにする (人が読む前半と採用する後半がずれる) ので正規形を求めて弾く
      ['{\n  "checks": [\n    "audit"\n  ],\n  "checks": [\n    "audit",\n    "test"\n  ]\n}\n', '正規形'],
      ['{"checks": ["audit", "test"]}\n', '正規形'],
      [expectedJson(['audit']).trimEnd(), '正規形'],
      [`﻿${expectedJson(['audit'])}`, 'JSON として読めません'],
    ];
    for (const [text, reason] of cases) {
      const parsed = parseExpectedChecksJson(text);
      expect('error' in parsed ? parsed.error : parsed, JSON.stringify(text)).toContain(reason);
    }
  });
});

describe('判定 (evaluateChecks / expectedChecksFor)', () => {
  const expected = EXPECTED_PR_CHECKS;

  it('期待集合は base が main のときだけ。積み上げ PR (base が main 以外) は空 = 従来の判定', () => {
    expect(expectedChecksFor('main')).toEqual([...EXPECTED_PR_CHECKS]);
    expect(expectedChecksFor('fix/invoice-tax-consistency')).toEqual([]);
    expect(expectedChecksFor('')).toEqual([]);
    const stacked = evaluateChecks(normalizeRollup(rollupOf(['test'], { test: { conclusion: 'SKIPPED' } })), expectedChecksFor('feat/x'));
    expect(stacked).toMatchObject({ settled: true, ok: true, missing: [] });
  });

  it('vercel の check は判定から外し、CheckRun / StatusContext の両形を name/status/conclusion に揃える', () => {
    const checks = normalizeRollup(rollupOf(['test']));
    expect(checks).toEqual([{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }]);
  });

  it('期待 check が全部そろって SUCCESS のときだけ ok', () => {
    const r = evaluateChecks(normalizeRollup(rollupOf(expected)), expected);
    expect(r).toMatchObject({ settled: true, ok: true, missing: [], failed: [], pending: [] });
  });

  it('期待 check が 1 つ欠けていれば (他が全部 SUCCESS でも) settle しない', () => {
    const r = evaluateChecks(normalizeRollup(rollupOf(expected.filter((n) => n !== 'lighthouse'))), expected);
    expect(r.missing).toEqual(['lighthouse']);
    expect(r.settled).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('期待 check の SKIPPED / NEUTRAL は失敗扱い (必須 job は SUCCESS を肯定形で確認する)', () => {
    for (const conclusion of ['SKIPPED', 'NEUTRAL', 'FAILURE', 'CANCELLED']) {
      const r = evaluateChecks(normalizeRollup(rollupOf(expected, { 'e2e-prodflags': { conclusion } })), expected);
      expect(r.settled, conclusion).toBe(true);
      expect(r.failed.map((c) => c.name), conclusion).toEqual(['e2e-prodflags']);
      expect(r.ok, conclusion).toBe(false);
    }
  });

  it('期待集合に無い check は従来どおり SUCCESS/NEUTRAL/SKIPPED を合格・それ以外を失敗にする', () => {
    const extraOk = evaluateChecks(normalizeRollup(rollupOf([...expected, 'extra'], { extra: { conclusion: 'SKIPPED' } })), expected);
    expect(extraOk.ok).toBe(true);
    const extraNg = evaluateChecks(normalizeRollup(rollupOf([...expected, 'extra'], { extra: { conclusion: 'FAILURE' } })), expected);
    expect(extraNg.ok).toBe(false);
    expect(extraNg.failed.map((c) => c.name)).toEqual(['extra']);
  });

  it('IN_PROGRESS / QUEUED があれば settle しない', () => {
    const r = evaluateChecks(normalizeRollup(rollupOf(expected, { test: { status: 'IN_PROGRESS', conclusion: '' } })), expected);
    expect(r.pending.map((c) => c.name)).toEqual(['test']);
    expect(r.settled).toBe(false);
  });

  it('同名の check が複数あれば (rerun の古い run など) 全部が SUCCESS でなければ失敗', () => {
    const rollup = [...rollupOf(expected), run('test', 'COMPLETED', 'FAILURE')];
    const r = evaluateChecks(normalizeRollup(rollup), expected);
    expect(r.settled).toBe(true);
    expect(r.failed.map((c) => c.name)).toEqual(['test']);
  });
});

describe('CLI (gh と git を偽物に差し替えて end-to-end)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  type CliOptions = {
    /** gh pr view の headRefOid */
    headRefOid?: string;
    /** gh pr view の baseRefName (undefined = キー自体を出さない・null = null を返す) */
    baseRefName?: string | null;
    /** gh pr view を失敗させる exit code */
    ghExit?: number;
    /** git rev-parse が返す完全 OID (null = 失敗) */
    gitResolves?: string | null;
    /** gh api contents が返す PR 側の scripts/ci-expected-checks.json (既定 = ローカルと同一) */
    prJson?: string;
    /** gh api contents の応答そのもの (既定 = prJson を base64 にした contents API の形) */
    apiBody?: unknown;
    /** gh api contents を失敗させる exit code (404 等) */
    apiExit?: number;
  };

  function cli(rollup: unknown[], args: string[], options: CliOptions = {}) {
    const {
      headRefOid = FULL_HEAD,
      ghExit = 0,
      gitResolves = null,
      prJson = LOCAL_JSON,
      apiBody = { type: 'file', encoding: 'base64', content: Buffer.from(prJson, 'utf8').toString('base64') },
      apiExit = 0,
    } = options;
    const baseRefName = 'baseRefName' in options ? options.baseRefName : 'main';
    dir = mkdtempSync(join(tmpdir(), 'ci-wait-cli-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fixture = join(dir, 'pr.json');
    const pr: Record<string, unknown> = { headRefOid, statusCheckRollup: rollup };
    if (baseRefName !== undefined) pr.baseRefName = baseRefName;
    writeFileSync(fixture, JSON.stringify(pr));
    const api = join(dir, 'api.json');
    writeFileSync(api, JSON.stringify(apiBody));
    const apiArgs = join(dir, 'api.args');
    // 本物の gh の代わり: `gh pr view` は固定 JSON、`gh api …/contents/…` は PR 側のファイル (base64) を返す
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        'case "$1" in',
        `  pr) if [ "${ghExit}" != "0" ]; then echo "fake gh failure" >&2; exit ${ghExit}; fi; cat "${fixture}" ;;`,
        `  api) printf '%s\\n' "$2" >> "${apiArgs}"; if [ "${apiExit}" != "0" ]; then echo '{"message":"Not Found","status":"404"}' >&2; exit ${apiExit}; fi; cat "${api}" ;;`,
        '  *) echo "unexpected gh $*" >&2; exit 9 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    // 本物の git の代わり: rev-parse を固定の OID で答える (gitResolves が null なら失敗)
    writeFileSync(
      join(bin, 'git'),
      gitResolves ? `#!/bin/sh\necho "${gitResolves}"\n` : '#!/bin/sh\nexit 1\n',
    );
    chmodSync(join(bin, 'git'), 0o755);
    const res = spawnSync(process.execPath, [SCRIPT, '773', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    let apiCalls: string[] = [];
    try {
      apiCalls = readFileSync(apiArgs, 'utf8').split('\n').filter(Boolean);
    } catch {
      apiCalls = [];
    }
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, apiCalls };
  }

  it('期待 check が全部 SUCCESS → SETTLED nonSUCCESS=0 missing=0 で exit 0 (既存の出力形式を保つ)', () => {
    const r = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once']);
    expect(r.stderr).toBe('');
    expect(r.stdout.split('\n')[0]).toBe('SETTLED head=4981cc5 checks=6 nonSUCCESS=0 missing=0 expected=6');
    expect(r.stdout).toContain('lighthouse\tSUCCESS');
    expect(r.stdout).not.toMatch(/vercel/i);
    expect(r.status).toBe(0);
  });

  it('lighthouse の check がまだ無い (他は SUCCESS) → --once は PENDING missing=1 で exit 2・MISSING 行を出す', () => {
    const r = cli(rollupOf(EXPECTED_PR_CHECKS.filter((n) => n !== 'lighthouse')), ['--once']);
    expect(r.stdout.split('\n')[0]).toBe('PENDING head=4981cc5 checks=5 nonSUCCESS=0 missing=1 expected=6');
    expect(r.stdout).toContain('lighthouse\tMISSING');
    expect(r.status).toBe(2);
  });

  it('期待 check が SKIPPED → SETTLED nonSUCCESS=1 で exit 1', () => {
    const r = cli(rollupOf(EXPECTED_PR_CHECKS, { 'e2e-prodflags': { conclusion: 'SKIPPED' } }), []);
    expect(r.stdout.split('\n')[0]).toBe('SETTLED head=4981cc5 checks=6 nonSUCCESS=1 missing=0 expected=6');
    expect(r.stdout).toContain('e2e-prodflags\tSKIPPED');
    expect(r.status).toBe(1);
  });

  it('base が main 以外 (積み上げ PR) → 期待集合を使わず従来の判定・先頭行に expected=skipped(base=…)', () => {
    const r = cli(rollupOf(['test', 'audit'], { audit: { conclusion: 'SKIPPED' } }), ['--once'], { baseRefName: 'fix/invoice-tax-consistency' });
    expect(r.stdout.split('\n')[0]).toBe('SETTLED head=4981cc5 checks=2 nonSUCCESS=0 missing=0 expected=skipped(base=fix/invoice-tax-consistency)');
    expect(r.stdout).not.toContain('MISSING');
    expect(r.status).toBe(0);
    const ng = cli(rollupOf(['test'], { test: { conclusion: 'FAILURE' } }), ['--once'], { baseRefName: 'feat/x' });
    expect(ng.status).toBe(1);
  });

  it('--head は完全 OID で比較する: 40 桁はそのまま・短縮は git rev-parse で解決できたときだけ・解決不能と不一致は exit 3', () => {
    expect(cli(rollupOf(EXPECTED_PR_CHECKS), ['--once', '--head', FULL_HEAD]).status).toBe(0);
    expect(cli(rollupOf(EXPECTED_PR_CHECKS), ['--once', '--head', FULL_HEAD.toUpperCase()]).status).toBe(0);
    const resolved = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once', '--head', '4981cc5'], { gitResolves: FULL_HEAD });
    expect(resolved.status).toBe(0);
    const unresolved = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once', '--head', '4981cc5']);
    expect(unresolved.status).toBe(3);
    expect(unresolved.stderr).toContain('完全 OID');
    // 前方一致では通してしまう形 (先頭 7 桁が同じ別 commit) も完全 OID の比較で弾く
    const other = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once', '--head', '4981cc5'], { gitResolves: '4981cc5' + 'f'.repeat(33) });
    expect(other.status).toBe(3);
    expect(other.stderr).toContain('HEAD 不一致');
    const mismatch = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once', '--head', 'abc1234' + '0'.repeat(33)]);
    expect(mismatch.status).toBe(3);
    expect(mismatch.stderr).toContain('HEAD 不一致');
    expect(mismatch.stderr).toContain(FULL_HEAD);
  });

  it('base が取れない (キー欠落 / null / 空文字) → 曖昧に「main 以外」へ落とさず exit 3', () => {
    for (const baseRefName of [undefined, null, '', '  ']) {
      const r = cli(rollupOf(['test']), ['--once'], { baseRefName });
      expect(r.status, JSON.stringify(baseRefName)).toBe(3);
      expect(r.stderr, JSON.stringify(baseRefName)).toContain('base branch');
      expect(r.stdout, JSON.stringify(baseRefName)).not.toContain('SETTLED');
    }
  });

  it('期待集合は対象 PR の HEAD にある scripts/ci-expected-checks.json だけから読む (PR 側が 7 件ならそれを期待する)', () => {
    const seven = [...EXPECTED_PR_CHECKS, 'added-required'];
    const prJson = expectedJson(seven);
    const ok = cli(rollupOf(seven), ['--once'], { prJson });
    expect(ok.stdout.split('\n')[0]).toBe('SETTLED head=4981cc5 checks=7 nonSUCCESS=0 missing=0 expected=7');
    expect(ok.status).toBe(0);
    // JS のソース (scripts/lib/ciWait.mjs) は読まない = テンプレート文字列内の見本や別名の export を取り違える余地が無い
    expect(ok.apiCalls).toEqual([`repos/{owner}/{repo}/contents/scripts/ci-expected-checks.json?ref=${FULL_HEAD}`]);
    // ローカル (6 件) では全部そろっていても、PR 側の 7 件目が無ければ settle しない
    const missing = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once'], { prJson });
    expect(missing.stdout.split('\n')[0]).toBe('PENDING head=4981cc5 checks=6 nonSUCCESS=0 missing=1 expected=7');
    expect(missing.stdout).toContain('added-required\tMISSING');
    expect(missing.status).toBe(2);
    // base が main 以外なら PR 側のファイルは読まない (積み上げ PR で contents API を叩かない)
    const stacked = cli(rollupOf(['test']), ['--once'], { baseRefName: 'feat/x', apiExit: 1 });
    expect(stacked.status).toBe(0);
    expect(stacked.apiCalls).toEqual([]);
  });

  it('PR の HEAD に JSON が無い (このファイルより前の main から分岐した PR) → ローカルで代用せず exit 3', () => {
    const r = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once'], { apiExit: 1 });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('scripts/ci-expected-checks.json を取得できません');
    expect(r.stderr).toContain('Not Found');
    expect(r.stderr).toContain('rebase');
  });

  it('PR 側の JSON の形が違う (配列でない・重複・空・JSON でない・余計なキー・正規形でない) → 部分採用せず exit 3', () => {
    const broken = [
      '{"checks": "audit"}\n',
      expectedJson([...EXPECTED_PR_CHECKS, 'audit']),
      expectedJson([]),
      'not json\n',
      `${JSON.stringify({ checks: [...EXPECTED_PR_CHECKS], extra: true }, null, 2)}\n`,
      `{\n  "checks": [\n    "audit"\n  ],\n  "checks": ${JSON.stringify([...EXPECTED_PR_CHECKS])}\n}\n`,
    ];
    for (const prJson of broken) {
      const r = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once'], { prJson });
      expect(r.status, prJson).toBe(3);
      expect(r.stdout, prJson).toBe('');
      expect(r.stderr, prJson).toContain('を期待集合として読めません');
    }
    // contents API の応答が file の base64 でない (大きすぎて content が無い等) も exit 3
    const noContent = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once'], { apiBody: { type: 'file', encoding: 'none', content: '' } });
    expect(noContent.status).toBe(3);
    expect(noContent.stderr).toContain('gh api 応答を読めません');
  });

  it('ローカルの JSON が壊れていると lib の import で止まり、exit 1 (失敗 check あり) と取り違えない exit 3', () => {
    dir = mkdtempSync(join(tmpdir(), 'ci-wait-local-'));
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'ci-wait.mjs'), readFileSync(SCRIPT, 'utf8'));
    writeFileSync(join(dir, 'scripts', 'lib', 'ciWait.mjs'), readFileSync(resolve('scripts/lib/ciWait.mjs'), 'utf8'));
    writeFileSync(join(dir, EXPECTED_CHECKS_PATH), '{"checks": []}\n');
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'ci-wait.mjs'), '773', '--once'], { encoding: 'utf8' });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('scripts/ci-expected-checks.json: checks が空です');
  });

  it('引数不正・gh 失敗は exit 3 のまま', () => {
    const bad = spawnSync(process.execPath, [SCRIPT, 'x'], { encoding: 'utf8' });
    expect(bad.status).toBe(3);
    const short = spawnSync(process.execPath, [SCRIPT, '773', '--head', 'abc'], { encoding: 'utf8' });
    expect(short.status).toBe(3);
    const gh = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once'], { ghExit: 1 });
    expect(gh.status).toBe(3);
    expect(gh.stderr).toContain('gh 失敗');
  });
});
