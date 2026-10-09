// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetBuildEnv, publicFeatureFlagKeys } from '../../scripts/lib/bundleBudgetEnv.mjs';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

// check-bundle-budget --build の計測条件を CI (ci.yml は clean な runner で e2e/prodFlags.env だけを読む) と揃える。
// prodFlags.env は OFF の flag を載せないので、shell や .env.local に残った ON (例: 2026-10-07 に廃止した
// NEXT_PUBLIC_ENABLE_REGISTER_FEE=1) を明示の OFF で潰してからベクターを重ねる (Codex #789 P3)。
describe('bundle budget build env (--build)', () => {
  const flagKeys = publicFeatureFlagKeys([read('.env.local.example'), read('lib/env.ts')]);

  it('enumerates every public feature flag from the documented example and lib/env.ts', () => {
    expect(flagKeys.length).toBeGreaterThanOrEqual(40);
    for (const key of flagKeys) expect(key).toMatch(/^NEXT_PUBLIC_ENABLE_[A-Z0-9_]+$/);
    expect(flagKeys).toEqual([...new Set(flagKeys)].sort());
    for (const key of [
      'NEXT_PUBLIC_ENABLE_REGISTER_FEE',
      'NEXT_PUBLIC_ENABLE_HANDLES',
      'NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET',
      'NEXT_PUBLIC_ENABLE_MAV2',
      'NEXT_PUBLIC_ENABLE_MOCK_WALLET',
    ]) expect(flagKeys).toContain(key);
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
  });
});
