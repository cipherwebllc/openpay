// @vitest-environment node
// CVE-2026-111497 の手当て: 出品者が選べる URL の br 応答を Node の Brotli 展開器に渡さない。
// 本物の undici fetch とローカルの HTTP サーバで、止める前 (対照) と止めた後の両方を確かめる。
// ⚠️ node 環境が必須 — undici の fetch とローカルの HTTP サーバを使う。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchSsrfSafe, hasBrotliContentEncoding, refuseBrotliResponses } from '@/lib/x402/moderation';

const BODY = JSON.stringify({ ok: true });

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    // 頼まれた圧縮方式に関係なく返す (悪意のあるサーバの振る舞い)。
    if (req.url === '/br') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
      res.end(zlib.brotliCompressSync(BODY));
    } else if (req.url === '/gzip-br') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip, BR' });
      res.end(zlib.gzipSync(zlib.brotliCompressSync(BODY)));
    } else if (req.url === '/gzip') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(BODY));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(BODY);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const noBrHeaders = { 'accept-encoding': 'gzip, deflate' };

describe('lib/x402/moderation refuseBrotliResponses (本物の undici fetch)', () => {
  it('対照: 止めないと、br を頼まなくても fetch は Brotli 展開器を作る', async () => {
    const spy = vi.spyOn(zlib, 'createBrotliDecompress');
    const dispatcher = new Agent();
    try {
      const res = await undiciFetch(`${origin}/br`, { headers: noBrHeaders, dispatcher });
      expect(await res.text()).toBe(BODY);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await dispatcher.close();
    }
  });

  it.each(['/br', '/gzip-br'])('%s: 展開器を作らずに fetch を reject する', async (path) => {
    const spy = vi.spyOn(zlib, 'createBrotliDecompress');
    const dispatcher = new Agent().compose(refuseBrotliResponses);
    try {
      const error = await undiciFetch(`${origin}${path}`, { headers: noBrHeaders, dispatcher }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(TypeError);
      expect(((error as TypeError).cause as Error).message).toBe('brotli_response_refused');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await dispatcher.close();
    }
  });

  it.each(['/gzip', '/plain'])('%s: 今までどおり読める', async (path) => {
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

describe('lib/x402/moderation hasBrotliContentEncoding', () => {
  const raw = (...pairs: string[]) => pairs.map((value) => Buffer.from(value));

  it.each([
    [raw('Content-Encoding', 'br'), true],
    [raw('content-type', 'application/json', 'content-encoding', 'gzip, br'), true],
    [raw('content-encoding', ' BR '), true],
    [raw('content-encoding', 'gzip', 'content-encoding', 'br'), true],
    [raw('content-encoding', 'gzip'), false],
    [raw('content-encoding', 'brotli'), false],
    [raw('x-content-encoding', 'br'), false],
    [raw('content-type', 'br'), false],
    [[], false],
  ])('%#', (headers, expected) => {
    expect(hasBrotliContentEncoding(headers)).toBe(expected);
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
