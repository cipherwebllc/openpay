import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 2026-07-28: route は x402-next から lib/x402/vanillaGate (v2 dual-stack) へ移行済み。
// test mode env を set してから動的 import (config.ts は import 時に env を焼き付ける)。

const X402_KEYS = [
  'X402_NETWORK',
  'X402_PAY_TO_ADDRESS',
  'X402_TEST_MODE',
  'X402_PRICE',
] as const;
const ORIG: Record<string, string | undefined> = {};

beforeEach(() => {
  // config.ts は module-load 時に env を読んで const に焼き付けるため、
  // env 変更を反映させるには毎回 module cache を捨てて再 import する必要がある。
  vi.resetModules();
  for (const k of X402_KEYS) {
    ORIG[k] = process.env[k];
  }
  process.env.X402_NETWORK = 'base-sepolia';
  process.env.X402_PAY_TO_ADDRESS =
    '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
  process.env.X402_TEST_MODE = 'true'; // bypass payment in tests
});

afterEach(() => {
  for (const k of X402_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

describe('GET /api/paid/hello', () => {
  it('test mode: 200 + hello message + ISO timestamp', async () => {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/paid/hello/route');
    const req = new NextRequest('http://localhost/api/paid/hello');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('Hello, paid AI agent.');
    expect(body.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('timestamp はリクエストごとに更新される (動的 route)', async () => {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/paid/hello/route');
    const req = new NextRequest('http://localhost/api/paid/hello');
    const res1 = await GET(req);
    await new Promise((r) => setTimeout(r, 5));
    const res2 = await GET(req);
    const b1 = await res1.json();
    const b2 = await res2.json();
    expect(b1.timestamp).not.toBe(b2.timestamp);
  });

  it('Content-Type ヘッダが application/json', async () => {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/paid/hello/route');
    const res = await GET(new NextRequest('http://localhost/api/paid/hello'));
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('timestamp は new Date() で再 parse できる (有効な ISO 8601)', async () => {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/paid/hello/route');
    const beforeMs = Date.now() - 1000;
    const res = await GET(new NextRequest('http://localhost/api/paid/hello'));
    const afterMs = Date.now() + 1000;
    const body = await res.json();
    const parsed = new Date(body.timestamp);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.getTime()).toBeGreaterThanOrEqual(beforeMs);
    expect(parsed.getTime()).toBeLessThanOrEqual(afterMs);
  });

  it('並行 3 件 GET でも独立した timestamp が出る (handler が共有 state を持たない)', async () => {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/paid/hello/route');
    const reqs = [1, 2, 3].map(
      () => new NextRequest('http://localhost/api/paid/hello'),
    );
    const ress = await Promise.all(reqs.map((r) => GET(r)));
    const bodies = await Promise.all(ress.map((r) => r.json()));
    for (const b of bodies) {
      expect(b.message).toBe('Hello, paid AI agent.');
      expect(b.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('test mode bypass 時、route module は X402_PAY_TO_ADDRESS / X402_NETWORK の妥当性に依存しない', async () => {
    // testMode=true のため、PAY_TO が burn address でも起動・実行できる。
    delete process.env.X402_PAY_TO_ADDRESS;
    vi.resetModules();
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/paid/hello/route');
    const res = await GET(new NextRequest('http://localhost/api/paid/hello'));
    expect(res.status).toBe(200);
  });

  it('支払いなし (本番相当) → dual-stack 402: v1 body + v2 PAYMENT-REQUIRED (x402scan 掲載の前提)', async () => {
    process.env.X402_TEST_MODE = '';
    process.env.X402_NETWORK = 'base';
    process.env.X402_PRICE = '$0.01';
    vi.resetModules();
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/paid/hello/route');
    const res = await GET(new NextRequest('http://localhost/api/paid/hello'));
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: { network: string; maxAmountRequired: string; extra?: Record<string, unknown> }[];
    };
    expect(body.accepts[0].network).toBe('base');
    expect(body.accepts[0].maxAmountRequired).toBe('10000'); // $0.01
    expect(body.accepts[0].extra?.openpay).toBeUndefined(); // vanilla
    const pr = res.headers.get('PAYMENT-REQUIRED');
    expect(pr).toBeTruthy();
    const v2 = JSON.parse(Buffer.from(pr!, 'base64').toString()) as {
      x402Version: number;
      accepts: { network: string; amount: string }[];
    };
    expect(v2.x402Version).toBe(2);
    expect(v2.accepts[0].network).toBe('eip155:8453');
    expect(v2.accepts[0].amount).toBe('10000');
  });
});
