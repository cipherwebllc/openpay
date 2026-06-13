import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEntitlementStatus } from '@/hooks/useEntitlementStatus';

const STATUS_KEY = ['sample-entitlement', 'status'] as const;
let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

describe('useEntitlementStatus', () => {
  it('queryKey / endpoint / boolean field を設定どおり通す', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          entitled: true,
          expiresAt: 999_000,
          bypass: false,
        }),
        { status: 200 },
      ),
    );

    const { result } = renderHook(
      () =>
        useEntitlementStatus({
          queryKey: STATUS_KEY,
          enabled: true,
          endpoint: '/api/sample-entitlement/status',
          field: 'entitled',
          fallbackError: 'sample_status_failed',
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith('/api/sample-entitlement/status', {
      cache: 'no-store',
    });
    expect(result.current.data).toEqual({
      entitled: true,
      expiresAt: 999_000,
      bypass: false,
    });
    expect(queryClient.getQueryData(STATUS_KEY)).toEqual(result.current.data);
  });
});
