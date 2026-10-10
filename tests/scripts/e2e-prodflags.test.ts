// @vitest-environment node
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');

// Collect flags from README lines by their production declaration. ON wording (live on mainnet / live in
// production / production sets …) is kept apart from OFF wording (production sets `0` / off in production /
// off on mainnet): a bare `production sets` match counted "production sets `0`" as ON (found when the
// register standard-payment fee was abolished on 2026-10-07).
const ON_DECLARATION = /live on mainnet|live in production|production sets (?!(?:`[A-Z0-9_]+` to )?`0`)/i;
const OFF_DECLARATION = /production sets? (?:`[A-Z0-9_]+` to )?`0`|off in production|off on mainnet/i;
const flagsDeclared = (readme: string, declaration: RegExp) =>
  [
    ...new Set(
      readme
        .split('\n')
        .filter((line) => declaration.test(line))
        .flatMap((line) => line.match(/NEXT_PUBLIC_ENABLE_[A-Z0-9_]+/g) ?? []),
    ),
  ].sort();

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
    const specs = job!.indexOf('npx --no playwright test --config=playwright.prodflags.config.ts');
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
    const expectedFlags = flagsDeclared(read('README.md'), ON_DECLARATION);
    const enabledFlags = Object.keys(vector).filter((key) => key.startsWith('NEXT_PUBLIC_ENABLE_')).sort();
    // README can lag the user-confirmed production vector; require a superset.
    expect(enabledFlags).toEqual(expect.arrayContaining(expectedFlags));
    for (const key of enabledFlags) expect(vector[key]).toBe('1');
    expect(vector.NEXT_PUBLIC_NETWORK_ENV).toBe('testnet');
    expect(vector.NEXT_PUBLIC_RECOVER_FEE_BPS).toBe('100');
    expect(vector.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC).toBe('2');
    expect(vector.NEXT_PUBLIC_JPYC_FORWARDER_AMOY).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('keeps flags the README declares OFF in production out of the vector', () => {
    // Reverse fence: building a production-OFF flag (e.g. the register fee abolished on 2026-10-07) with '1'
    // would pin UI that production no longer renders (such as the abolished fee row) as the production shape.
    const readme = read('README.md');
    const offFlags = flagsDeclared(readme, OFF_DECLARATION);
    expect(offFlags, 'the README states at least one production-OFF flag').toContain('NEXT_PUBLIC_ENABLE_REGISTER_FEE');
    // A flag declared both ON and OFF is ambiguous: fix the README wording rather than guess.
    const onFlags = flagsDeclared(readme, ON_DECLARATION);
    expect(offFlags.filter((flag) => onFlags.includes(flag))).toEqual([]);
    const vector = parseEnv(read('e2e/prodFlags.env'));
    for (const flag of offFlags) expect(vector[flag], `${flag} is OFF in production`).toBeUndefined();
  });

  it('separates ON declarations from OFF ones in the README wording', () => {
    const on = (line: string) => ON_DECLARATION.test(line);
    const off = (line: string) => OFF_DECLARATION.test(line);
    expect(on('**Live on mainnet** (production sets `1`); code default **off**.')).toBe(true);
    expect(on('**live in production** (production sets the flag + VAPID keys)')).toBe(true);
    expect(on('**Off on mainnet since 2026-10-07** (that fee was abolished; production sets `0`)')).toBe(false);
    expect(off('**Off on mainnet since 2026-10-07** (that fee was abolished; production sets `0`)')).toBe(true);
    expect(off('(flag-gated; off in production since 2026-10-07)')).toBe(true);
    expect(off('production set `NEXT_PUBLIC_ENABLE_REGISTER_FEE` to `0`')).toBe(true);
    // 現在形 + 変数名 + to の OFF 宣言も ON に数えない (Codex #770 P3)
    expect(on('production sets `NEXT_PUBLIC_ENABLE_REGISTER_FEE` to `0`')).toBe(false);
    expect(off('production sets `NEXT_PUBLIC_ENABLE_REGISTER_FEE` to `0`')).toBe(true);
    expect(on('production sets `NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET` to `1`')).toBe(true);
    expect(off('**Live on mainnet** (production sets `1`); code default **off**.')).toBe(false);
  });

  it('uses unquoted single-line values so GITHUB_ENV and parseEnv agree', () => {
    for (const line of read('e2e/prodFlags.env').split('\n')) {
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      expect(line).toMatch(/^[A-Z0-9_]+=[^\s"'#]*$/);
    }
  });
});
