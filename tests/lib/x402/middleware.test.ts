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

  it('wrapped が throw した場合は 503 + payment_facility_unavailable + logger.warn (402 だと x402-fetch が crash する)', async () => {
    vi.mocked(withX402).mockReturnValue(async () => {
      throw new Error('facilitator unreachable');
    });
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const wrapped = withX402Payment(vi.fn(async () => NextResponse.json({})));
    const res = await wrapped(makeReq('/api/paid/hello'));

    expect(res.status).toBe(503);
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

  it('非 Error が throw された場合も safety 503 + String(err) で logger.warn', async () => {
    vi.mocked(withX402).mockReturnValue(async () => {
      // x402-next や Network 層が string / object を直接 throw するシナリオ
      throw 'string-error-payload';
    });
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const wrapped = withX402Payment(vi.fn(async () => NextResponse.json({})));
    const res = await wrapped(makeReq());
    expect(res.status).toBe(503);
    expect(logger.warn).toHaveBeenCalledWith(
      'x402.middleware.error',
      expect.objectContaining({
        error: 'string-error-payload',
        route: '/api/paid/hello',
      }),
    );
  });

  it('null が throw された場合も String(null) で記録、wrapper は 503 を返す', async () => {
    vi.mocked(withX402).mockReturnValue(async () => {
      throw null;
    });
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const wrapped = withX402Payment(vi.fn(async () => NextResponse.json({})));
    const res = await wrapped(makeReq());
    expect(res.status).toBe(503);
    expect(logger.warn).toHaveBeenCalledWith(
      'x402.middleware.error',
      expect.objectContaining({ error: 'null' }),
    );
  });

  it('並行 request: 同一 wrapper が独立に 402 を返し、互いに state を持たない', async () => {
    vi.mocked(withX402).mockReturnValue(async (req) => {
      // 各 request の pathname を含む 402 を返して干渉確認
      return NextResponse.json(
        {
          x402Version: 1,
          error: 'payment_required',
          route: req.nextUrl.pathname,
        },
        { status: 402 },
      );
    });
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const wrapped = withX402Payment(vi.fn(async () => NextResponse.json({})));

    const [r1, r2, r3] = await Promise.all([
      wrapped(makeReq('/api/paid/a')),
      wrapped(makeReq('/api/paid/b')),
      wrapped(makeReq('/api/paid/c')),
    ]);
    const [b1, b2, b3] = await Promise.all([r1.json(), r2.json(), r3.json()]);
    expect(b1.route).toBe('/api/paid/a');
    expect(b2.route).toBe('/api/paid/b');
    expect(b3.route).toBe('/api/paid/c');
  });

  it('並行 throw: 全 request が独立に safety 503 を受ける + logger.warn が 3 回', async () => {
    let counter = 0;
    vi.mocked(withX402).mockReturnValue(async () => {
      counter += 1;
      throw new Error(`call-${counter}`);
    });
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const wrapped = withX402Payment(vi.fn(async () => NextResponse.json({})));

    const results = await Promise.all([
      wrapped(makeReq()),
      wrapped(makeReq()),
      wrapped(makeReq()),
    ]);
    expect(results.every((r) => r.status === 503)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('test mode + overrides: overrides は無視される (handler は素のまま)', async () => {
    process.env.X402_TEST_MODE = 'true';
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const handler = vi.fn(async () =>
      NextResponse.json({ originalHandler: true }),
    );
    // overrides を渡しても test mode なら handler に変換は入らない
    const wrapped = withX402Payment(handler, {
      price: '$10',
      description: 'ignored in test mode',
    });
    expect(withX402).not.toHaveBeenCalled();
    const res = await wrapped(makeReq());
    const body = await res.json();
    expect(body).toEqual({ originalHandler: true });
  });

  it('overrides を渡さない場合は config default が full に適用される', async () => {
    vi.mocked(withX402).mockReturnValue(
      vi.fn(async () => NextResponse.json({})),
    );
    const { withX402Payment } = await import('@/lib/x402/middleware');
    withX402Payment(vi.fn(async () => NextResponse.json({})));

    const [, , routeConfig] = vi.mocked(withX402).mock.calls[0];
    expect(routeConfig).toEqual({
      price: '$0.001',
      network: 'base-sepolia',
      config: {
        description: 'OpenPay paid API',
        mimeType: 'application/json',
        maxTimeoutSeconds: undefined,
      },
    });
  });

  it('Phase 2 polygon: withX402 に network=polygon-amoy と JPYC ERC20TokenAmount price を渡す', async () => {
    process.env.X402_NETWORK = 'polygon-amoy';
    vi.mocked(withX402).mockReturnValue(
      vi.fn(async () => NextResponse.json({})),
    );
    const { withX402Payment } = await import('@/lib/x402/middleware');
    withX402Payment(vi.fn(async () => NextResponse.json({})));

    const [, , routeConfig] = vi.mocked(withX402).mock.calls[0];
    const rc = routeConfig as {
      price: { amount: string; asset: { address: string; eip712: { name: string; version: string } } };
      network: string;
    };
    expect(rc.network).toBe('polygon-amoy');
    expect(rc.price.amount).toBe('1000000000000000000');
    expect(rc.price.asset.address).toBe(
      '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
    );
    expect(rc.price.asset.eip712).toEqual({
      name: 'JPY Coin',
      version: '1',
    });
  });

  it('Phase 2 polygon mainnet: PAY_TO 設定で構築可能', async () => {
    process.env.X402_NETWORK = 'polygon';
    process.env.X402_PAY_TO_ADDRESS =
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    vi.mocked(withX402).mockReturnValue(
      vi.fn(async () => NextResponse.json({})),
    );
    const { withX402Payment } = await import('@/lib/x402/middleware');
    withX402Payment(vi.fn(async () => NextResponse.json({})));

    const [, payTo, routeConfig] = vi.mocked(withX402).mock.calls[0];
    expect(payTo).toBe('0x52d4901142e2B5680027da5EB47C86CB02a3cA81');
    expect((routeConfig as { network: string }).network).toBe('polygon');
  });

  it('throw 後の subsequent request も同じ wrapper で正常動作 (state leak なし)', async () => {
    let throwOnce = true;
    vi.mocked(withX402).mockReturnValue(async () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('first-call-fails');
      }
      return NextResponse.json({ paid: true });
    });
    const { withX402Payment } = await import('@/lib/x402/middleware');
    const wrapped = withX402Payment(vi.fn(async () => NextResponse.json({})));

    const r1 = await wrapped(makeReq());
    expect(r1.status).toBe(503);
    const r2 = await wrapped(makeReq());
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2).toEqual({ paid: true });
  });
});
