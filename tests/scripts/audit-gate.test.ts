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

type SpawnResult = ReturnType<typeof spawnSync>;

function spawnResult(stdout: string, status: number | null = 0, error?: Error, signal: NodeJS.Signals | null = null): SpawnResult {
  return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status, signal, error } as SpawnResult;
}

async function runGate(stdout: string, status: number | null = 0, error?: Error, signal: NodeJS.Signals | null = null, devStdout?: string) {
  vi.resetModules();
  const mock = vi.mocked(spawnSync);
  mock.mockReturnValue(spawnResult(stdout, status, error, signal));
  if (devStdout !== undefined) {
    // 1 回目 = 本番依存の gate (`--omit=dev`)、2 回目 = dev を含む参考集計。
    mock.mockReturnValueOnce(spawnResult(stdout, status, error, signal)).mockReturnValueOnce(spawnResult(devStdout, 1));
  }
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

  // 第 7 回レビュー E21: url の無い advisory object を黙って捨てると、severity が high でも
  // accepted にも unaccepted にも数えられず CI が通る。集計できない advisory は fail にする。
  it.each(['moderate', 'high', 'critical'])('fails closed for a %s advisory object without a URL instead of dropping it', async (severity) => {
    const report = {
      ...cleanReport,
      vulnerabilities: {
        fixture: { severity, via: [{ name: 'fixture', title: 'advisory without url', severity }] },
      },
    };
    const result = await runGate(JSON.stringify(report), 1);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('without an advisory URL');
    expect(result.stdout).toContain('fixture');
    expect(result.stdout).not.toContain('audit-gate: OK');
  });

  it('still ignores a LOW advisory object without a URL (LOW is outside the gate)', async () => {
    const report = {
      ...cleanReport,
      vulnerabilities: { fixture: { severity: 'low', via: [{ name: 'fixture', title: 'low without url', severity: 'low' }] } },
    };
    const result = await runGate(JSON.stringify(report), 1);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('audit-gate: OK');
  });

  it.each([
    ['empty via', { severity: 'high', via: [] }],
    ['missing via', { severity: 'high' }],
    ['non-array via', { severity: 'high', via: 'postcss' }],
  ])('fails closed for a gated package whose advisories cannot be collected (%s)', async (_name, entry) => {
    const report = { ...cleanReport, vulnerabilities: { fixture: entry } };
    const result = await runGate(JSON.stringify(report), 1);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('could not be collected');
    expect(result.stdout).toContain('fixture');
    expect(result.stdout).not.toContain('audit-gate: OK');
  });

  it('keeps accepting a gated package reached only through other vulnerable packages (string via)', async () => {
    const report = {
      ...cleanReport,
      vulnerabilities: {
        postcss: { severity: 'moderate', via: [{ name: 'postcss', title: 'fixture', severity: 'moderate', url: 'https://github.com/advisories/GHSA-qx2v-qp2m-jg93' }] },
        indirect: { severity: 'moderate', via: ['postcss'] },
      },
    };
    const result = await runGate(JSON.stringify(report), 1);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('audit-gate: OK');
  });

  // E21 (dev scope): 本番依存の gate (`--omit=dev`) は変えず、dev 依存だけに出る MODERATE+ を参考として
  // 可視化する (docs/DEPLOY_CHECKLIST.md §7.11 の裁定対象)。gate の判定には影響しない。
  describe('dev-scope report', () => {
    const devOnly = {
      ...cleanReport,
      vulnerabilities: {
        vitest: { severity: 'critical', via: [{ name: 'vitest', title: 'dev only fixture', severity: 'critical', url: 'https://github.com/advisories/GHSA-dev-only-fixture' }] },
      },
    };

    it('runs a second audit including devDependencies and lists dev-only advisories without failing', async () => {
      const result = await runGate(JSON.stringify(cleanReport), 0, undefined, null, JSON.stringify(devOnly));
      expect(spawnSync).toHaveBeenNthCalledWith(1, 'npm', ['audit', '--omit=dev', '--json'], expect.any(Object));
      expect(spawnSync).toHaveBeenNthCalledWith(2, 'npm', ['audit', '--json'], expect.any(Object));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Dev-scope');
      expect(result.stdout).toContain('GHSA-dev-only-fixture');
      expect(result.stdout).toContain('§7.11');
      expect(result.stdout).toContain('audit-gate: OK');
    });

    it('does not repeat production advisories in the dev-scope report', async () => {
      const prod = {
        ...cleanReport,
        vulnerabilities: {
          postcss: { severity: 'moderate', via: [{ name: 'postcss', title: 'fixture', severity: 'moderate', url: 'https://github.com/advisories/GHSA-qx2v-qp2m-jg93' }] },
        },
      };
      const full = { ...prod, vulnerabilities: { ...prod.vulnerabilities, ...devOnly.vulnerabilities } };
      const result = await runGate(JSON.stringify(prod), 1, undefined, null, JSON.stringify(full));
      expect(result.status).toBe(0);
      const devSection = result.stdout.slice(result.stdout.indexOf('Dev-scope'));
      expect(devSection).toContain('GHSA-dev-only-fixture');
      expect(devSection).not.toContain('GHSA-qx2v-qp2m-jg93');
    });

    it.each(['', '{truncated', JSON.stringify({ error: { code: 'E429' } })])('keeps the production verdict when the dev-scope audit is unusable (%j)', async (devStdout) => {
      const result = await runGate(JSON.stringify(cleanReport), 0, undefined, null, devStdout);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('dev-scope');
      expect(result.stdout).toContain('audit-gate: OK');
    });

    it('does not run the dev-scope audit when the production gate already failed', async () => {
      const report = {
        ...cleanReport,
        vulnerabilities: {
          fixture: { severity: 'high', via: [{ name: 'fixture', title: 'new', severity: 'high', url: 'https://github.com/advisories/GHSA-new-unaccepted' }] },
        },
      };
      const result = await runGate(JSON.stringify(report), 1, undefined, null, JSON.stringify(devOnly));
      expect(result.status).toBe(1);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    });
  });
});
