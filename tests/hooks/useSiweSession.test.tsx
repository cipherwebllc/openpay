import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
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
    wallet.signMessageAsync
      .mockReset()
      .mockResolvedValue(`0x${'a'.repeat(130)}`);
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

  it('サインイン成功時に接続 address 別 tip-messages cache を invalidate する', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(true, { ok: true, address: null }, 200))
      .mockResolvedValueOnce(jsonResponse(true, { nonce: '12345678' }, 200))
      .mockResolvedValueOnce(jsonResponse(true, { ok: true }, 200))
      .mockResolvedValue(
        jsonResponse(true, { ok: true, address: wallet.address }, 200),
      );
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSiweSession(), {
      wrapper: wrapper(client),
    });
    await waitFor(() =>
      expect(client.getQueryState(['siwe', 'me'])?.status).toBe('success'),
    );

    await act(async () => {
      await result.current.signIn('OpenPay test sign-in');
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tip-messages'],
    });
  });

  it('サインアウト成功時にも tip-messages cache を invalidate する', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(true, { ok: true, address: wallet.address }, 200),
      )
      .mockResolvedValueOnce(jsonResponse(true, { ok: true }, 200))
      .mockResolvedValue(
        jsonResponse(true, { ok: true, address: null }, 200),
      );
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSiweSession(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSignedIn).toBe(true));

    await act(async () => {
      await result.current.signOut();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tip-messages'],
    });
  });
});
