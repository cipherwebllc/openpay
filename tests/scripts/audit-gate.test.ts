import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => {
  const spawnSync = vi.fn();
  return { spawnSync, default: { spawnSync } };
});

const cleanReport = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
};

async function runGate(stdout: string, status: number | null = 0, error?: Error, signal: NodeJS.Signals | null = null) {
  vi.resetModules();
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1, output: [null, stdout, ''], stdout, stderr: '', status, signal, error,
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exited = new Error('process.exit');
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
  try {
    await import('../../scripts/audit-gate.mjs');
  } catch (cause) {
    if (cause !== exited) throw cause;
  }
  expect(spawnSync).toHaveBeenCalledWith('npm', ['audit', '--omit=dev', '--json'], expect.any(Object));
  return {
    status: exit.mock.calls[0]?.[0] ?? 0,
    stdout: log.mock.calls.flat().join('\n'),
    stderr: stderr.mock.calls.flat().join('\n'),
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('audit-gate', () => {
  it.each([0, 1])('accepts a valid empty audit report with exit %s', async (status) => {
    const result = await runGate(JSON.stringify(cleanReport), status);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('audit-gate: OK');
  });

  it.each([
    ['endpoint error', { message: 'audit endpoint unavailable', error: { code: 'ECONNREFUSED' } }],
    ['error alongside report', { ...cleanReport, error: { code: 'E429' } }],
    ['missing report', {}],
    ['null report', null],
    ['array report', []],
    ['missing metadata', { vulnerabilities: {} }],
    ['invalid counts', { ...cleanReport, metadata: { vulnerabilities: null } }],
    ['missing vulnerabilities', { metadata: cleanReport.metadata }],
    ['null vulnerabilities', { ...cleanReport, vulnerabilities: null }],
    ['array vulnerabilities', { ...cleanReport, vulnerabilities: [] }],
  ])('fails closed for %s', async (_name, report) => {
    const result = await runGate(JSON.stringify(report), 1);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/audit-gate:.*(error|invalid|failed)/i);
    expect(result.stdout).not.toContain('audit-gate: OK');
    expect(result.stdout).not.toContain('Stale allowlist');
  });

  it.each(['', '<html>Bad gateway</html>', '{truncated'])('reports a clear parse failure for %j', async (stdout) => {
    const result = await runGate(stdout, 1);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/audit-gate:.*(stdout|JSON)/);
    expect(result.stdout).not.toContain('audit-gate: OK');
  });

  it.each([
    [2, undefined, null],
    [null, new Error('spawn npm ENOENT'), null],
    [null, undefined, 'SIGTERM'],
  ] as const)('rejects a failed npm process even with valid stdout (%s, %s, %s)', async (status, error, signal) => {
    const result = await runGate(JSON.stringify(cleanReport), status, error, signal);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/audit-gate:.*failed/i);
    expect(result.stdout).not.toContain('audit-gate: OK');
  });

  it.each([
    ['GHSA-qx2v-qp2m-jg93', 'moderate', 0],
    ['GHSA-new-unaccepted', 'moderate', 1],
    ['GHSA-new-unaccepted', 'high', 1],
    ['GHSA-new-unaccepted', 'critical', 1],
    ['GHSA-new-unaccepted', 'low', 0],
  ])('preserves advisory policy for %s (%s)', async (id, severity, expectedStatus) => {
    const report = {
      ...cleanReport,
      vulnerabilities: {
        postcss: { severity, via: [{ name: 'postcss', title: 'fixture', severity, url: `https://github.com/advisories/${id}` }] },
        indirect: { severity, via: ['postcss'] },
      },
    };
    const result = await runGate(JSON.stringify(report), 1);
    expect(result.status).toBe(expectedStatus);
    expect(result.stdout).toContain(expectedStatus === 0 ? 'audit-gate: OK' : 'UNACCEPTED');
  });
});
