import { describe, it, expect, vi, afterEach } from 'vitest';

// 各テストで vi.resetModules() を使い、モジュール評価時の throw / 値を観測する。
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('lib/env (module-load validation)', () => {
  it('NETWORK_ENV=testnet で読込成功', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'testnet';
    const mod = await import('@/lib/env');
    expect(mod.env.networkEnv).toBe('testnet');
    expect(mod.isMainnet).toBe(false);
  });

  it('NETWORK_ENV=mainnet で isMainnet=true', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    const mod = await import('@/lib/env');
    expect(mod.env.networkEnv).toBe('mainnet');
    expect(mod.isMainnet).toBe(true);
  });

  it('NETWORK_ENV 不正値で throw する', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'goerli';
    await expect(import('@/lib/env')).rejects.toThrow(/NETWORK_ENV/);
  });

  it('NETWORK_ENV 未設定なら testnet にフォールバック', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_NETWORK_ENV;
    const mod = await import('@/lib/env');
    expect(mod.env.networkEnv).toBe('testnet');
  });

  it('FEE_RECEIVER_ADDRESS 未設定なら 0x...dEaD にフォールバック', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS;
    const mod = await import('@/lib/env');
    expect(mod.env.feeReceiver.toLowerCase()).toBe(
      '0x000000000000000000000000000000000000dead',
    );
  });

  it('FEE_RECEIVER_ADDRESS 指定値は checksum 化されて反映される', async () => {
    vi.resetModules();
    const lower = '0xcafe000000000000000000000000000000005678';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS = lower;
    const mod = await import('@/lib/env');
    // checksum 化されるため大文字小文字が混在し得る (元と !==) が、
    // toLowerCase で同値性確認できる。
    expect(mod.env.feeReceiver.toLowerCase()).toBe(lower);
  });

  it('FEE_RECEIVER_ADDRESS が不正値 → プレースホルダにフォールバック + warn', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS = 'not-an-address';
    const mod = await import('@/lib/env');
    expect(mod.env.feeReceiver.toLowerCase()).toBe(
      '0x000000000000000000000000000000000000dead',
    );
    expect(warn).toHaveBeenCalled();
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('JPYC_MAINNET_ADDRESS env override がパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_JPYC_MAINNET_ADDRESS =
      '0xabcd000000000000000000000000000000009999';
    const mod = await import('@/lib/env');
    expect(mod.env.mainnetTokenOverrides.jpyc?.toLowerCase()).toBe(
      '0xabcd000000000000000000000000000000009999',
    );
  });

  it('PIMLICO_API_KEY 未設定なら空文字 (実際の利用時に throw)', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
    const mod = await import('@/lib/env');
    expect(mod.env.pimlicoApiKey).toBe('');
  });

  it('SPONSORSHIP_POLICY_ID 未設定なら undefined', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID;
    const mod = await import('@/lib/env');
    expect(mod.env.pimlicoSponsorshipPolicyId).toBeUndefined();
  });
});
