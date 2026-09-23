// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/license-amoy-e2e.mjs');
interface ReportModule {
  reportPath(args: string[], env: Record<string, string>): string;
  resultLabel(steps: { status: string }[], allowSkips: boolean): string;
}
async function reporting(): Promise<ReportModule> {
  // Before the import guard exists, argv would run the live driver: require the guard first.
  expect(await readFile(script, 'utf8')).toContain('import.meta.url === pathToFileURL');
  return await import(pathToFileURL(script).href) as ReportModule;
}

describe('Amoy operator reporting', () => {
  it('defaults to a portable temporary path and accepts CLI/env report paths', async () => {
    const { reportPath } = await reporting();
    expect(reportPath([], {}).startsWith(tmpdir() + '/')).toBe(true);
    expect(reportPath([], {})).not.toContain('/claude-501/');
    expect(reportPath(['--report', join(tmpdir(), 'chosen.json')], { E2E_REPORT: 'other.json' })).toBe(join(tmpdir(), 'chosen.json'));
    expect(reportPath([], { E2E_REPORT: 'chosen.json' })).toBe(resolve('chosen.json'));
    expect(() => reportPath(['--report'], {})).toThrow();
  });
  it('distinguishes allowed skips from a complete pass without changing the exit policy', async () => {
    const { resultLabel } = await reporting();
    expect(resultLabel([{ status: 'OK' }], true)).toBe('PASS');
    expect(resultLabel([{ status: 'OK' }, { status: 'SKIP' }], true)).toBe('PASS WITH SKIPS');
    expect(resultLabel([{ status: 'SKIP' }], false)).toBe('FAIL');
    expect(resultLabel([{ status: 'FAIL' }], true)).toBe('FAIL');
  });
  it('rejects unavailable resume before setup and reports saved/failed report writes accurately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amoy-report-test-'));
    try {
      const path = join(dir, 'report.json');
      const r = spawnSync('node', [script, '--report', path], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH, E2E_RESUME_PRODUCT: 'h_' + '1'.repeat(32) }, encoding: 'utf8', timeout: 15_000,
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('Resume unavailable: this checkout has no /api/license/grants route');
      expect(r.stdout).toContain('Result: FAIL');
      const report = JSON.parse(await readFile(path, 'utf8'));
      expect(report).toMatchObject({ ok: false, result: 'FAIL', purchases: [], transactions: [] });
      expect(report.steps).toHaveLength(2); // Fatal gate plus reporting, no setup or payment steps.
      const failedWrite = spawnSync('node', [script, '--report', dir], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH, E2E_RESUME_PRODUCT: 'h_' + '1'.repeat(32) }, encoding: 'utf8', timeout: 15_000,
      });
      expect(failedWrite.status).toBe(1);
      expect(failedWrite.stdout).toContain('Result: FAIL');
      expect(failedWrite.stdout).toContain('JSON report: not saved (local I/O failure)');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('keeps the offline self-check independent of wallets, servers and report writes', () => {
    const r = spawnSync('node', [script, '--self-check'], { env: { NODE_ENV: 'test', PATH: process.env.PATH }, encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('offline fixtures');
  });
});
