import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEntitlement } from '@/hooks/useEntitlement';

// fetch (= /api/entitlement/status) は外部依存。queryFn 本体は実コードを走らせる。
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useEntitlement', () => {
  it('200 → entitlement status を data に展開 (tier/expiresAt/bypass を検査)', async () => {
    const body = {
      ok: true,
      entitled: true,
      tier: 'basic',
      expiresAt: 1_900_000_000_000,
      bypass: false,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { result } = renderHook(() => useEntitlement(true), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      entitled: true,
      tier: 'basic',
      expiresAt: 1_900_000_000_000,
      bypass: false,
    });
    // cache: no-store で叩く
    expect(fetchMock).toHaveBeenCalledWith('/api/entitlement/status', {
      cache: 'no-store',
    });
  });

  it('401 (未ログイン) → data は null (エラーにしない)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    const { result } = renderHook(() => useEntitlement(true), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('500 → isError (entitlement_status_failed を throw)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    const { result } = renderHook(() => useEntitlement(true), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('entitlement_status_failed');
  });

  it('enabled=false → fetch しない (未ログイン時はクエリ無効)', async () => {
    const { result } = renderHook(() => useEntitlement(false), {
      wrapper: makeWrapper(),
    });
    // クエリは無効化され pending のまま fetch されない
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
