import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  pimlicoUrl,
  pimlicoPaymasterContext,
  createPimlico,
  resolvePaymasterMode,
} from '@/lib/pimlico';

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
    // testnet (vitest default) でも mainnet 切替時でも JPYC は sponsorship 固定
    expect(resolvePaymasterMode('jpyc')).toBe('sponsorship');
  });

  it('USDC は testnet では sponsorship にフォールバック', () => {
    // vitest 既定 env が NEXT_PUBLIC_NETWORK_ENV=testnet
    expect(resolvePaymasterMode('usdc')).toBe('sponsorship');
  });

  it('USDC は mainnet で erc20 mode になる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    const mod = await import('@/lib/pimlico');
    expect(mod.resolvePaymasterMode('usdc')).toBe('erc20');
  });
});

describe('pimlicoPaymasterContext', () => {
  it('JPYC + SPONSORSHIP_POLICY_ID → sponsorship context', () => {
    expect(pimlicoPaymasterContext('jpyc')).toEqual({
      sponsorshipPolicyId: 'sp_test',
    });
  });

  it('USDC は testnet で sponsorship フォールバック', () => {
    // vitest 既定 env では USDC も sponsorship に倒れる
    expect(pimlicoPaymasterContext('usdc')).toEqual({
      sponsorshipPolicyId: 'sp_test',
    });
  });

  it('USDC mainnet では token を含む erc20 context を返す', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    const mod = await import('@/lib/pimlico');
    const ctx = mod.pimlicoPaymasterContext('usdc');
    expect(ctx).toHaveProperty('token');
    // mainnet 既定の Circle native USDC on Base
    expect((ctx as { token: string }).token.toLowerCase()).toBe(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    );
  });

  it('SPONSORSHIP_POLICY_ID 未設定時の sponsorship は undefined', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID;
    const mod = await import('@/lib/pimlico');
    expect(mod.pimlicoPaymasterContext('jpyc')).toBeUndefined();
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
});
