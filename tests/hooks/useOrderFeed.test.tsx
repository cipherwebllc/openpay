// useOrderFeed (受注フィード共有 hook) を **実 react-query** で検証。
// 外部依存の fetch のみ stub し、query/mutation の配線・エラー処理・データ整形は実コードで走らせる。
// 重点: KV 障害 (503) を「受注ゼロ」と偽装しない / orders 非配列の防御 / mutation の POST body と
// 成功時 invalidate (再取得) / mutation 失敗の伝播 — 非同期挙動 (waitFor) を実際に観測する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOrderFeed } from '@/hooks/useOrderFeed';
import type { StoredOrder } from '@/lib/orderRelay';

function jsonRes(ok: boolean, body: unknown, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as Response;
}

const fetchHold: { get: Response; post: Response } = {
  get: jsonRes(true, { ok: true, orders: [] }),
  post: jsonRes(true, { ok: true, updated: 1 }),
};
const fetchSpy = vi.fn((_url: string, init?: RequestInit) =>
  Promise.resolve(init?.method === 'POST' ? fetchHold.post : fetchHold.get),
);

function makeClient() {
  // retry 無効 = エラーを即座に surface (テストを速く・決定論的に)。
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}
function wrap(qc: QueryClient) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'TestQueryWrapper';
  return Wrapper;
}

const TX = `0x${'a'.repeat(64)}`;
const ORDER: StoredOrder = {
  orderId: 'A1',
  items: [],
  table: null,
  amount: '1000000000000000000',
  txHash: TX,
  chainId: 137,
  from: '',
  ts: 1,
  fulfilled: false,
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  fetchHold.get = jsonRes(true, { ok: true, orders: [ORDER] });
  fetchHold.post = jsonRes(true, { ok: true, updated: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe('useOrderFeed', () => {
  it('サインイン時: GET /api/order/feed を取得し orders を返す', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useOrderFeed('0xabc', true, 999_999), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.feed.isSuccess).toBe(true));
    expect(result.current.feed.data).toEqual([ORDER]);
    expect(fetchSpy).toHaveBeenCalledWith('/api/order/feed');
  });

  it('未サインイン: query 無効で fetch しない (enabled=false)', async () => {
    const qc = makeClient();
    renderHook(() => useOrderFeed('0xabc', false, 999_999), { wrapper: wrap(qc) });
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('503 (KV障害): エラーを throw し「受注ゼロ」と偽装しない (data は undefined・空配列でない)', async () => {
    fetchHold.get = jsonRes(false, { ok: false, error: 'kv_error' }, 503);
    const qc = makeClient();
    const { result } = renderHook(() => useOrderFeed('0xabc', true, 999_999), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.feed.isError).toBe(true));
    expect((result.current.feed.error as Error).message).toBe('kv_error'); // サーバの error 文字列
    expect(result.current.feed.data).toBeUndefined(); // [] と区別 → UI は「一時的に取得不可」を出せる
  });

  it('orders が配列でない応答 → 空配列に正規化 (防御的)', async () => {
    fetchHold.get = jsonRes(true, { ok: true }); // orders 欠落
    const qc = makeClient();
    const { result } = renderHook(() => useOrderFeed('0xabc', true, 999_999), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.feed.isSuccess).toBe(true));
    expect(result.current.feed.data).toEqual([]);
  });

  it('update.mutate: POST {txHash, op} を送り 成功で feed を invalidate (再取得)', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useOrderFeed('0xabc', true, 999_999), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.feed.isSuccess).toBe(true));
    fetchSpy.mockClear();

    const op = { kind: 'fulfill', value: true } as const;
    result.current.update.mutate({ txHash: TX, op });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));

    const postCall = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(postCall).toBeTruthy();
    expect(postCall![0]).toBe('/api/order/feed');
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ txHash: TX, op });
    // onSuccess → invalidateQueries → GET 再取得 (init 無しの呼び出し) が起きる。
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === undefined)).toBe(
        true,
      ),
    );
  });

  it('update.mutate: POST が !ok なら isError (http_<status>)', async () => {
    fetchHold.post = jsonRes(false, { ok: false }, 500);
    const qc = makeClient();
    const { result } = renderHook(() => useOrderFeed('0xabc', true, 999_999), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.feed.isSuccess).toBe(true));

    result.current.update.mutate({ txHash: TX, op: { kind: 'fulfill', value: true } });
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect((result.current.update.error as Error).message).toBe('http_500');
  });

  it('wallet 切替で queryKey が変わる (前 wallet の cache を流用しない)', async () => {
    const qc = makeClient();
    const { result, rerender } = renderHook(({ addr }: { addr: string }) => useOrderFeed(addr, true, 999_999), {
      wrapper: wrap(qc),
      initialProps: { addr: '0xaaa' },
    });
    await waitFor(() => expect(result.current.feed.isSuccess).toBe(true));
    // 別 wallet 用に異なる orders を返すよう差し替え。
    const ORDER2 = { ...ORDER, orderId: 'B2', txHash: `0x${'b'.repeat(64)}` };
    fetchHold.get = jsonRes(true, { ok: true, orders: [ORDER2] });
    rerender({ addr: '0xbbb' });
    await waitFor(() => expect(result.current.feed.data).toEqual([ORDER2]));
  });
});
