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

  it('名前として正規化できない .eth (空のラベル) は形式違いの ResolveAddressError (再試行しない側)', async () => {
    const { resolveAddress } = await import('@/lib/resolveAddress');
    const { ResolveAddressError } = await import('@/lib/resolveAddressError');
    const err = await resolveAddress('a..eth').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveAddressError);
    expect((err as Error).message).toMatch(/0x アドレスまたは/);
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

  // viem の非 strict は Universal Resolver の HttpError (CCIP-Read のゲートウェイの失敗) まで null にする。
  // 実際の viem のエラー (ContractFunctionRevertedError を ContractFunctionExecutionError で包んだ形) で分類を固定する。
  async function resolverRevert(errorName: 'HttpError' | 'ResolverNotFound', args: readonly unknown[]) {
    const actual = await vi.importActual<typeof import('viem')>('viem');
    const abi = [
      { type: 'error', name: 'HttpError', inputs: [{ name: 'status', type: 'uint16' }, { name: 'message', type: 'string' }] },
      { type: 'error', name: 'ResolverNotFound', inputs: [{ name: 'name', type: 'bytes' }] },
    ] as const;
    const data = actual.encodeErrorResult({ abi, errorName, args } as Parameters<typeof actual.encodeErrorResult>[0]);
    const reverted = new actual.ContractFunctionRevertedError({ abi, data, functionName: 'resolve' });
    return new actual.ContractFunctionExecutionError(reverted, { abi, functionName: 'resolve', args: [] });
  }

  // viem の getEnsAddress と同じく、strict でなければこれらの revert (どれも viem の null 扱いの一覧) を null にして返す。
  function viemLikeGetEnsAddress(error: Error) {
    return vi.fn(async ({ strict }: { strict?: boolean }) => {
      if (!strict) return null;
      throw error;
    });
  }

  it.each([
    ['ゲートウェイの 404 (その名前を知らない)', 'HttpError', [404, 'Not Found']],
    ['resolver が無い', 'ResolverNotFound', ['0x00']],
  ] as const)('%s は「登録されていません」の ResolveAddressError (再試行しない)', async (_label, errorName, args) => {
    const error = await resolverRevert(errorName, args);
    const getEnsAddress = viemLikeGetEnsAddress(error);
    vi.doMock('viem', async () => {
      const actual = await vi.importActual<typeof import('viem')>('viem');
      return { ...actual, createPublicClient: () => ({ getEnsAddress }) };
    });
    const { resolveAddress } = await import('@/lib/resolveAddress');
    const { ResolveAddressError } = await import('@/lib/resolveAddressError');
    const err = await resolveAddress('nonexistent-name.eth').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveAddressError);
    expect((err as Error).message).toMatch(/登録されていません/);
    expect(getEnsAddress.mock.calls[0][0]).toMatchObject({ strict: true });
  });

  it.each([502, 429, 500])('ゲートウェイの一時的な失敗 (HttpError %i) は ResolveAddressError にしない (再試行される)', async (status) => {
    const error = await resolverRevert('HttpError', [status, 'gateway failure']);
    const getEnsAddress = viemLikeGetEnsAddress(error);
    vi.doMock('viem', async () => {
      const actual = await vi.importActual<typeof import('viem')>('viem');
      return { ...actual, createPublicClient: () => ({ getEnsAddress }) };
    });
    const { resolveAddress } = await import('@/lib/resolveAddress');
    const { ResolveAddressError } = await import('@/lib/resolveAddressError');
    const err = await resolveAddress('vitalik.eth').catch((e: unknown) => e);
    expect(err).toBe(error);
    expect(err).not.toBeInstanceOf(ResolveAddressError);
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
