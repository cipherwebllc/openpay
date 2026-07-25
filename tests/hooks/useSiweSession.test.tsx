import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSiweSession } from '@/hooks/useSiweSession';

const wallet = vi.hoisted(() => ({
  address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
  chainId: 137,
  signMessageAsync: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: wallet.address,
    chainId: wallet.chainId,
  }),
  useSignMessage: () => ({
    signMessageAsync: wallet.signMessageAsync,
  }),
}));

function jsonResponse(ok: boolean, body: unknown, status: number): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 0,
        retryDelay: 0,
      },
    },
  });
}

function wrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'SiweSessionTestWrapper';
  return Wrapper;
}

describe('useSiweSession', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('/me の 503 を null の成功値として cache せず query error にする', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        false,
        { ok: false, error: 'session_storage_unavailable' },
        503,
      ),
    );
    const client = makeClient();

    renderHook(() => useSiweSession(), { wrapper: wrapper(client) });

    await waitFor(() => {
      expect(client.getQueryState(['siwe', 'me'])?.status).toBe('error');
    });
    expect(client.getQueryData(['siwe', 'me'])).toBeUndefined();
    expect(client.getQueryState(['siwe', 'me'])?.error).toEqual(
      new Error('siwe_me_http_503'),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
