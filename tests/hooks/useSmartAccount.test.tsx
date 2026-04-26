import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// 重要: この import が壊れていれば (permissionless の
// `to7702SimpleSmartAccount` が消える等)、このテストファイル自体の
// ロード時点で例外を投げて失敗するため、CI で即検出される。
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { polygonAmoy } from 'viem/chains';

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useWalletClient: vi.fn(),
  usePublicClient: vi.fn(),
}));
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSmartAccount (smoke / boundary)', () => {
  it('モジュールが import できる (permissionless API 健全性)', () => {
    // import の解決が壊れていればここに到達しない
    expect(useSmartAccount).toBeTypeOf('function');
  });

  it('未接続: クエリは無効、queryFn は呼ばれない', () => {
    vi.mocked(useAccount).mockReturnValue({
      address: undefined,
      chainId: undefined,
    } as never);
    vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as never);
    vi.mocked(usePublicClient).mockReturnValue(undefined as never);

    const { result } = renderHook(() => useSmartAccount(), {
      wrapper: makeWrapper(),
    });
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('対応外 chainId (ethereum mainnet=1): 無効化', () => {
    vi.mocked(useAccount).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      chainId: 1,
    } as never);
    vi.mocked(useWalletClient).mockReturnValue({
      data: { chain: { id: 1 } },
    } as never);
    vi.mocked(usePublicClient).mockReturnValue({} as never);

    const { result } = renderHook(() => useSmartAccount(), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('walletClient だけ欠けている: 無効化', () => {
    vi.mocked(useAccount).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    } as never);
    vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as never);
    vi.mocked(usePublicClient).mockReturnValue({} as never);

    const { result } = renderHook(() => useSmartAccount(), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('publicClient だけ欠けている: 無効化', () => {
    vi.mocked(useAccount).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    } as never);
    vi.mocked(useWalletClient).mockReturnValue({
      data: { chain: polygonAmoy },
    } as never);
    vi.mocked(usePublicClient).mockReturnValue(undefined as never);

    const { result } = renderHook(() => useSmartAccount(), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  // queryFn 本体 (to7702SimpleSmartAccount → createSmartAccountClient) を
  // モックしきると実コード検証にならない。実走行は e2e (README 参照) で行う。
});
