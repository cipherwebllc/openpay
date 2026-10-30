// R6a: the payment-log POST drops its try/catch around checkReadRateLimit only because the
// limiter, over the real KV transport, resolves (fail-open) for every storage outcome.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { checkReadRateLimit } from '@/lib/relay/relayGuards';

const NOW = new Date('2026-09-24T12:34:56.000Z');
const KEY = `rl:read:logpay:unknown:${Math.floor(NOW.getTime() / 60_000)}`;
// 第 8 回レビュー E-5: 窓 2 つ分の期限は INCR と同じ pipeline の 1 往復で EXPIRE NX として送る (別の往復は無い)。
const PIPELINE_BODY = JSON.stringify([['INCR', KEY], ['EXPIRE', KEY, '120', 'NX']]);
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

function urls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

function pipelineReply(incr: unknown, expire: unknown = { result: 1 }): Response {
  return new Response(JSON.stringify([incr, expire]));
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
    // pipeline の応答の形の崩れ (要素ごとの配列でない・INCR の要素が欠ける / エラー)。
    ['200 empty array', () => Promise.resolve(new Response('[]'))],
    ['200 array of null', () => Promise.resolve(new Response('[null,null]'))],
    ['200 INCR element error', () => Promise.resolve(pipelineReply({ error: 'ERR' }))],
  ] as const)('fails open when %s', async (_name, reply) => {
    fetchMock.mockImplementation(reply);
    await expect(checkReadRateLimit('logpay:unknown', 60, 60)).resolves.toBe(true);
    expect(urls()).toEqual(['https://r6a-kv.test/pipeline']);
    expect(bodies()).toEqual([PIPELINE_BODY]);
  });

  it.each<{ incr: unknown; expire?: unknown; allowed: boolean }>([
    { incr: { result: 1 }, allowed: true },
    { incr: { result: 60 }, allowed: true },
    { incr: { result: 61 }, allowed: false },
    // 期限 (EXPIRE NX) の要素だけが失敗しても、取れた INCR の数で判定する (超過の判定を捨てない)。
    // 期限は同じ窓の次の判定の EXPIRE NX が付ける。
    { incr: { result: 1 }, expire: { error: 'ERR' }, allowed: true },
    { incr: { result: 61 }, expire: { error: 'ERR' }, allowed: false },
    { incr: { result: 61 }, expire: null, allowed: false },
    // 数値でない INCR 結果は本番では起きない。lib/kv が parse_error にするので、KV 障害と同じ fail-open になる
    // (以前は null を 0 として通し、{} は大小比較が false で拒否していた・第 7 回レビュー PR27 の Codex 指摘)。
    { incr: { result: null }, allowed: true },
    { incr: { result: {} }, allowed: true },
    { incr: { result: { toString: null, valueOf: null } }, allowed: true },
    // 整数の文字列も pipeline の経路 (checkIpRateLimit と同じ) では parse_error = fail-open。Upstash は INCR の結果を
    // JSON の数で返すので本番では起きない (単発の INCR だった頃は '61' を 61 として拒否していた)。
    { incr: { result: '61' }, allowed: true },
    { incr: { result: '1' }, allowed: true },
  ])('resolves $allowed for pipeline reply $incr / $expire', async ({ incr, expire, allowed }) => {
    fetchMock.mockResolvedValueOnce(pipelineReply(incr, expire));
    fetchMock.mockRejectedValue(new TypeError('no second round trip expected'));
    await expect(checkReadRateLimit('logpay:unknown', 60, 60)).resolves.toBe(allowed);
    expect(urls()).toEqual(['https://r6a-kv.test/pipeline']);
    expect(bodies()).toEqual([PIPELINE_BODY]);
  });
});
