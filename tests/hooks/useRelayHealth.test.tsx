import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useRelayHealth } from '@/hooks/useRelayHealth';

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

describe('useRelayHealth', () => {
  it('endpoint が degraded:true を返す → degraded を反映 (reason 付き)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ degraded: true, reason: 'low_balance' }), {
        status: 200,
      }),
    );
    const { result } = renderHook(
      () => useRelayHealth({ chainId: 137, enabled: true }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.degraded).toBe(true));
    expect(result.current.reason).toBe('low_balance');
  });

  it('endpoint が degraded:false → degraded:false', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ degraded: false }), { status: 200 }),
    );
    const { result } = renderHook(
      () => useRelayHealth({ chainId: 137, enabled: true }),
      { wrapper: makeWrapper() },
    );
    // 読込中は fail-open default (degraded:false)。確定後も false のままを確認。
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.degraded).toBe(false);
  });

  it('chainId を query string に乗せて叩く (URL 検証)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ degraded: false }), { status: 200 }),
    );
    renderHook(() => useRelayHealth({ chainId: 8217, enabled: true }), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/relay/jpyc/health?chainId=8217',
    );
  });

  it('読込中の初期値は fail-open default { degraded:false }', () => {
    // fetch を解決させない (pending) → 初回 render は data 無し = default。
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(
      () => useRelayHealth({ chainId: 137, enabled: true }),
      { wrapper: makeWrapper() },
    );
    expect(result.current).toEqual({ degraded: false });
  });

  it('endpoint 非 200 (5xx) → fail-open default (degraded:false・retry:false)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    );
    const { result } = renderHook(
      () => useRelayHealth({ chainId: 137, enabled: true }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // retry:false なので 1 回で確定。error 時も fail-open default を返す。
    expect(result.current.degraded).toBe(false);
  });

  it('fetch が throw (network 断) → fail-open default (degraded:false)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(
      () => useRelayHealth({ chainId: 137, enabled: true }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.degraded).toBe(false);
  });

  it('200 だが shape 不正 (degraded が boolean でない) → fail-open default', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ degraded: 'yes' }), { status: 200 }),
    );
    const { result } = renderHook(
      () => useRelayHealth({ chainId: 137, enabled: true }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toEqual({ degraded: false });
  });

  it('enabled:false → fetch しない (default を返す)', async () => {
    renderHook(() => useRelayHealth({ chainId: 137, enabled: false }), {
      wrapper: makeWrapper(),
    });
    // enabled:false なので query は走らない。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('成功(degraded:true)後に refetch が error 化 → stale degraded を保持せず fail-open へ (Codex P1)', async () => {
    // 1 回目: degraded:true で成功 → banner 正しく出る。2 回目 (refetch): network 断。
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ degraded: true, reason: 'low_balance' }), {
          status: 200,
        }),
      )
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useRelayHealth({ chainId: 137, enabled: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.degraded).toBe(true)); // 初回 success
    // refetch を強制 → 2 回目は reject。error 後は last success (degraded:true) を保持せず
    // fail-open default (degraded:false) に戻る (query.data ?? だと true のまま残る回帰)。
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['relayHealth', 137] });
    });
    await waitFor(() => expect(result.current.degraded).toBe(false));
  });
});
