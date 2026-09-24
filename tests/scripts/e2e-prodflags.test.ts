// @vitest-environment node
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');

describe('production-flag Playwright coverage (F13)', () => {
  it('builds and tests a second CI job that fails on production-flag regressions', () => {
    const workflow = read('.github/workflows/e2e.yml');
    const job = workflow.match(/^  e2e-prodflags:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1];
    expect(job, 'F13: the flags-OFF job alone cannot cover relay/recover').toBeDefined();
    expect(job).not.toContain('continue-on-error:');
    expect(job).toContain('playwright install --with-deps chromium\n');
    expect(job).not.toContain('webkit');
    const vector = job!.indexOf('e2e/prodFlags.env');
    const exportEnv = job!.indexOf('"$GITHUB_ENV"');
    const build = job!.indexOf('run: npm run build');
    const specs = job!.indexOf('npx playwright test --config=playwright.prodflags.config.ts');
    expect(vector).toBeGreaterThan(-1);
    expect(exportEnv).toBeGreaterThan(vector);
    expect(build).toBeGreaterThan(exportEnv);
    expect(specs).toBeGreaterThan(build);
    expect(job).not.toMatch(/secrets\.|NEXT_PUBLIC_\w+:/);
    expect(job).toContain('name: playwright-prodflags-report');
    expect(job).toContain('path: playwright-prodflags-report/');
  });

  it('pins only documented public production flags, with testnet fixture configuration', () => {
    const vector = parseEnv(read('e2e/prodFlags.env'));
    const example = read('.env.local.example');
    for (const key of Object.keys(vector)) {
      expect(key).toMatch(/^NEXT_PUBLIC_/);
      expect(example).toMatch(new RegExp(`^${key}=`, 'm'));
    }
    // Both the curated env table and feature prose document production light-up.
    const liveFlags = read('README.md').split('\n')
      .filter((line) => /live on mainnet|live in production|production sets/i.test(line))
      .flatMap((line) => line.match(/NEXT_PUBLIC_ENABLE_[A-Z0-9_]+/g) ?? []);
    const expectedFlags = [...new Set(liveFlags)].sort();
    const enabledFlags = Object.keys(vector).filter((key) => key.startsWith('NEXT_PUBLIC_ENABLE_')).sort();
    // README can lag the user-confirmed production vector; require a superset.
    expect(enabledFlags).toEqual(expect.arrayContaining(expectedFlags));
    for (const key of enabledFlags) expect(vector[key]).toBe('1');
    expect(vector.NEXT_PUBLIC_NETWORK_ENV).toBe('testnet');
    expect(vector.NEXT_PUBLIC_RECOVER_FEE_BPS).toBe('100');
    expect(vector.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC).toBe('2');
    expect(vector.NEXT_PUBLIC_JPYC_FORWARDER_AMOY).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('uses unquoted single-line values so GITHUB_ENV and parseEnv agree', () => {
    for (const line of read('e2e/prodFlags.env').split('\n')) {
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      expect(line).toMatch(/^[A-Z0-9_]+=[^\s"'#]*$/);
    }
  });
});
