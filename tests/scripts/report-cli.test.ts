// @vitest-environment node
// Baselines captured on dc4ee616338694145ce10405e0ce95be19617557 before R8 extraction.
// 期待値 (tests/fixtures/report-cli/*.json) は R8 の抽出前に旧 script で取得した。出力を意図して変える
// PR (B-R8 の通信方針の統一など) だけが、その差分を説明したうえで fixture の期待値を手で更新する。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Reply = {
  command: (string | number)[];
  body?: unknown;
  raw?: string;
  status?: number;
  throw?: { name: string; message: string };
};
type Fixture = {
  name: string;
  script: string;
  args: string[];
  replies: Reply[];
  env?: Record<string, string>;
  stdout: string;
  stderr: string;
  status: number;
};
const root = resolve('.');
const preload = resolve('tests/fixtures/report-cli/preload.mjs');
const reportEnv = {
  KV_REST_API_URL: 'https://report.example.test',
  KV_REST_API_TOKEN: 'REPORT_FIXTURE_TOKEN',
  KV_BACKUP_REST_URL: 'https://backup.example.test',
  KV_BACKUP_REST_TOKEN: 'BACKUP_FIXTURE_TOKEN',
};

function run(fixture: Fixture) {
  const env = { ...reportEnv, ...fixture.env };
  const result = spawnSync(process.execPath, ['--import', preload, resolve('scripts', fixture.script), ...fixture.args], {
    // Deliberately outside the repo root; no temporary files or real operational credentials.
    cwd: resolve(root, 'tests/fixtures'),
    env: { PATH: process.env.PATH, TZ: 'UTC', NODE_ENV: 'test', ...env },
    input: JSON.stringify(fixture), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe(fixture.stdout);
  expect(result.stderr).toBe(fixture.stderr);
  expect(result.status).toBe(fixture.status);
  // Pin URL, credentials, exact headers and JSON request bytes (including key/argument order).
  // No encoding header, timeout signal, redirect override, URL normalization or backup fallback.
  const trace = String(result.output[3] ?? '').trim();
  expect(trace ? trace.split('\n').map((line) => JSON.parse(line)) : []).toEqual(fixture.replies.map((reply) => ({
    url: env.KV_REST_API_URL,
    method: 'POST',
    headers: { Authorization: `Bearer ${env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(reply.command),
  })));
}

for (const kind of ['metrics', 'ledger', 'funnel', 'northstar']) {
  const fixtures: Fixture[] = JSON.parse(readFileSync(resolve('tests/fixtures/report-cli', `${kind}.json`), 'utf8'));
  describe(`${kind} report CLI: stdout/stderr/exit and wire fixtures`, () => {
    it.each(fixtures)('$name', run);
  });
}

describe('funnel day arguments retain existing coercion and clamping', () => {
  it.each([
    ['0', 1, 1], ['-5', 1, 1], ['', 1, 1], ['1.5', 1.5, 2],
    ['181', 180, 180], ['Infinity', 180, 180], ['-Infinity', 1, 1],
  ] as const)('%j displays %s days and reads %s dates', (argument, displayed, count) => {
    run({ name: '', script: 'x402-funnel-report.mjs', args: [argument],
      replies: Array.from({ length: count }, (_, i) => ({
        command: ['HGETALL', `x402:funnel:${new Date(Date.UTC(2026, 8, 30) - i * 86_400_000).toISOString().slice(0, 10)}`],
        body: { result: [] },
      })),
      stdout: `x402 funnel — 直近 ${displayed} 日 (UTC)\n\n[支払い前] resource: 402 発行 / 形不正\n\n[支払い後] resource | rail: 成立 / 試行 (成立率) — 内訳\n  (記録なし — 計上開始前か KV 未構成)\n`,
      stderr: '', status: 0,
    });
  });
});

describe('report credentials and existing failure policy (B-R8 remains separate)', () => {
  for (const script of ['metrics-report.mjs', 'settle-ledger-report.mjs', 'x402-funnel-report.mjs', 'agent-north-star-report.mjs']) {
    const args = script === 'x402-funnel-report.mjs' ? ['1'] : ['2026-09'];
    const command = script === 'metrics-report.mjs'
      ? ['MGET', 'metrics:2026-09:relay_jpyc', 'metrics:2026-09:x402_settle', 'metrics:2026-09:order', 'metrics:2026-09:store_purchase']
      : script === 'settle-ledger-report.mjs' || script === 'agent-north-star-report.mjs'
        ? ['LRANGE', 'x402:settle:ledger:2026-09', '0', '-1']
        : ['HGETALL', 'x402:funnel:2026-09-30'];

    it.each<Record<string, string>>([
      { KV_REST_API_URL: '' }, { KV_REST_API_TOKEN: '' }, { KV_REST_API_URL: '', KV_REST_API_TOKEN: '' },
    ])(`${script}: missing report credentials never select backup credentials (%j)`, (env) => {
      run({ name: '', script, args, env, replies: [], stdout: '', status: 1,
        stderr: `KV_REST_API_URL / KV_REST_API_TOKEN を export してください${script === 'x402-funnel-report.mjs' ? '' : ' (ヘッダーコメント参照)'}\n` });
    });

    it.each([401, 413, 503])(`${script}: HTTP %i retains response text`, (status) => {
      run({ name: '', script, args, replies: [{ command, status, raw: 'fixture failure detail' }],
        stdout: '', stderr: `Error: KV ${status}: fixture failure detail\n`, status: 1 });
    });

    it.each(['Error', 'AbortError', 'TimeoutError'])(`${script}: network %s is not reclassified`, (name) => {
      run({ name: '', script, args, replies: [{ command, throw: { name, message: 'fixture network detail' } }],
        stdout: '', stderr: `${name}: fixture network detail\n`, status: 1 });
    });

    it(`${script}: JSON parse failure remains an uncaught error`, () => {
      run({ name: '', script, args, replies: [{ command, raw: '' }],
        stdout: '', stderr: 'SyntaxError: Unexpected end of JSON input\n', status: 1 });
    });
  }
});
