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

  it('USDC mainnet の per-chain env override (4 chain) がパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_USDC_BASE_MAINNET_ADDRESS =
      '0xbabe0000000000000000000000000000000abcde';
    process.env.NEXT_PUBLIC_USDC_ARBITRUM_MAINNET_ADDRESS =
      '0xa1b1000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_OPTIMISM_MAINNET_ADDRESS =
      '0x0021000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_POLYGON_MAINNET_ADDRESS =
      '0xb01a000000000000000000000000000000abcde0';
    const mod = await import('@/lib/env');
    expect(mod.env.mainnetTokenOverrides.usdc.base?.toLowerCase()).toBe(
      '0xbabe0000000000000000000000000000000abcde',
    );
    expect(mod.env.mainnetTokenOverrides.usdc.arbitrum?.toLowerCase()).toBe(
      '0xa1b1000000000000000000000000000000abcde0',
    );
    expect(mod.env.mainnetTokenOverrides.usdc.optimism?.toLowerCase()).toBe(
      '0x0021000000000000000000000000000000abcde0',
    );
    expect(mod.env.mainnetTokenOverrides.usdc.polygon?.toLowerCase()).toBe(
      '0xb01a000000000000000000000000000000abcde0',
    );
  });

  it('USDC testnet の per-chain env override がパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_USDC_BASE_SEPOLIA_ADDRESS =
      '0xbabe0000000000000000000000000000000abcde';
    process.env.NEXT_PUBLIC_USDC_ARBITRUM_SEPOLIA_ADDRESS =
      '0xa1b1000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_OPTIMISM_SEPOLIA_ADDRESS =
      '0x0021000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_POLYGON_AMOY_ADDRESS =
      '0xb01a000000000000000000000000000000abcde0';
    const mod = await import('@/lib/env');
    expect(mod.env.testnetTokenOverrides.usdc.base?.toLowerCase()).toBe(
      '0xbabe0000000000000000000000000000000abcde',
    );
    expect(mod.env.testnetTokenOverrides.usdc.arbitrum?.toLowerCase()).toBe(
      '0xa1b1000000000000000000000000000000abcde0',
    );
    expect(mod.env.testnetTokenOverrides.usdc.optimism?.toLowerCase()).toBe(
      '0x0021000000000000000000000000000000abcde0',
    );
    expect(mod.env.testnetTokenOverrides.usdc.polygon?.toLowerCase()).toBe(
      '0xb01a000000000000000000000000000000abcde0',
    );
  });

  it('Arbitrum / Optimism RPC URL env が読み込まれる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL = 'https://rpc.example/arb';
    process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL = 'https://rpc.example/op';
    process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL =
      'https://rpc.example/arbs';
    process.env.NEXT_PUBLIC_OPTIMISM_SEPOLIA_RPC_URL =
      'https://rpc.example/ops';
    const mod = await import('@/lib/env');
    expect(mod.env.rpc.arbitrum).toBe('https://rpc.example/arb');
    expect(mod.env.rpc.optimism).toBe('https://rpc.example/op');
    expect(mod.env.rpc.arbitrumSepolia).toBe('https://rpc.example/arbs');
    expect(mod.env.rpc.optimismSepolia).toBe('https://rpc.example/ops');
  });

  it('Arbitrum / Optimism gas ceiling env が整数としてパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI = '5';
    process.env.NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI = '3';
    const mod = await import('@/lib/env');
    expect(mod.env.gasCeilingGwei.arbitrum).toBe(5);
    expect(mod.env.gasCeilingGwei.optimism).toBe(3);
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

describe('mainnet 投入時の silent failure ガード', () => {
  it('mainnet + FEE_RECEIVER 未設定 → throw (fee 永久消失防止)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    delete process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS;
    await expect(import('@/lib/env')).rejects.toThrow(
      /NEXT_PUBLIC_FEE_RECEIVER_ADDRESS/,
    );
  });

  it('mainnet + FEE_RECEIVER=dEaD placeholder → throw (フォールバック値での deploy を防止)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0x000000000000000000000000000000000000dead';
    await expect(import('@/lib/env')).rejects.toThrow(/0x\.\.\.dEaD/);
  });

  it('mainnet + PIMLICO_API_KEY 未設定 → throw (決済 runtime error 防止)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    delete process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
    await expect(import('@/lib/env')).rejects.toThrow(
      /NEXT_PUBLIC_PIMLICO_API_KEY/,
    );
  });

  it('mainnet + 全必須 env 設定済 → 正常 import', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    const mod = await import('@/lib/env');
    expect(mod.isMainnet).toBe(true);
  });

  it('testnet では FEE_RECEIVER 未設定でも throw しない (開発体験優先)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'testnet';
    delete process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS;
    delete process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
    const mod = await import('@/lib/env');
    expect(mod.env.feeReceiver.toLowerCase()).toBe(
      '0x000000000000000000000000000000000000dead',
    );
    expect(mod.env.pimlicoApiKey).toBe('');
  });
});
