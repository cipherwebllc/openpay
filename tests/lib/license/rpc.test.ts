// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { polygonAmoy } from 'viem/chains';
vi.mock('@/lib/chains', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/chains')>(), chainObjectForId: () => polygonAmoy, customRpcUrlForChain: () => 'https://rpc.example' }));
import { licenseRpc, LICENSE_RPC_TIMEOUT_MS } from '@/lib/license/rpc';
afterEach(() => { vi.unstubAllGlobals(); });
it('uses bounded transport with zero retries and stops new RPC dispatch after the deadline', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('unavailable')); vi.stubGlobal('fetch', fetch);
  const client = licenseRpc(80002);
  expect(client.transport.timeout).toBe(LICENSE_RPC_TIMEOUT_MS); expect(client.transport.retryCount).toBe(0);
  await expect(client.getBlockNumber()).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  const expired = licenseRpc(80002, Date.now() - 1); await expect(expired.getBlockNumber()).rejects.toThrow('license dispatch deadline'); expect(fetch).toHaveBeenCalledTimes(1);
});

// B13 follow-up (Codex 3 回目): dispatch 前の期限確認と http.timeout (ヘッダーまで) だけでは、ヘッダー受信後に本文が
// 止まると共有期限を越えて待ち続ける。RPC 開始時に「残り deadline と 2 秒の小さい方」から作った、本文受信まで効く
// abort signal を付ける (RPC ごとに作る)。
function slowBodyFetch(delayMs: number) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? null;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => { controller.enqueue(encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }))); controller.close(); }, delayMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); controller.error(new DOMException('aborted', 'AbortError')); });
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}
it('aborts the body read at the shared deadline even though the headers arrived in time', async () => {
  const fetch = slowBodyFetch(300); vi.stubGlobal('fetch', fetch);
  const client = licenseRpc(80002, Date.now() + 100);
  await expect(client.getBlockNumber()).rejects.toThrow(/abort|deadline/i);
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
});
// getBlockNumber は viem が cacheTime で結果を cache するので、2 回目以降の fetch を見るときは cache されない getChainId を使う。
it('a body inside the deadline succeeds, and each request gets its own signal (no deadline = the 2 second window only)', async () => {
  const fetch = slowBodyFetch(5); vi.stubGlobal('fetch', fetch);
  const client = licenseRpc(80002, Date.now() + 1_000);
  await expect(client.getChainId()).resolves.toBe(16);
  await expect(client.getChainId()).resolves.toBe(16);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]![1]?.signal).not.toBe(fetch.mock.calls[0]![1]?.signal);
  await expect(licenseRpc(80002).getChainId()).resolves.toBe(16);
  expect(fetch.mock.calls[2]![1]?.signal).toBeInstanceOf(AbortSignal);
});
