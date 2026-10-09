// @vitest-environment node
// scripts/ci-wait.mjs (merge の唯一の判定) の「期待する check 名の集合」フェンス (第 7 回レビュー E8)。
//
// 以前は「出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED」で exit 0 だったので、e2e / lighthouse の
// workflow run がまだ check として現れていない瞬間や、必須 job が skip された場合も緑扱いになりえた。
// ここでは (1) 定数 EXPECTED_PR_CHECKS が今の workflow から解析した集合と一致すること (ドリフト検出)・
// 解析できない形が PR trigger の workflow に現れたら落ちること (fail-closed) (2) 欠けた check は settle
// しないこと (3) 期待 check は SUCCESS のみ合格であること (4) base が main 以外では期待集合を使わないこと
// (5) --head は完全 OID で比較することを固定する。
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPECTED_PR_CHECKS,
  analyzeWorkflows,
  evaluateChecks,
  expectedChecksFor,
  normalizeRollup,
  parseWorkflow,
} from '../../scripts/lib/ciWait.mjs';

const SCRIPT = resolve('scripts/ci-wait.mjs');
const WORKFLOWS = resolve('.github/workflows');
const FULL_HEAD = '4981cc5deadbeef0000000000000000000000000';

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

describe('期待 check 集合の定数と workflow のドリフト検出 (fail-closed)', () => {
  it('EXPECTED_PR_CHECKS は今の .github/workflows から解析した「main 向け PR で必ず走る job」と一致する', () => {
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

  it('on の形: string / 配列 / map / map の値が null・{} / quote 付きの on / block 配列 / flow map を読む', () => {
    expect(parseWorkflow(`on: pull_request\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on: push\n${JOB}`).pullRequest).toBe(false);
    expect(parseWorkflow(`on: [push, pull_request]\n${JOB}`).pullRequest).toBe(true);
    expect(parseWorkflow(`on: [push]\n${JOB}`).pullRequest).toBe(false);
    expect(parseWorkflow(`"on": pull_request\n${JOB}`).pullRequest).toBe(true);
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
    ]) {
      expect(parseWorkflow(src).unsupported, src).toEqual([]);
    }
  });

  it('paths / paths-ignore / types は block でも flow map でも filtered に出す', () => {
    expect(parseWorkflow(`on:\n  pull_request:\n    paths:\n      - "docs/**"\n${JOB}`).filtered).toBe('paths');
    expect(parseWorkflow(`on:\n  pull_request:\n    paths-ignore: ["**.md"]\n${JOB}`).filtered).toBe('paths-ignore');
    expect(parseWorkflow(`on:\n  pull_request:\n    types: [labeled]\n${JOB}`).filtered).toBe('types');
    expect(parseWorkflow(`on:\n  pull_request: {paths: ["docs/**"]}\n${JOB}`).filtered).toBe('paths');
    expect(parseWorkflow(`on: {pull_request: {paths: [docs/**], branches: [main]}}\n${JOB}`).filtered).toBe('paths');
    expect(parseWorkflow(`on:\n  pull_request:\n    branches: [main]\n${JOB}`).filtered).toBeNull();
  });

  it('branches は main を含むときだけ main 向け PR の check に数える (block list / flow list / branches-ignore)', () => {
    expect(parseWorkflow(`on:\n  pull_request:\n    branches: [main]\n${JOB}`).branches).toEqual(['main']);
    expect(parseWorkflow(`on:\n  pull_request:\n    branches:\n      - main\n      - release\n${JOB}`).branches).toEqual(['main', 'release']);
    expect(parseWorkflow(`on:\n  pull_request:\n    branches-ignore: [main]\n${JOB}`).branchesIgnore).toEqual(['main']);
    const glob = parseWorkflow(`on:\n  pull_request:\n    branches: ["release/**"]\n${JOB}`);
    expect(glob.unsupported.join()).toContain('glob');
    const dir = mkdtempSync(join(tmpdir(), 'ci-wait-branches-'));
    try {
      writeFileSync(join(dir, 'release.yml'), `on:\n  pull_request:\n    branches: [release]\njobs:\n  rel:\n    runs-on: x\n`);
      writeFileSync(join(dir, 'ignore.yml'), `on:\n  pull_request:\n    branches-ignore: [main]\njobs:\n  ign:\n    runs-on: x\n`);
      writeFileSync(join(dir, 'main.yml'), `on:\n  pull_request:\n    branches: [main]\njobs:\n  ok:\n    runs-on: x\n`);
      const r = analyzeWorkflows(dir);
      expect(r.unsupported).toEqual([]);
      expect(r.required).toEqual(['ok']);
      expect(r.excluded).toEqual([
        { workflow: 'ignore.yml', reason: 'pull_request branches-ignore has main' },
        { workflow: 'release.yml', reason: 'pull_request branches exclude main' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('job の check 名は name: があればそれ (quote 内の # も含む)、無ければ job id', () => {
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

  it('解析できない形 (式や複数行の name・matrix・if・reusable workflow・条件付き親への needs・重複名・未対応の on) は unsupported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-wait-unsupported-'));
    try {
      writeFileSync(join(dir, 'a.yml'), [
        'on: pull_request',
        'jobs:',
        '  expr:',
        '    name: Build ${{ matrix.os }}',
        '    runs-on: x',
        '  multi:',
        '    name: >-',
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
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'b.yml'), 'on: pull_request\njobs:\n  plain:\n    runs-on: x\n');
      writeFileSync(join(dir, 'c.yml'), 'on: !!binary abc\njobs:\n  c:\n    runs-on: x\n');
      writeFileSync(join(dir, 'd.yml'), 'on:\n  pull_request:\n    branches: main\njobs:\n  d:\n    runs-on: x\n');
      const r = analyzeWorkflows(dir);
      expect(r.required).toEqual(['fine', 'plain']);
      const reasons = r.unsupported.map((u) => `${u.workflow}:${u.job ?? ''}:${u.reason}`);
      expect(reasons).toEqual([
        'a.yml:expr:job has expression in name',
        'a.yml:multi:job has block scalar or empty name',
        'a.yml:matrix:job has strategy:',
        'a.yml:gated:job has if:',
        'a.yml:child:needs gated (unknown or conditional)',
        'a.yml:orphan:needs nobody (unknown or conditional)',
        'a.yml:reusable:job has uses:',
        'b.yml:plain:duplicate check name plain (also a.yml)',
        'c.yml::on: unreadable value (!!binary abc)',
        'd.yml::on.pull_request.branches: unreadable list',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  function cli(
    rollup: unknown[],
    args: string[],
    { headRefOid = FULL_HEAD, baseRefName = 'main', ghExit = 0, gitResolves = null as string | null } = {},
  ) {
    dir = mkdtempSync(join(tmpdir(), 'ci-wait-cli-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fixture = join(dir, 'pr.json');
    writeFileSync(fixture, JSON.stringify({ headRefOid, baseRefName, statusCheckRollup: rollup }));
    // 本物の gh の代わり: 固定 JSON を返す
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ "${ghExit}" != "0" ]; then echo "fake gh failure" >&2; exit ${ghExit}; fi\ncat "${fixture}"\n`);
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
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
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
