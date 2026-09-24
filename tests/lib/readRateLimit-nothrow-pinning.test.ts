// R6a: the payment-log POST drops its try/catch around checkReadRateLimit only because the
// limiter, over the real KV transport, resolves (fail-open) for every storage outcome.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { checkReadRateLimit } from '@/lib/relay/relayGuards';

const NOW = new Date('2026-09-24T12:34:56.000Z');
const KEY = `rl:read:logpay:unknown:${Math.floor(NOW.getTime() / 60_000)}`;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://r6a-kv.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'r6a-test-token');
  vi.stubEnv('KV_REST_API_URL', '');
  vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function bodies(): string[] {
  return fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
}

function erroredBody(): Response {
  return new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream broke')); } }));
}

describe('R6a checkReadRateLimit is no-throw over the real KV transport', () => {
  it('does no I/O and allows when KV is unconfigured', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    await expect(checkReadRateLimit('logpay:unknown', 60, 60)).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['fetch rejects with TypeError', () => Promise.reject(new TypeError('fetch failed'))],
    ['fetch rejects with TimeoutError', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['fetch rejects with AbortError', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
    ['fetch rejects with a string', () => Promise.reject('offline')],
    ['fetch rejects with null', () => Promise.reject(null)],
    ['fetch rejects with undefined', () => Promise.reject(undefined)],
    ['fetch throws synchronously', () => { throw new Error('sync'); }],
    ['HTTP 503 JSON error', () => Promise.resolve(new Response('{"error":"unavailable"}', { status: 503 }))],
    ['HTTP 502 HTML', () => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))],
    ['HTTP 400 with a non-string error', () => Promise.resolve(new Response('{"error":{"x":1}}', { status: 400 }))],
    ['HTTP 500 JSON null body', () => Promise.resolve(new Response('null', { status: 500 }))],
    ['200 invalid JSON', () => Promise.resolve(new Response('{'))],
    ['200 JSON null', () => Promise.resolve(new Response('null'))],
    ['200 JSON number', () => Promise.resolve(new Response('5'))],
    ['200 JSON string', () => Promise.resolve(new Response('"x"'))],
    ['200 empty object', () => Promise.resolve(new Response('{}'))],
    ['200 Upstash error', () => Promise.resolve(new Response('{"error":"ERR"}'))],
    ['200 body stream error', () => Promise.resolve(erroredBody())],
  ] as const)('fails open when %s', async (_name, reply) => {
    fetchMock.mockImplementation(reply);
    await expect(checkReadRateLimit('logpay:unknown', 60, 60)).resolves.toBe(true);
    expect(bodies()).toEqual([JSON.stringify(['INCR', KEY])]);
  });

  it.each([
    { result: 1, allowed: true, expire: true },
    { result: 60, allowed: true, expire: false },
    { result: 61, allowed: false, expire: false },
    { result: null, allowed: true, expire: false },
    // 数値でない INCR 結果は本番では起きない。その到達不能な癖 (拒否) をそのまま固定する。
    // fail-open に直すときは意図してこの行を更新する。
    { result: {}, allowed: false, expire: false },
  ])('resolves $allowed for INCR result $result', async ({ result, allowed, expire }) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result })));
    fetchMock.mockRejectedValue(new TypeError('EXPIRE unreachable'));
    await expect(checkReadRateLimit('logpay:unknown', 60, 60)).resolves.toBe(allowed);
    expect(bodies()).toEqual([
      JSON.stringify(['INCR', KEY]),
      ...(expire ? [JSON.stringify(['EXPIRE', KEY, '120'])] : []),
    ]);
  });
});
