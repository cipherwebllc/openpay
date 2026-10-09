// @vitest-environment node
// scripts/ci-wait.mjs (merge の唯一の判定) の「期待する check 名の集合」フェンス (第 7 回レビュー E8)。
//
// 以前は「出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED」で exit 0 だったので、e2e / lighthouse の
// workflow run がまだ check として現れていない瞬間や、必須 job が skip された場合も緑扱いになりえた。
// ここでは (1) 期待集合が workflow ファイルから正しく導出されること (2) 欠けた check は settle しないこと
// (3) 期待 check は SUCCESS のみ合格であること (4) --head の不一致は exit 3 であることを固定する。
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateChecks, expectedPrChecks, normalizeRollup, parseWorkflow } from '../../scripts/lib/ciWait.mjs';

const SCRIPT = resolve('scripts/ci-wait.mjs');
const WORKFLOWS = resolve('.github/workflows');

// 今の .github/workflows で PR に必ず走る check 名。job を足した / 外した PR はここも更新する (ドリフト検出)。
const EXPECTED_PR_CHECKS = ['audit', 'e2e-prodflags', 'lighthouse', 'lua-real', 'playwright', 'test'];

function run(name: string, status: string, conclusion: string) {
  return { __typename: 'CheckRun', name, status, conclusion, context: null, state: null };
}
const VERCEL_ENTRIES = [
  { __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS', name: null, status: null, conclusion: null },
  run('Vercel Preview Comments', 'COMPLETED', 'SUCCESS'),
];
function rollupOf(names: string[], overrides: Record<string, { status?: string; conclusion?: string }> = {}) {
  return [
    ...names.map((n) => run(n, overrides[n]?.status ?? 'COMPLETED', overrides[n]?.conclusion ?? 'SUCCESS')),
    ...VERCEL_ENTRIES,
  ];
}

describe('期待 check 集合の導出 (workflow ファイルが単一の真実)', () => {
  it('今の workflow から PR で必ず走る check 名を導出し、PR trigger の無い workflow は理由付きで除外する', () => {
    const { expected, excluded } = expectedPrChecks(WORKFLOWS);
    expect([...expected].sort()).toEqual(EXPECTED_PR_CHECKS);
    const excludedWorkflows = excluded.map((e) => e.workflow).sort();
    expect(excludedWorkflows).toEqual([
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

  it('inline の on: [push, pull_request] と block 形式の両方を PR trigger として読む', () => {
    expect(parseWorkflow('on: [push, pull_request]\njobs:\n  a:\n    runs-on: x\n').pullRequest).toBe(true);
    expect(parseWorkflow('on: pull_request\njobs:\n  a:\n    runs-on: x\n').pullRequest).toBe(true);
    expect(parseWorkflow('on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  a:\n    runs-on: x\n').pullRequest).toBe(true);
    expect(parseWorkflow('on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  a:\n    runs-on: x\n').pullRequest).toBe(false);
    // pull_request_target は別イベント (PR の head では走らない) なので PR trigger と数えない
    expect(parseWorkflow('on:\n  pull_request_target:\njobs:\n  a:\n    runs-on: x\n').pullRequest).toBe(false);
  });

  it('paths / paths-ignore / types で走らない可能性のある pull_request trigger は除外条件として明示する', () => {
    const paths = parseWorkflow('on:\n  pull_request:\n    paths:\n      - "docs/**"\njobs:\n  a:\n    runs-on: x\n');
    expect(paths.pullRequest).toBe(true);
    expect(paths.filtered).toBe('paths');
    const ignore = parseWorkflow('on:\n  pull_request:\n    paths-ignore: ["**.md"]\njobs:\n  a:\n    runs-on: x\n');
    expect(ignore.filtered).toBe('paths-ignore');
    const types = parseWorkflow('on:\n  pull_request:\n    types: [labeled]\njobs:\n  a:\n    runs-on: x\n');
    expect(types.filtered).toBe('types');
    const branches = parseWorkflow('on:\n  pull_request:\n    branches: [main]\njobs:\n  a:\n    runs-on: x\n');
    expect(branches.filtered).toBeNull();
  });

  it('job の check 名は name: があればそれ、無ければ job id。if: / strategy: の job は条件付きとして除外する', () => {
    const wf = parseWorkflow([
      'name: X',
      'on:',
      '  pull_request:',
      'jobs:',
      '  plain:',
      '    runs-on: ubuntu-latest',
      '  named:',
      '    name: "Pretty Name"',
      '    runs-on: ubuntu-latest',
      '  gated:',
      "    if: github.event_name == 'push'",
      '    runs-on: ubuntu-latest',
      '  matrix:',
      '    strategy:',
      '      matrix:',
      '        node: [20, 22]',
      '    runs-on: ubuntu-latest',
      '',
    ].join('\n'));
    expect(wf.jobs).toEqual([
      { id: 'plain', name: 'plain', conditional: null },
      { id: 'named', name: 'Pretty Name', conditional: null },
      { id: 'gated', name: 'gated', conditional: 'if' },
      { id: 'matrix', name: 'matrix', conditional: 'strategy' },
    ]);
  });

  it('コメント行・末尾コメントは読み飛ばす', () => {
    const wf = parseWorkflow('# top\non:\n  # c\n  pull_request: # trailing\njobs:\n  a: # job\n    runs-on: x\n');
    expect(wf.pullRequest).toBe(true);
    expect(wf.jobs).toEqual([{ id: 'a', name: 'a', conditional: null }]);
  });

  it('導出した集合が空なら呼び出し側へ知らせる (silently 全部 pass にしない)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-wait-empty-'));
    try {
      writeFileSync(join(dir, 'cron.yml'), 'on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  a:\n    runs-on: x\n');
      const { expected, excluded } = expectedPrChecks(dir);
      expect(expected).toEqual([]);
      expect(excluded).toEqual([{ workflow: 'cron.yml', reason: 'no pull_request trigger' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('判定 (evaluateChecks)', () => {
  const expected = EXPECTED_PR_CHECKS;

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

describe('CLI (gh を偽物に差し替えて end-to-end)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function cli(rollup: unknown[], args: string[], headRefOid = '4981cc5deadbeef0000000000000000000000000', ghExit = 0) {
    dir = mkdtempSync(join(tmpdir(), 'ci-wait-cli-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fixture = join(dir, 'pr.json');
    writeFileSync(fixture, JSON.stringify({ headRefOid, statusCheckRollup: rollup }));
    // 本物の gh の代わり: 引数を記録して固定 JSON を返す
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, 'gh.args')}"\nif [ "${ghExit}" != "0" ]; then echo "fake gh failure" >&2; exit ${ghExit}; fi\ncat "${fixture}"\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const res = spawnSync(process.execPath, [SCRIPT, '773', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it('期待 check が全部 SUCCESS → SETTLED nonSUCCESS=0 missing=0 で exit 0 (既存の出力形式を保つ)', () => {
    const r = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once']);
    expect(r.stderr).toBe('');
    expect(r.stdout.split('\n')[0]).toBe('SETTLED head=4981cc5 checks=6 nonSUCCESS=0 missing=0');
    expect(r.stdout).toContain('lighthouse\tSUCCESS');
    expect(r.stdout).not.toMatch(/vercel/i);
    expect(r.status).toBe(0);
  });

  it('lighthouse の check がまだ無い (他は SUCCESS) → --once は PENDING missing=1 で exit 2・MISSING 行を出す', () => {
    const r = cli(rollupOf(EXPECTED_PR_CHECKS.filter((n) => n !== 'lighthouse')), ['--once']);
    expect(r.stdout.split('\n')[0]).toBe('PENDING head=4981cc5 checks=5 nonSUCCESS=0 missing=1');
    expect(r.stdout).toContain('lighthouse\tMISSING');
    expect(r.status).toBe(2);
  });

  it('期待 check が SKIPPED → SETTLED nonSUCCESS=1 で exit 1', () => {
    const r = cli(rollupOf(EXPECTED_PR_CHECKS, { 'e2e-prodflags': { conclusion: 'SKIPPED' } }), []);
    expect(r.stdout.split('\n')[0]).toBe('SETTLED head=4981cc5 checks=6 nonSUCCESS=1 missing=0');
    expect(r.stdout).toContain('e2e-prodflags\tSKIPPED');
    expect(r.status).toBe(1);
  });

  it('--head <sha> が PR の head と一致しなければ exit 3 (stale run を見ていた事故の前倒し)', () => {
    const ok = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once', '--head', '4981cc5']);
    expect(ok.status).toBe(0);
    const ng = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once', '--head', 'abc1234']);
    expect(ng.status).toBe(3);
    expect(ng.stderr).toContain('HEAD');
    expect(ng.stderr).toContain('abc1234');
    expect(ng.stderr).toContain('4981cc5');
  });

  it('引数不正・gh 失敗は exit 3 のまま', () => {
    const bad = spawnSync(process.execPath, [SCRIPT, 'x'], { encoding: 'utf8' });
    expect(bad.status).toBe(3);
    const gh = cli(rollupOf(EXPECTED_PR_CHECKS), ['--once'], '4981cc5', 1);
    expect(gh.status).toBe(3);
    expect(gh.stderr).toContain('gh 失敗');
  });
});
