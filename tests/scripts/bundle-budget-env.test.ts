// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetBuildEnv, publicFeatureFlagKeys, sourceTextsUnder } from '../../scripts/lib/bundleBudgetEnv.mjs';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

// check-bundle-budget --build の計測条件を CI (ci.yml は clean な runner で e2e/prodFlags.env だけを読む) と揃える。
// prodFlags.env は OFF の flag を載せないので、shell や .env.local に残った ON (例: 2026-10-07 に廃止した
// NEXT_PUBLIC_ENABLE_REGISTER_FEE=1) を明示の OFF で潰してからベクターを重ねる (Codex #789 P3)。
describe('bundle budget build env (--build)', () => {
  const root = process.cwd();
  const flagKeys = publicFeatureFlagKeys([read('.env.local.example'), ...sourceTextsUnder(root, ['lib', 'app', 'components', 'hooks'])]);

  it('enumerates every public feature flag from the documented example and lib/env.ts', () => {
    expect(flagKeys.length).toBeGreaterThanOrEqual(43);
    for (const key of flagKeys) expect(key).toMatch(/^NEXT_PUBLIC_[A-Z0-9_]+$/);
    expect(flagKeys).toEqual([...new Set(flagKeys)].sort());
    for (const key of [
      'NEXT_PUBLIC_ENABLE_REGISTER_FEE',
      'NEXT_PUBLIC_ENABLE_HANDLES',
      'NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET',
      'NEXT_PUBLIC_ENABLE_MAV2',
      'NEXT_PUBLIC_ENABLE_MOCK_WALLET',
    ]) expect(flagKeys).toContain(key);
  });

  // 接頭辞 NEXT_PUBLIC_ENABLE_ でない公開 boolean flag (lib/crossChain/config.ts が parseBoolFlag で読む) も
  // 列挙に入れる。接頭辞だけに頼ると親 env の 1 が build に残った (Codex #789 2 回目 P3)。
  it.each([
    'NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED',
    'NEXT_PUBLIC_CROSS_CHAIN_DISABLED',
    'NEXT_PUBLIC_CROSS_CHAIN_BURN_AUTORESUME',
  ])('includes the non-ENABLE boolean flag %s and turns a parent-shell 1 OFF', (key) => {
    expect(flagKeys).toContain(key);
    const env = budgetBuildEnv({ parentEnv: { [key]: '1' }, prodFlagsText: read('e2e/prodFlags.env'), flagKeys });
    expect(env[key]).toBe('0');
  });

  it('detects boolean flags by their parseBoolFlag read, not by key prefix, and leaves non-boolean keys alone', () => {
    const source = [
      'export const X: boolean = parseBoolFlag(',
      "  'NEXT_PUBLIC_FOO_DISABLED',",
      '  process.env.NEXT_PUBLIC_FOO_DISABLED,',
      ');',
      'export const Y = parseBoolFlag(process.env.NEXT_PUBLIC_BAR_AUTORESUME);',
      "const rpc = nonEmpty(process.env.NEXT_PUBLIC_BAZ_RPC_URL) ?? '';",
    ].join('\n');
    const keys = publicFeatureFlagKeys([source]);
    expect(keys).toEqual(['NEXT_PUBLIC_BAR_AUTORESUME', 'NEXT_PUBLIC_FOO_DISABLED']);
  });

  it('walks source directories for .ts/.tsx and skips test files', () => {
    const texts = sourceTextsUnder(root, ['lib/crossChain']);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((text) => text.includes('NEXT_PUBLIC_CROSS_CHAIN_DISABLED'))).toBe(true);
    expect(sourceTextsUnder(root, ['tests/scripts'])).toEqual([]);
  });

  it('turns parent-shell flags OFF, then applies the production vector on top', () => {
    const env = budgetBuildEnv({
      parentEnv: {
        PATH: '/usr/bin',
        NEXT_PUBLIC_NETWORK_ENV: 'mainnet',
        NEXT_PUBLIC_ENABLE_REGISTER_FEE: '1',
        NEXT_PUBLIC_ENABLE_MAV2: '1',
        NEXT_PUBLIC_ENABLE_HANDLES: '',
      },
      prodFlagsText: read('e2e/prodFlags.env'),
      flagKeys,
    });
    // 親 shell の ON は潰す (production OFF の flag)
    expect(env.NEXT_PUBLIC_ENABLE_REGISTER_FEE).toBe('0');
    expect(env.NEXT_PUBLIC_ENABLE_MAV2).toBe('0');
    // ベクターの ON は親 shell の値より優先する
    expect(env.NEXT_PUBLIC_ENABLE_HANDLES).toBe('1');
    expect(env.NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET).toBe('1');
    // ベクターの非 flag (network・ダミー鍵) も親 shell より優先する
    expect(env.NEXT_PUBLIC_NETWORK_ENV).toBe('testnet');
    expect(env.NEXT_PUBLIC_PIMLICO_API_KEY).toBe('dummy_for_build');
    // flag 以外の親 env はそのまま (npm / node の PATH 等)
    expect(env.PATH).toBe('/usr/bin');
  });

  it('defines every public flag so .env.local cannot fill one in during next build', () => {
    // @next/env は process.env に無いキーだけを .env.local から入れる。全 flag を明示しておけば
    // ローカル dotenv の ON/OFF は計測に混ざらない。
    const env = budgetBuildEnv({ parentEnv: {}, prodFlagsText: read('e2e/prodFlags.env'), flagKeys });
    for (const key of flagKeys) expect(env[key], key).toMatch(/^[01]$/);
    const vector = Object.keys(env).filter((key) => env[key] === '1');
    expect(vector).toContain('NEXT_PUBLIC_ENABLE_JPYC_EIP3009');
    expect(vector).not.toContain('NEXT_PUBLIC_ENABLE_REGISTER_FEE');
  });

  it('is what check-bundle-budget --build passes to next build', () => {
    const script = read('scripts/check-bundle-budget.mjs');
    expect(script).toContain("from './lib/bundleBudgetEnv.mjs'");
    expect(script).toMatch(/env:\s*budgetBuildEnv\(/);
    expect(script).toMatch(/sourceTextsUnder\(/);
  });
});
