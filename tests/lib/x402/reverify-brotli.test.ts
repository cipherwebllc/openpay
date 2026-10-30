// @vitest-environment node
// E-1 (第 8 回レビュー): br で返る無料の 200 は refuseBrotliResponses が展開前に止めるので、再検証は本文を読めない。
// それでも status 200 は支払いなしで返っているので ungated 違反に数える (DNS/接続の失敗と同じ transient にしない)。
// 本物の undici fetch とローカルの HTTP サーバで、止めた応答の status が probe の verdict まで届くことを確かめる。
// ⚠️ node 環境が必須 — undici の fetch とローカルの HTTP サーバを使う。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { refuseBrotliResponses } from '@/lib/x402/moderation';
import { probeForReverifyDetailed } from '@/lib/x402/reverify';

const BR_BODY = zlib.brotliCompressSync('free content');

const ROUTES: Record<string, { status: number; headers: Record<string, string> }> = {
  '/br-200': { status: 200, headers: { 'content-encoding': 'br' } },
  '/br-200-challenge': { status: 200, headers: { 'content-encoding': 'br', 'cf-mitigated': 'challenge' } },
  '/br-402': { status: 402, headers: { 'content-encoding': 'br' } },
  '/br-404': { status: 404, headers: { 'content-encoding': 'br' } },
  '/br-302': { status: 302, headers: { 'content-encoding': 'br', location: 'https://other.example/' } },
  '/br-403': { status: 403, headers: { 'content-encoding': 'br' } },
};

let server: Server;
let origin: string;
let dispatcher: ReturnType<Agent['compose']>;

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = ROUTES[req.url ?? ''];
    res.writeHead(route.status, { 'content-type': 'text/plain', ...route.headers });
    res.end(BR_BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dispatcher = new Agent().compose(refuseBrotliResponses);
});

afterAll(async () => {
  await dispatcher.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// 本物の接続は private IP を拒むので、undici の fetch に refuseBrotliResponses だけを組んだ dispatcher を渡す。
const fetchImpl = ((url: string, init: RequestInit) =>
  undiciFetch(url, { ...(init as object), dispatcher })) as unknown as typeof fetch;
const lookup = async () => [{ address: '93.184.216.34' }];

describe('probeForReverifyDetailed の br 応答 (本物の undici fetch)', () => {
  it('br の 200 は展開せずに violation_200_ungated (authClass clear)', async () => {
    const spy = vi.spyOn(zlib, 'createBrotliDecompress');
    try {
      expect(await probeForReverifyDetailed(`${origin}/br-200`, { fetchImpl, lookup })).toEqual({
        verdict: 'violation_200_ungated',
        authClass: 'clear',
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('br の 200 でも cf-mitigated: challenge なら transient のまま', async () => {
    expect(await probeForReverifyDetailed(`${origin}/br-200-challenge`, { fetchImpl, lookup })).toEqual({
      verdict: 'transient',
      authClass: 'neutral',
    });
  });

  it.each(['/br-402', '/br-404', '/br-302', '/br-403'])('%s は今までどおり transient (200 以外は判定を変えない)', async (path) => {
    expect(await probeForReverifyDetailed(`${origin}${path}`, { fetchImpl, lookup })).toEqual({
      verdict: 'transient',
      authClass: 'neutral',
    });
  });
});
