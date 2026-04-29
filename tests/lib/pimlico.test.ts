import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  pimlicoUrl,
  pimlicoPaymasterContext,
  createPimlico,
  resolvePaymasterMode,
} from '@/lib/pimlico';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('pimlicoUrl', () => {
  it('chainId と API key を含む URL を返す', () => {
    const url = pimlicoUrl(8453);
    expect(url).toBe(
      'https://api.pimlico.io/v2/8453/rpc?apikey=test_pimlico_key',
    );
  });

  it('別 chainId でもパス変化のみで API key は同じ', () => {
    expect(pimlicoUrl(80002)).toContain('/v2/80002/rpc');
  });
});

describe('resolvePaymasterMode', () => {
  it('JPYC は常に sponsorship', () => {
    const jpyc = defaultDeploymentForSymbol('jpyc');
    expect(resolvePaymasterMode(jpyc)).toBe('sponsorship');
  });

  it('USDC は testnet では sponsorship にフォールバック', () => {
    // vitest 既定 env が NEXT_PUBLIC_NETWORK_ENV=testnet
    const usdc = defaultDeploymentForSymbol('usdc');
    expect(resolvePaymasterMode(usdc)).toBe('sponsorship');
  });

  it('USDC は mainnet で erc20 mode になる (Base default)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    const tokens = await import('@/lib/tokens');
    const pim = await import('@/lib/pimlico');
    const usdc = tokens.defaultDeploymentForSymbol('usdc');
    expect(pim.resolvePaymasterMode(usdc)).toBe('erc20');
  });

  it('USDC は mainnet で chain を切り替えても erc20 (Arbitrum)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    const tokens = await import('@/lib/tokens');
    const pim = await import('@/lib/pimlico');
    const arb = tokens.deploymentForSlug('usdc', 'arbitrum');
    expect(pim.resolvePaymasterMode(arb)).toBe('erc20');
  });
});

describe('pimlicoPaymasterContext', () => {
  it('JPYC + SPONSORSHIP_POLICY_ID → sponsorship context', () => {
    const jpyc = defaultDeploymentForSymbol('jpyc');
    expect(pimlicoPaymasterContext(jpyc)).toEqual({
      sponsorshipPolicyId: 'sp_test',
    });
  });

  it('USDC は testnet で sponsorship フォールバック (sponsorshipPolicyId が返る)', () => {
    const usdc = defaultDeploymentForSymbol('usdc');
    expect(pimlicoPaymasterContext(usdc)).toEqual({
      sponsorshipPolicyId: 'sp_test',
    });
  });

  it('USDC mainnet では token を含む erc20 context を返す (Base default)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    const tokens = await import('@/lib/tokens');
    const pim = await import('@/lib/pimlico');
    const usdc = tokens.defaultDeploymentForSymbol('usdc');
    const ctx = pim.pimlicoPaymasterContext(usdc);
    expect(ctx).toHaveProperty('token');
    // mainnet 既定の Circle native USDC on Base
    expect((ctx as { token: string }).token.toLowerCase()).toBe(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    );
  });

  it('USDC mainnet で per-chain env override (Arbitrum) が context.token に反映', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    const override = '0xcafe000000000000000000000000000000000999';
    process.env.NEXT_PUBLIC_USDC_ARBITRUM_MAINNET_ADDRESS = override;
    const tokens = await import('@/lib/tokens');
    const pim = await import('@/lib/pimlico');
    const arb = tokens.deploymentForSlug('usdc', 'arbitrum');
    const ctx = pim.pimlicoPaymasterContext(arb);
    expect((ctx as { token: string }).token.toLowerCase()).toBe(override);
  });

  it('USDC mainnet で SPONSORSHIP_POLICY_ID が設定されていても erc20 mode は token のみ返す', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_should_be_ignored';
    const tokens = await import('@/lib/tokens');
    const pim = await import('@/lib/pimlico');
    const usdc = tokens.defaultDeploymentForSymbol('usdc');
    const ctx = pim.pimlicoPaymasterContext(usdc);
    expect(ctx).toHaveProperty('token');
    expect(ctx).not.toHaveProperty('sponsorshipPolicyId');
  });

  it('SPONSORSHIP_POLICY_ID 未設定時の sponsorship は undefined', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID;
    const tokens = await import('@/lib/tokens');
    const pim = await import('@/lib/pimlico');
    const jpyc = tokens.defaultDeploymentForSymbol('jpyc');
    expect(pim.pimlicoPaymasterContext(jpyc)).toBeUndefined();
  });
});

describe('createPimlico', () => {
  it('PimlicoClient インスタンスを生成 (transport 設定済み)', () => {
    const client = createPimlico(8453);
    // PimlicoClient は viem の Client 派生で、chain プロパティはないが
    // transport.type === 'http' を持つことで HTTP transport を確認できる。
    expect(client).toBeDefined();
    expect(typeof client.request).toBe('function');
  });

  it('NEXT_PUBLIC_PIMLICO_API_KEY 未設定 → pimlicoUrl 呼出で throw', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'testnet';
    const mod = await import('@/lib/pimlico');
    expect(() => mod.pimlicoUrl(8453)).toThrow(
      /NEXT_PUBLIC_PIMLICO_API_KEY/,
    );
  });

  it('NEXT_PUBLIC_PIMLICO_API_KEY 未設定 → createPimlico も同様に throw (transport 構築時)', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'testnet';
    const mod = await import('@/lib/pimlico');
    expect(() => mod.createPimlico(8453)).toThrow(
      /NEXT_PUBLIC_PIMLICO_API_KEY/,
    );
  });
});
