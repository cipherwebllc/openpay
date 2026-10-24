// @vitest-environment node
// CVE-2026-111497 の手当て: 出品者が選べる URL の br 応答を Node の Brotli 展開器に渡さない。
// 本物の undici fetch とローカルの HTTP サーバで、止める前 (対照) と止めた後の両方を確かめる。
// ⚠️ node 環境が必須 — undici の fetch とローカルの HTTP サーバを使う。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchSsrfSafe, hasOnlySafeContentEncoding, refuseBrotliResponses } from '@/lib/x402/moderation';

const BODY = JSON.stringify({ ok: true });

// 頼まれた圧縮方式に関係なく返す (悪意のあるサーバの振る舞い)。
// Node は header の文字列を latin1 で書くので、' ' は 0xA0 の 1 バイトで届く。
const ROUTES: Record<string, { status?: number; headers: Record<string, string>; body: Buffer | string }> = {
  '/br': { headers: { 'content-encoding': 'br' }, body: zlib.brotliCompressSync(BODY) },
  '/nbsp-br': { headers: { 'content-encoding': ' br' }, body: zlib.brotliCompressSync(BODY) },
  '/br-nbsp': { headers: { 'content-encoding': 'br ' }, body: zlib.brotliCompressSync(BODY) },
  '/gzip-tab-br': { headers: { 'content-encoding': 'gzip,\tBR' }, body: zlib.brotliCompressSync(zlib.gzipSync(BODY)) },
  '/redirect-br': {
    status: 302,
    headers: { 'content-encoding': 'br', location: '/plain' },
    body: zlib.brotliCompressSync(BODY),
  },
  '/zstd': { headers: { 'content-encoding': 'zstd' }, body: BODY },
  '/gzip': { headers: { 'content-encoding': 'gzip' }, body: zlib.gzipSync(BODY) },
  '/identity': { headers: { 'content-encoding': 'identity' }, body: BODY },
  '/plain': { headers: {}, body: BODY },
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = ROUTES[req.url ?? ''] ?? ROUTES['/plain'];
    res.writeHead(route.status ?? 200, { 'content-type': 'application/json', ...route.headers });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const noBrHeaders = { 'accept-encoding': 'gzip, deflate' };
const BROTLI_CASES: Array<[string, RequestRedirect]> = [
  ['/br', 'manual'],
  ['/nbsp-br', 'manual'],
  ['/br-nbsp', 'manual'],
  ['/gzip-tab-br', 'manual'],
  ['/redirect-br', 'manual'],
  ['/redirect-br', 'error'],
];

describe('lib/x402/moderation refuseBrotliResponses (本物の undici fetch)', () => {
  it.each(BROTLI_CASES)('対照 %s (redirect %s): 止めないと、br を頼まなくても fetch は Brotli 展開器を作る', async (path, redirect) => {
    const spy = vi.spyOn(zlib, 'createBrotliDecompress');
    const dispatcher = new Agent();
    try {
      await undiciFetch(`${origin}${path}`, { headers: noBrHeaders, redirect, dispatcher })
        .then((res) => res.arrayBuffer())
        .catch(() => null);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await dispatcher.close();
    }
  });

  it.each([...BROTLI_CASES, ['/zstd', 'manual'] as [string, RequestRedirect]])(
    '%s (redirect %s): 展開器を作らずに fetch を reject する',
    async (path, redirect) => {
      const spy = vi.spyOn(zlib, 'createBrotliDecompress');
      const dispatcher = new Agent().compose(refuseBrotliResponses);
      try {
        const error = await undiciFetch(`${origin}${path}`, { headers: noBrHeaders, redirect, dispatcher }).then(
          () => null,
          (err: unknown) => err,
        );
        expect(error).toBeInstanceOf(TypeError);
        expect(((error as TypeError).cause as Error).message).toBe('content_encoding_refused');
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        await dispatcher.close();
      }
    },
  );

  it.each(['/gzip', '/identity', '/plain'])('%s: 今までどおり読める', async (path) => {
    const dispatcher = new Agent().compose(refuseBrotliResponses);
    try {
      const res = await undiciFetch(`${origin}${path}`, { headers: noBrHeaders, dispatcher });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await dispatcher.close();
    }
  });
});

describe('lib/x402/moderation hasOnlySafeContentEncoding', () => {
  const raw = (...pairs: Array<string | number[]>) =>
    pairs.map((value) => (typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.from(value)));

  it.each([
    [raw('Content-Encoding', 'br'), false],
    [raw('content-type', 'application/json', 'content-encoding', 'gzip, br'), false],
    [raw('content-encoding', ' BR '), false],
    [raw('content-encoding', [0xa0, 0x62, 0x72]), false],
    [raw('content-encoding', [0x62, 0x72, 0xa0]), false],
    [raw('content-encoding', 'gzip,\tbr'), false],
    [raw('content-encoding', 'gzip', 'content-encoding', 'br'), false],
    [raw('content-encoding', 'brotli'), false],
    [raw('content-encoding', 'zstd'), false],
    [raw('content-encoding', 'gzip'), true],
    [raw('content-encoding', 'X-GZIP, deflate'), true],
    [raw('content-encoding', 'identity'), true],
    [raw('content-encoding', ''), true],
    [raw('x-content-encoding', 'br'), true],
    [raw('content-type', 'br'), true],
    [[], true],
  ])('%#', (headers, expected) => {
    expect(hasOnlySafeContentEncoding(headers)).toBe(expected);
  });
});

describe('lib/x402/moderation fetchSsrfSafe accept-encoding', () => {
  it('br を頼まない', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await fetchSsrfSafe('https://seller.example/paid', {
      fetchImpl,
      lookup: async () => [{ address: '93.184.216.34' }],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]['accept-encoding']).toBe('gzip, deflate');
  });
});
