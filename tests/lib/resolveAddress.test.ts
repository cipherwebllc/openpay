import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mainnet } from 'viem/chains';
import { isLikelyName } from '@/lib/nameDetection';

describe('isLikelyName', () => {
  it('0x address → false', () => {
    expect(isLikelyName('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(
      false,
    );
  });

  it('空文字 → false', () => {
    expect(isLikelyName('')).toBe(false);
  });

  it('vitalik.eth → true', () => {
    expect(isLikelyName('vitalik.eth')).toBe(true);
  });

  it('VITALIK.ETH (大文字) → true', () => {
    expect(isLikelyName('VITALIK.ETH')).toBe(true);
  });

  it('jesse.base.eth → true (Basenames)', () => {
    expect(isLikelyName('jesse.base.eth')).toBe(true);
  });

  it('foo.bar (.eth ない) → false', () => {
    expect(isLikelyName('foo.bar')).toBe(false);
  });

  it('前後空白付きでも判定', () => {
    expect(isLikelyName('  vitalik.eth  ')).toBe(true);
  });
});

describe('resolveAddress (0x ショートサーキット)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('0x アドレスは RPC を叩かず即時 return', async () => {
    const { resolveAddress } = await import('@/lib/resolveAddress');
    const r = await resolveAddress(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    );
    expect(r).not.toBeNull();
    expect(r?.address).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(r?.name).toBeNull();
  });

  it('空文字 → null', async () => {
    const { resolveAddress } = await import('@/lib/resolveAddress');
    expect(await resolveAddress('')).toBeNull();
    expect(await resolveAddress('   ')).toBeNull();
  });

  it('0x でも .eth でもない → 例外', async () => {
    const { resolveAddress } = await import('@/lib/resolveAddress');
    await expect(resolveAddress('not-an-address')).rejects.toThrow(
      /0x アドレスまたは/,
    );
  });
});

describe('resolveAddress (ENS / Basenames を mainnet Universal Resolver で解決)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('viem');
  });

  it('vitalik.eth → mainnet UR で resolve、checksum 化', async () => {
    const getEnsAddress = vi
      .fn()
      .mockResolvedValueOnce('0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
    vi.doMock('viem', async () => {
      const actual = await vi.importActual<typeof import('viem')>('viem');
      return {
        ...actual,
        createPublicClient: () => ({ getEnsAddress }),
      };
    });

    const { resolveAddress } = await import('@/lib/resolveAddress');
    const r = await resolveAddress('vitalik.eth');

    expect(getEnsAddress).toHaveBeenCalledOnce();
    const arg = getEnsAddress.mock.calls[0][0];
    expect(arg.name).toBe('vitalik.eth');
    // mainnet client は viem 組込みの ensUniversalResolver を使うので
    // universalResolverAddress を明示しない (CCIP-Read で .base.eth も処理可)
    expect(arg.universalResolverAddress).toBeUndefined();
    expect(r!.address).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(r!.name).toBe('vitalik.eth');
  });

  it('jesse.base.eth (Basenames) も同じ mainnet client で resolve (CCIP-Read 経由)', async () => {
    const getEnsAddress = vi
      .fn()
      .mockResolvedValueOnce('0x2211d1d0020daea8039e46cf1367962070d77da9');
    vi.doMock('viem', async () => {
      const actual = await vi.importActual<typeof import('viem')>('viem');
      return {
        ...actual,
        createPublicClient: () => ({ getEnsAddress }),
      };
    });

    const { resolveAddress } = await import('@/lib/resolveAddress');
    const r = await resolveAddress('jesse.base.eth');

    expect(getEnsAddress).toHaveBeenCalledOnce();
    const arg = getEnsAddress.mock.calls[0][0];
    expect(arg.name).toBe('jesse.base.eth');
    // Basenames も mainnet UR が CCIP-Read で解決するので Base 用 resolver
    // address を明示する必要はない (旧実装の hardcode は誤りだった)
    expect(arg.universalResolverAddress).toBeUndefined();
    expect(r!.address).toBe('0x2211d1D0020DAEA8039E46Cf1367962070d77DA9');
    expect(r!.name).toBe('jesse.base.eth');
  });

  it('未登録の .base.eth → "登録されていません" で throw', async () => {
    const getEnsAddress = vi.fn().mockResolvedValueOnce(null);
    vi.doMock('viem', async () => {
      const actual = await vi.importActual<typeof import('viem')>('viem');
      return {
        ...actual,
        createPublicClient: () => ({ getEnsAddress }),
      };
    });

    const { resolveAddress } = await import('@/lib/resolveAddress');
    await expect(resolveAddress('nonexistent.base.eth')).rejects.toThrow(
      /登録されていません/,
    );
  });

  it('未登録の .eth → "登録されていません" で throw', async () => {
    const getEnsAddress = vi.fn().mockResolvedValueOnce(null);
    vi.doMock('viem', async () => {
      const actual = await vi.importActual<typeof import('viem')>('viem');
      return {
        ...actual,
        createPublicClient: () => ({ getEnsAddress }),
      };
    });

    const { resolveAddress } = await import('@/lib/resolveAddress');
    await expect(resolveAddress('nonexistent-name.eth')).rejects.toThrow(
      /登録されていません/,
    );
  });

  it('CCIP-Read 等の RPC エラーがそのまま伝播する (catch しない設計)', async () => {
    const getEnsAddress = vi
      .fn()
      .mockRejectedValueOnce(new Error('CCIP-Read failed: gateway 502'));
    vi.doMock('viem', async () => {
      const actual = await vi.importActual<typeof import('viem')>('viem');
      return {
        ...actual,
        createPublicClient: () => ({ getEnsAddress }),
      };
    });

    const { resolveAddress } = await import('@/lib/resolveAddress');
    await expect(resolveAddress('vitalik.eth')).rejects.toThrow(/gateway 502/);
  });
});

describe('mainnet ENS Universal Resolver アドレス整合性', () => {
  it('viem 組込み mainnet.contracts.ensUniversalResolver が定義されている', () => {
    const addr = mainnet.contracts?.ensUniversalResolver?.address;
    expect(addr).toBeDefined();
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('current mainnet UR は 0xeeee... 始まり (CREATE2 vanity)', () => {
    const addr = mainnet.contracts?.ensUniversalResolver?.address;
    expect(addr?.toLowerCase()).toMatch(/^0xeeeeeeee/);
  });
});
