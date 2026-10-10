// @vitest-environment node
// B4 follow-up 2 (3) / 3 (1): viem 2.56 の http.timeout はヘッダー受信までで本文の受信は範囲外。期限付きの transport は
// fetch の開始時に「絶対 deadline までの残り時間と timeout の小さい方」から新しい abort signal を作り (onFetchRequest)、
// 本文の受信まで打ち切る。signal は RPC ごとに作るので、同じ client の後続 RPC や fallback 先が「作成時の signal」で
// 早期に abort されない。本番と同じ node 環境で実行。
import { afterEach, expect, it, vi } from 'vitest';
import { createPublicClient } from 'viem';
import { mainnet, polygon } from 'viem/chains';
import { transportForChain } from '@/lib/chains';

const RESULT = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' });

function jsonBody(delayMs: number, signal: AbortSignal | null) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const timer = setTimeout(() => { controller.enqueue(encoder.encode(RESULT)); controller.close(); }, delayMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); controller.error(new DOMException('aborted', 'AbortError')); });
    },
  });
}

// signal を尊重する fetch スタブ。本文を delayMs 遅らせ、signal が abort したら本文を error にする。
function slowBodyFetch(delayMs: number) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? null;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return new Response(jsonBody(delayMs, signal), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => { vi.unstubAllGlobals(); });

it('a timeout-bound transport aborts the fetch (body included) through the request signal; the default transport does not', async () => {
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

// getBlockNumber は viem が cacheTime で結果を cache するので、2 回目以降の fetch を見るテストは cache されない getChainId を使う。
it('creates a fresh signal per request so a later RPC on the same client is not aborted by the first one\'s clock', async () => {
  const fetchMock = slowBodyFetch(5);
  vi.stubGlobal('fetch', fetchMock);
  const client = createPublicClient({ chain: polygon, transport: transportForChain(polygon.id, { timeout: 60, retryCount: 0 }) });
  await expect(client.getChainId()).resolves.toBe(16);
  await sleep(80);
  // 作成時の signal (60 ms) なら、ここで既に abort 済み。
  await expect(client.getChainId()).resolves.toBe(16);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]![1]?.signal).not.toBe(fetchMock.mock.calls[0]![1]?.signal);
});

it('an absolute deadline bounds every request by the time left: a request started after it is aborted at once', async () => {
  const fetchMock = slowBodyFetch(5);
  vi.stubGlobal('fetch', fetchMock);
  const client = createPublicClient({ chain: polygon, transport: transportForChain(polygon.id, { timeout: 10_000, retryCount: 0, deadline: Date.now() + 150 }) });
  await expect(client.getChainId()).resolves.toBe(16);
  await sleep(200);
  await expect(client.getChainId()).rejects.toThrow(/abort|deadline/i);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('fallback endpoints compute their own signal when they start, so a slow primary does not pre-abort the next endpoint', async () => {
  let primary: string | null = null;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    const signal = init?.signal ?? null;
    if (primary === null) primary = key;
    if (key === primary) {
      // primary はヘッダーを返さず、signal の abort まで待つ。
      await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    }
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return new Response(jsonBody(5, signal), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = createPublicClient({ chain: mainnet, transport: transportForChain(mainnet.id, { timeout: 400, retryCount: 0, deadline: Date.now() + 1_000 }) });
  await expect(client.getBlockNumber()).resolves.toBe(16n);
  expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
});
