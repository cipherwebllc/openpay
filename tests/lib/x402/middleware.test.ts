import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// x402-next と logger は境界 mock。SUT の withX402Payment 本体は実コード走行で
// 動作確認する。
vi.mock('x402-next', () => ({
  withX402: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { withX402 } from 'x402-next';
import { logger } from '@/lib/logger';

const X402_KEYS = [
  'X402_NETWORK',
  'X402_PAY_TO_ADDRESS',
  'X402_FACILITATOR_URL',
  'X402_PRICE',
  'X402_TEST_MODE',
] as const;
const ORIG: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const k of X402_KEYS) {
    ORIG[k] = process.env[k];
    delete process.env[k];
  }
  // testnet で安全な default
  process.env.X402_NETWORK = 'base-sepolia';
  process.env.X402_PAY_TO_ADDRESS =
    '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
});

afterEach(() => {
  for (const k of X402_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

function makeReq(path = '/api/paid/hello'): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

describe('lib/x402/middleware.withX402Payment', () => {
  it('test mode bypass: withX402 を一切呼ばずに handler を素通し', async () => {
    process.env.X402_TEST_MODE = 'true';
    const { withX402Payment } = await import('@/lib/x402/middleware');

    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const wrapped = withX402Payment(handler);
    const res = await wrapped(makeReq());

    expect(handler).toHaveBeenCalledOnce();
    expect(withX402).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('production-like: withX402 に payTo / routeConfig / facilitator を正しく渡す', async () => {
    const handler = vi.fn(async () => NextResponse.json({ msg: 'ok' }));
    const innerWrapped = vi.fn(async () => NextResponse.json({ inner: true }));
    vi.mocked(withX402).mockReturnValue(innerWrapped);

    const { withX402Payment } = await import('@/lib/x402/middleware');
    const wrapped = withX402Payment(handler, { description: 'demo route' });

    expect(withX402).toHaveBeenCalledOnce();
    const [handlerArg, payTo, routeConfig, facilitator] = vi.mocked(
      withX402,
    ).mock.calls[0];
    expect(handlerArg).toBe(handler);
    expect(payTo).toBe('0x52d4901142e2B5680027da5EB47C86CB02a3cA81');
    expect(routeConfig).toMatchObject({
      price: '$0.001',
      network: 'base-sepolia',
      config: expect.objectContaining({
        description: 'demo route',
        mimeType: 'application/json',
      }),
    });
    expect(facilitator).toEqual({ url: 'https://x402.org/facilitator' });

    // wrapped を呼ぶと innerWrapped が呼ばれる経路を確認
    const res = await wrapped(makeReq());
    expect(innerWrapped).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('overrides で price / network / description / mimeType / timeout を上書き', async () => {
    vi.mocked(withX402).mockReturnValue(
      vi.fn(async () => NextResponse.json({})),
    );
    const { withX402Payment } = await import('@/lib/x402/middleware');
    withX402Payment(vi.fn(async () => NextResponse.json({})), {
      price: '$0.05',
      network: 'base',
      description: 'custom',
      mimeType: 'text/plain',
      maxTimeoutSeconds: 90,
    });
    const [, , routeConfig] = vi.mocked(withX402).mock.calls[0];
    expect(routeConfig).toMatchObject({
      price: '$0.05',
      network: 'base',
      config: {
        description: 'custom',
        mimeType: 'text/plain',
        maxTimeoutSeconds: 90,
      },
    });
  });

  it('X402_PRICE env を default として渡す', async () => {
    process.env.X402_PRICE = '$0.10';
    vi.mocked(withX402).mockReturnValue(
      vi.fn(async () => NextResponse.json({})),
    );
    const { withX402Payment } = await import('@/lib/x402/middleware');
    withX402Payment(vi.fn(async () => NextResponse.json({})));
    const [, , routeConfig] = vi.mocked(withX402).mock.calls[0];
    expect((routeConfig as { price: string }).price).toBe('$0.10');
  });

  it('X402_FACILITATOR_URL env を渡す', async () => {
    process.env.X402_FACILITATOR_URL = 'https://facilitator.example.com';
    vi.mocked(withX402).mockReturnValue(
      vi.fn(async () => NextResponse.json({})),
    );
    const { withX402Payment } = await import('@/lib/x402/middleware');
    withX402Payment(vi.fn(async () => NextResponse.json({})));
    const [, , , facilitator] = vi.mocked(withX402).mock.calls[0];
    expect(facilitator).toEqual({ url: 'https://facilitator.example.com' });
  });

  it('wrapped が throw した場合は 402 + payment_facility_unavailable + logger.warn', async () => {
    vi.mocked(withX402).mockReturnValue(async () => {
      throw new Error('facilitator unreachable');
    });
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const wrapped = withX402Payment(vi.fn(async () => NextResponse.json({})));
    const res = await wrapped(makeReq('/api/paid/hello'));

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).toMatchObject({
      x402Version: 1,
      error: 'payment_facility_unavailable',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'x402.middleware.error',
      expect.objectContaining({
        error: 'facilitator unreachable',
        route: '/api/paid/hello',
      }),
    );
  });

  it('wrapped が 402 を返す正規 path: そのまま透過 (content を漏らさない)', async () => {
    vi.mocked(withX402).mockReturnValue(async () =>
      NextResponse.json({ x402Version: 1, error: 'payment_required' }, { status: 402 }),
    );
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const wrapped = withX402Payment(vi.fn(async () => NextResponse.json({ secret: 1 })));
    const res = await wrapped(makeReq());
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).not.toHaveProperty('secret');
  });

  it('handler は test mode 時のみ wrap されずそのまま返る — request も透過する', async () => {
    process.env.X402_TEST_MODE = 'true';
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const handler = vi.fn(async (req: NextRequest) => {
      expect(req.nextUrl.pathname).toBe('/api/paid/hello');
      return NextResponse.json({ pathname: req.nextUrl.pathname });
    });
    const wrapped = withX402Payment(handler);
    const res = await wrapped(makeReq('/api/paid/hello'));
    const body = await res.json();
    expect(body).toEqual({ pathname: '/api/paid/hello' });
  });
});
