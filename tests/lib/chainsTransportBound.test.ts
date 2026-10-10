// @vitest-environment node
// B4 follow-up 2 (3): viem 2.56 の http.timeout はヘッダー受信までで本文の受信は範囲外。期限付きの transport には
// fetchOptions.signal (AbortSignal.timeout) を付けて本文の受信まで打ち切る。signal を尊重する fetch スタブで、本文が
// 遅れると期限付きだけが失敗し、既定の transport は (10 秒以内なので) 成功することを固定する。本番と同じ node 環境で実行。
import { afterEach, expect, it, vi } from 'vitest';
import { createPublicClient } from 'viem';
import { polygon } from 'viem/chains';
import { transportForChain } from '@/lib/chains';

function slowBodyFetch(delayMs: number) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? null;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' })));
          controller.close();
        }, delayMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); controller.error(new DOMException('aborted', 'AbortError')); });
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

it('a timeout-bound transport aborts the fetch (body included) through fetchOptions.signal; the default transport does not', async () => {
  const fetchMock = slowBodyFetch(100);
  vi.stubGlobal('fetch', fetchMock);
  const bounded = createPublicClient({ chain: polygon, transport: transportForChain(polygon.id, { timeout: 20, retryCount: 0 }) });
  await expect(bounded.getBlockNumber()).rejects.toThrow(/abort|timeout/i);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  const plain = createPublicClient({ chain: polygon, transport: transportForChain(polygon.id) });
  await expect(plain.getBlockNumber()).resolves.toBe(16n);
});

it('a bound transport still succeeds when the body arrives inside the timeout', async () => {
  vi.stubGlobal('fetch', slowBodyFetch(5));
  const bounded = createPublicClient({ chain: polygon, transport: transportForChain(polygon.id, { timeout: 500, retryCount: 0 }) });
  await expect(bounded.getBlockNumber()).resolves.toBe(16n);
});
