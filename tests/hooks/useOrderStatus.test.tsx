// useOrderStatus の **実フック** を renderHook + QueryClient + global fetch mock で検証する。
// OrderStatusView.test はこのフックを mock するため、フック自身の fetch/エラーマッピング (res.ok 判定→
// route の error 文字列で throw・非JSON→http_<status>・enabled ゲート・URL 構築) は別途ここで実証する。
// 外部依存 (fetch) だけ mock し、フックの実コードパス (fetchStatus + react-query 設定) を実行する。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOrderStatus } from '@/hooks/useOrderStatus';

const TOKEN = 'p'.repeat(43);

// テストごとに独立した QueryClient (cache をテスト間で共有しない・retry 無効で失敗を即観測)。
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'QueryWrapper';
  return Wrapper;
}
function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('useOrderStatus (実フック・fetchStatus)', () => {
  it('200 + valid JSON → data を返す (実 fetch パスを通る)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ ok: true, state: 'ready', orderId: 'A1', updatedAt: 5, readyAt: 99 }),
      ),
    );
    const { result } = renderHook(() => useOrderStatus(TOKEN), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toMatchObject({ state: 'ready', orderId: 'A1', readyAt: 99 });
    expect(result.current.isError).toBe(false);
  });

  it('fetch URL は token を付けた /api/order/status?t= ・no-store', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(okResponse({ ok: true, state: 'received', orderId: 'X', updatedAt: 1 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useOrderStatus(TOKEN), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(fetchSpy).toHaveBeenCalledWith(`/api/order/status?t=${TOKEN}`, { cache: 'no-store' });
  });

  it('!ok (404 not_found) → route の error 文字列を Error として throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ ok: false, error: 'not_found' }) }),
    );
    const { result } = renderHook(() => useOrderStatus(TOKEN), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('not_found');
  });

  it('!ok + 非JSON body → http_<status> に倒す (json parse 失敗を握って generic 化)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('not json');
        },
      }),
    );
    const { result } = renderHook(() => useOrderStatus(TOKEN), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('http_503');
  });

  it('token null → enabled:false で fetch しない (無駄な polling/列挙を防ぐ)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useOrderStatus(null), { wrapper: makeWrapper() });
    // disabled query は fetch を発火しない。少し待っても呼ばれない。
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});
