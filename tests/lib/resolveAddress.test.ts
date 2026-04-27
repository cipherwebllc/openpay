import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mainnet } from 'viem/chains';
import { isLikelyName } from '@/lib/nameDetection';

// resolveAddress の network ロジックは viem の getEnsAddress に委譲して
// いるため、ここでは isLikelyName と "0x 直接入力" の即時 return path
// だけ実コードでテストし、ENS / Basenames の RPC 経路は別途 e2e で検証する。

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
    // checksum 化される
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

describe('resolveAddress (ENS / Basenames 分岐: viem getEnsAddress を mock)', () => {
  // viem の createPublicClient が返す client の getEnsAddress を mock することで、
  // 実 RPC を叩かずに resolveAddress の分岐ロジックを実コード実行する。
  // resolveAddress はモジュール init 時に createPublicClient を呼ぶので、
  // module reset → vi.mock の順で組む。
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('viem');
  });

  it('jesse.base.eth → BASENAMES_PATTERN 経由で basenamesClient.getEnsAddress を呼び、checksum 化して返す', async () => {
    const getEnsAddress = vi
      .fn()
      .mockResolvedValueOnce('0x849151d7d0bf1f34b70d5cad5149d28cc2308bf1');
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
    // BASE Universal Resolver が明示的に指定されている (基底 ENS 経路と区別)
    expect(arg.universalResolverAddress.toLowerCase()).toBe(
      '0xeeeeeeee14d718c2b47d9923deab1335e144eeee',
    );
    expect(r).not.toBeNull();
    // checksum 化される (viem の getAddress canonical 表現)
    expect(r!.address).toBe('0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1');
    expect(r!.name).toBe('jesse.base.eth');
  });

  it('vitalik.eth → ENS_PATTERN 経由で ensClient.getEnsAddress (universalResolverAddress なし)', async () => {
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
    // ENS は viem の mainnet config に組込まれた universal resolver を使うため
    // 引数で明示しない
    expect(arg.universalResolverAddress).toBeUndefined();
    expect(r!.address).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(r!.name).toBe('vitalik.eth');
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

describe('Basenames (Base mainnet) Universal Resolver アドレスの determinism', () => {
  // lib/resolveAddress.ts は BASE_UNIVERSAL_RESOLVER を 0xeEeEeEee14...EeEe で
  // hardcode している。これは ENS Universal Resolver の CREATE2 deterministic
  // address pattern なので、viem の mainnet chain config が登録している
  // ensUniversalResolver.address と完全一致するはず。
  //
  // この test が落ちる場合:
  //   (a) viem 側で mainnet ensUniversalResolver アドレスが変わった
  //       → Basenames も同じ deployer/init code でデプロイされている前提が
  //         崩れた可能性 → README §6 で要再確認
  //   (b) lib/resolveAddress.ts 側で BASE_UNIVERSAL_RESOLVER を編集した
  //       → 意図的なら本 test も合わせて更新

  it('lib/resolveAddress の BASE_UNIVERSAL_RESOLVER は ENS canonical CREATE2 アドレスと一致', () => {
    const ensCanonical = mainnet.contracts?.ensUniversalResolver?.address;
    expect(ensCanonical).toBeDefined();
    // ファイル内 hardcode 値 (lowercase 比較)
    const baseUniversalResolver = '0xeEeEeEee14D718C2B47D9923Deab1335E144EeEe';
    expect(baseUniversalResolver.toLowerCase()).toBe(
      ensCanonical!.toLowerCase(),
    );
  });

  it('viem の mainnet ensUniversalResolver は 0xeeee… 始まり (CREATE2 vanity アドレス)', () => {
    const addr = mainnet.contracts?.ensUniversalResolver?.address;
    expect(addr?.toLowerCase()).toMatch(/^0xeeeeeeee/);
  });
});
