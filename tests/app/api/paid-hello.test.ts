import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// x402-next は vitest 環境で next/server を解決できないため境界 mock。
// X402_TEST_MODE=true により withX402 は呼ばれないが、module import 時に
// import 解決は走るので mock しておく。
vi.mock('x402-next', () => ({
  withX402: vi.fn(),
}));

// app/api/paid/hello/route.ts は server module で、import 時に withX402Payment
// (= lib/x402/middleware) を経由する。test mode env を set してから動的 import。

const X402_KEYS = ['X402_NETWORK', 'X402_PAY_TO_ADDRESS', 'X402_TEST_MODE'] as const;
const ORIG: Record<string, string | undefined> = {};

beforeEach(() => {
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
});
