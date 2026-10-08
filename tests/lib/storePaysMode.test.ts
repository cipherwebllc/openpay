import { describe, it, expect, vi } from 'vitest';

const flag = vi.hoisted(() => ({ on: true, forwarders: new Set<number>([80002, 1001]) }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'enableStoreGasWallet' ? flag.on : key === 'networkEnv' ? 'testnet' : Reflect.get(target, key),
    }),
  };
});

// 対象のチェーン = forwarder を設定したチェーン (既定は Amoy・Kairos)。
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) =>
    flag.forwarders.has(chainId) ? '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4' : null,
}));

import { storePaysActive, storePaysRequested } from '@/lib/storePaysMode';

describe('storePaysMode (決済モードの 3 つ目「お店がガス代を肩代わりして送る」)', () => {
  const base = { storePays: true, payMode: 'gasless' as const, token: 'jpyc' as const, chain: 'polygon' as const };

  it('選んでいて (gasless + storePays)、JPYC・対象チェーンなら使える', () => {
    flag.on = true;
    expect(storePaysRequested(base)).toBe(true);
    expect(storePaysActive(base)).toBe(true);
  });

  it('通常決済 (standard) との組み合わせは選んでいない扱い', () => {
    flag.on = true;
    expect(storePaysRequested({ ...base, payMode: 'standard' })).toBe(false);
  });

  it('USDC・対象外のチェーン (forwarder の無いチェーン) では選んだまま使えない (設定は消さない)', () => {
    flag.on = true;
    expect(storePaysRequested({ ...base, token: 'usdc', chain: 'base' })).toBe(true);
    expect(storePaysActive({ ...base, token: 'usdc', chain: 'base' })).toBe(false);
    expect(storePaysActive({ ...base, chain: 'kaia' })).toBe(true);
    flag.forwarders = new Set([80002]);
    try {
      expect(storePaysActive({ ...base, chain: 'kaia' })).toBe(false);
      expect(storePaysRequested({ ...base, chain: 'kaia' })).toBe(true);
    } finally {
      flag.forwarders = new Set([80002, 1001]);
    }
  });

  it('flag OFF では保存値に関係なく選んでいない', () => {
    flag.on = false;
    expect(storePaysRequested(base)).toBe(false);
    expect(storePaysActive(base)).toBe(false);
  });
});
