import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// resolveAddress (lib) は viem の getEnsAddress に依存しており、ENS は
// 外部 RPC を叩くため hook テストでは module ごと境界モックする。
// queryKey / staleTime / retry / enabled のロジック自体は実コード。
const resolveAddress = vi.fn();
vi.mock('@/lib/resolveAddress', () => ({
  resolveAddress,
}));

import { useResolveAddress } from '@/hooks/useResolveAddress';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  resolveAddress.mockReset();
});

describe('useResolveAddress', () => {
  it('空文字 → enabled=false で resolveAddress は呼ばれない', () => {
    renderHook(() => useResolveAddress(''), { wrapper: makeWrapper() });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it('空白のみ → 同じく enabled=false', () => {
    renderHook(() => useResolveAddress('   '), { wrapper: makeWrapper() });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it('成功: data に resolved が入る', async () => {
    resolveAddress.mockResolvedValue({
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      name: 'vitalik.eth',
    });
    const { result } = renderHook(() => useResolveAddress('vitalik.eth'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.name).toBe('vitalik.eth');
    expect(result.current.data?.address).toBe(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    );
    expect(resolveAddress).toHaveBeenCalledWith('vitalik.eth');
  });

  it('確定した失敗 (登録されていない = ResolveAddressError) は再試行しない (queryFn は 1 回のみ)', async () => {
    const { ResolveAddressError } = await import('@/lib/resolveAddressError');
    resolveAddress.mockRejectedValue(new ResolveAddressError('foo.eth は登録されていません'));
    const { result } = renderHook(() => useResolveAddress('foo.eth'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/登録されていません/);
    expect(resolveAddress).toHaveBeenCalledOnce();
  });

  // 第 7 回レビュー #766 の持ち越し: RPC / CCIP の一時的な失敗 1 回で、会計中の QR を閉じない。
  it('一時的な失敗 (RPC 等) は 1 回だけ再試行し、2 回目に解決できれば error にしない', async () => {
    resolveAddress
      .mockRejectedValueOnce(new Error('HTTP request failed'))
      .mockResolvedValueOnce({ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'shop.eth' });
    const { result } = renderHook(() => useResolveAddress('shop.eth'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 3_000 });
    expect(resolveAddress).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  it('一時的な失敗が続けば 2 回で error (再試行は 1 回まで)', async () => {
    resolveAddress.mockRejectedValue(new Error('HTTP request failed'));
    const { result } = renderHook(() => useResolveAddress('shop.eth'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3_000 });
    expect(resolveAddress).toHaveBeenCalledTimes(2);
  });

  it('queryKey は trim + lowercase で同一化される (大文字/空白違いはキャッシュヒット)', async () => {
    resolveAddress.mockResolvedValue({
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      name: 'Vitalik.eth',
    });
    // 同じ QueryClient を共有
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const a = renderHook(() => useResolveAddress('Vitalik.eth'), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    // 大文字小文字 + 前後空白違いの 2 回目: キャッシュにヒットして resolveAddress
    // は再呼出しされない (queryKey が trim().toLowerCase() で一致)
    renderHook(() => useResolveAddress('  vitalik.eth  '), { wrapper });
    expect(resolveAddress).toHaveBeenCalledTimes(1);
  });
});
