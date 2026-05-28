import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMarketRates } from '@/hooks/useMarketRates';

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

describe('useMarketRates', () => {
  it('成功 → data に { usdcJpy, updatedAt } が入る', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ usdcJpy: 154.5, updatedAt: '2026-05-28T12:00:00Z' }),
        { status: 200 },
      ),
    );
    const { result } = renderHook(() => useMarketRates(), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({
      usdcJpy: 154.5,
      updatedAt: '2026-05-28T12:00:00Z',
    });
  });

  it('/api/market/rates を引数なしで叩く (queryFn の URL 検証)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ usdcJpy: 150, updatedAt: '2026-05-28T12:00:00Z' }),
        { status: 200 },
      ),
    );
    const { result } = renderHook(() => useMarketRates(), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/market/rates');
  });

  it('502 → isError=true', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'upstream' }), { status: 502 }),
    );
    const { result } = renderHook(() => useMarketRates(), {
      wrapper: makeWrapper(),
    });
    // hook は retry: 1 を持つので、初回 fail → ~1s 後に retry → 確定で isError=true
    // になる。waitFor のデフォルト 1s では retry を待ち切れないため明示的に伸ばす。
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: 5_000,
    });
    expect(result.current.data).toBeUndefined();
  });

  it('200 だが shape 不正 (usdcJpy 欠落) → isError=true', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ updatedAt: '2026-01-01T00:00:00Z' }), {
        status: 200,
      }),
    );
    const { result } = renderHook(() => useMarketRates(), {
      wrapper: makeWrapper(),
    });
    // hook は retry: 1 を持つので、初回 fail → ~1s 後に retry → 確定で isError=true
    // になる。waitFor のデフォルト 1s では retry を待ち切れないため明示的に伸ばす。
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: 5_000,
    });
  });

  it('200 だが usdcJpy=0 (sentinel) → isError=true', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ usdcJpy: 0, updatedAt: '2026-01-01T00:00:00Z' }),
        { status: 200 },
      ),
    );
    const { result } = renderHook(() => useMarketRates(), {
      wrapper: makeWrapper(),
    });
    // hook は retry: 1 を持つので、初回 fail → ~1s 後に retry → 確定で isError=true
    // になる。waitFor のデフォルト 1s では retry を待ち切れないため明示的に伸ばす。
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: 5_000,
    });
  });
});
