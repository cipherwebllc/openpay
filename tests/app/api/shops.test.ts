import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getAddress } from 'viem';

const state = vi.hoisted(() => ({
  handles: ['alpha', 'bravo', 'charlie', 'delta'] as string[],
  summaries: new Map<string, string>(),
  lives: new Map<string, string | null>(),
  indexFails: false,
  summaryMgetFails: false,
}));
const kvMocks = vi.hoisted(() => ({
  lrange: vi.fn(),
  mget: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));
const rate = vi.hoisted(() => ({
  allowed: true,
  check: vi.fn(async () => rate.allowed),
}));
const payment = vi.hoisted(() => ({
  verify: vi.fn(),
  settle: vi.fn(),
}));

vi.mock('@/lib/kv', () => ({
  kvLrange: kvMocks.lrange,
  kvMget: kvMocks.mget,
  kvGet: kvMocks.get,
  kvSet: kvMocks.set,
  kvEval: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  kvSetNxGet: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  isKvConfigured: vi.fn(() => true),
}));
vi.mock('@/lib/net/ipHash', () => ({
  clientIp: vi.fn(() => '203.0.113.10'),
  hashIp: vi.fn(() => 'hashed-ip'),
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: rate.check,
}));
vi.mock('@/app/api/facilitator/verify/route', () => ({
  POST: payment.verify,
}));
vi.mock('@/app/api/facilitator/settle/route', () => ({
  POST: payment.settle,
}));

const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const PAYER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');

type Route = { GET: (req: Request) => Promise<Response> };
type StaticRoute = { GET: () => Promise<Response> };

function summary(
  handle: string,
  input: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    handle,
    name: `${handle} shop`,
    tagline: `${handle} tagline`,
    address: `東京都 ${handle}`,
    mode: 'storefront',
    dineIn: false,
    acceptingOrders: true,
    menu: {
      itemCount: 2,
      minPrice: '100',
      maxPrice: '500',
      itemIds: [`${handle}-a`, `${handle}-b`],
    },
    chain: 'polygon',
    chains: ['polygon'],
    updatedAt: 1_700_000_000_000,
    phone: '03-0000-0000',
    ...input,
  });
}

function paymentHeader(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'eip155:80002',
      payload: {
        signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}21b`,
        authorization: {
          from: PAYER,
          validAfter: '0',
          validBefore: '9999999999',
          intentSalt: `0x${'22'.repeat(32)}`,
        },
      },
    }),
    'utf8',
  ).toString('base64');
}

function req(path: string, paid = false): Request {
  return new Request(`https://open-pay.jp${path}`, {
    headers: paid ? { 'X-PAYMENT': paymentHeader() } : undefined,
  });
}

async function load(
  flags: Partial<{
    shops: string;
    facilitator: string;
    relay: string;
    agent: string;
  }> = {},
): Promise<{ free: Route; find: Route; paid: Route; openapi: StaticRoute }> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', flags.shops ?? '1');
  vi.stubEnv(
    'NEXT_PUBLIC_ENABLE_X402_FACILITATOR',
    flags.facilitator ?? '1',
  );
  vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', flags.relay ?? '1');
  vi.stubEnv('ENABLE_AGENT_ORDER', flags.agent ?? '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOP_LIVE', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_PREORDER_TIME', '1');
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '1');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.resetModules();
  return {
    free: (await import('@/app/api/shops/route')) as Route,
    find: (await import('@/app/api/shops/find/route')) as Route,
    paid: (await import('@/app/api/paid/jpyc-shops/search/route')) as Route,
    openapi: (await import('@/app/api/openapi.json/route')) as StaticRoute,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.handles = ['alpha', 'bravo', 'charlie', 'delta'];
  state.summaries.clear();
  state.lives.clear();
  state.indexFails = false;
  state.summaryMgetFails = false;
  rate.allowed = true;
  kvMocks.get.mockResolvedValue({ ok: true, value: null });
  kvMocks.set.mockResolvedValue({ ok: true, value: 'OK' });
  for (const handle of state.handles) {
    state.summaries.set(handle, summary(handle));
    state.lives.set(
      handle,
      JSON.stringify({ soldOut: [], paused: false, updatedAt: 10 }),
    );
  }
  kvMocks.lrange.mockImplementation(async () =>
    state.indexFails
      ? { ok: false as const, reason: 'network_error' as const }
      : { ok: true as const, value: [...state.handles] },
  );
  kvMocks.mget.mockImplementation(async (keys: readonly string[]) => {
    if (keys.every((key) => key.startsWith('shops:summary:'))) {
      if (state.summaryMgetFails) {
        return { ok: false as const, reason: 'network_error' as const };
      }
      return {
        ok: true as const,
        value: keys.map(
          (key) => state.summaries.get(key.slice('shops:summary:'.length)) ?? null,
        ),
      };
    }
    return {
      ok: true as const,
      value: keys.map(
        (key) => state.lives.get(key.slice('shop:live:'.length)) ?? null,
      ),
    };
  });
  payment.verify.mockResolvedValue(
    NextResponse.json({ isValid: true, payer: PAYER }),
  );
  payment.settle.mockResolvedValue(
    NextResponse.json({
      success: true,
      payer: PAYER,
      transaction: `0x${'ab'.repeat(32)}`,
      network: 'eip155:80002',
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /api/shops', () => {
  it('index 先頭3件を固定で name/mode のみ返し、件数・封筒・cacheを付ける', async () => {
    const { free } = await load();
    const first = await free.GET(req('/api/shops'));
    const second = await free.GET(req('/api/shops'));
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('s-maxage=30');
    const firstBody = (await first.json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
      licenseNotice: { ja: string; en: string };
    };
    const secondBody = (await second.json()) as typeof firstBody;
    expect(firstBody.items).toEqual([
      { name: 'alpha shop', mode: 'storefront' },
      { name: 'bravo shop', mode: 'storefront' },
      { name: 'charlie shop', mode: 'storefront' },
    ]);
    expect(secondBody.items).toEqual(firstBody.items);
    expect(firstBody.total).toBe(4);
    expect(firstBody.licenseNotice.ja).toContain('店舗が自ら掲載に同意');
    expect(firstBody.licenseNotice.en).toContain('consent');
    expect(rate.check).toHaveBeenCalledWith('shops', 'hashed-ip', 30, 60);
  });

  it.each([
    { shops: '', facilitator: '1', relay: '1', agent: '1' },
    { shops: '1', facilitator: '', relay: '1', agent: '1' },
    { shops: '1', facilitator: '1', relay: '', agent: '1' },
    { shops: '1', facilitator: '1', relay: '1', agent: '' },
  ])('4 flag AND のどれか OFF は404: %o', async (flags) => {
    const { free } = await load(flags);
    expect((await free.GET(req('/api/shops'))).status).toBe(404);
    expect(rate.check).not.toHaveBeenCalled();
    expect(kvMocks.lrange).not.toHaveBeenCalled();
  });
});

describe('GET /api/shops/find', () => {
  it('店名 q の部分一致・limit を適用し、4 field と acceptingNow 三値だけを返す', async () => {
    state.handles = ['alpha', 'bravo', 'charlie'];
    state.summaries.set('alpha', summary('alpha', { name: 'Blue Cafe' }));
    state.summaries.set('bravo', summary('bravo', { name: 'Blue Bakery' }));
    state.summaries.set(
      'charlie',
      summary('charlie', { name: 'Blue Kitchen', acceptingOrders: false }),
    );
    state.lives.set('bravo', '{bad');
    const { find } = await load();
    const res = await find.GET(req('/api/shops/find?q=BLUE&limit=3'));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=30');
    const body = (await res.json()) as {
      query: { q: string; limit: number };
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.query).toEqual({ q: 'BLUE', limit: 3 });
    expect(body.total).toBe(3);
    expect(body.items).toEqual([
      {
        handle: 'alpha',
        name: 'Blue Cafe',
        mode: 'storefront',
        acceptingNow: true,
      },
      {
        handle: 'bravo',
        name: 'Blue Bakery',
        mode: 'storefront',
        acceptingNow: null,
      },
      {
        handle: 'charlie',
        name: 'Blue Kitchen',
        mode: 'storefront',
        acceptingNow: false,
      },
    ]);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'acceptingNow',
        'handle',
        'mode',
        'name',
      ]);
    }
    expect(rate.check).toHaveBeenCalledWith('shops', 'hashed-ip', 30, 60);
    expect(kvMocks.mget).toHaveBeenCalledTimes(2);
    expect(kvMocks.mget.mock.calls[1][0]).toEqual([
      'shop:live:alpha',
      'shop:live:bravo',
      'shop:live:charlie',
    ]);
  });

  it('limit 既定/上限は10で、live MGET は返却ページ分だけに限定する', async () => {
    state.handles = Array.from({ length: 12 }, (_, index) => `shop${index}`);
    state.summaries.clear();
    state.lives.clear();
    for (const handle of state.handles) {
      state.summaries.set(handle, summary(handle));
      state.lives.set(
        handle,
        JSON.stringify({ soldOut: [], paused: false, updatedAt: 10 }),
      );
    }
    const { find } = await load();
    const defaultRes = await find.GET(req('/api/shops/find'));
    const defaultBody = (await defaultRes.json()) as {
      query: { limit: number };
      items: Array<{ handle: string }>;
      total: number;
    };
    const cappedRes = await find.GET(req('/api/shops/find?limit=999'));
    const cappedBody = (await cappedRes.json()) as {
      query: { limit: number };
      items: Array<{ handle: string }>;
      total: number;
    };

    expect(defaultBody.query.limit).toBe(10);
    expect(defaultBody.items).toHaveLength(10);
    expect(defaultBody.total).toBe(12);
    expect(cappedBody.query.limit).toBe(10);
    expect(cappedBody.items).toHaveLength(10);
    expect(cappedBody.total).toBe(12);
    expect(kvMocks.mget.mock.calls[0][0]).toHaveLength(12);
    expect(kvMocks.mget.mock.calls[1][0]).toEqual(
      state.handles.slice(0, 10).map((handle) => `shop:live:${handle}`),
    );
    expect(kvMocks.mget.mock.calls[2][0]).toHaveLength(12);
    expect(kvMocks.mget.mock.calls[3][0]).toEqual(
      state.handles.slice(0, 10).map((handle) => `shop:live:${handle}`),
    );
  });

  it('q/limit 以外の有料 filter は受け付けない', async () => {
    const { find } = await load();
    const res = await find.GET(req('/api/shops/find?mode=storefront'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_query' });
    expect(kvMocks.lrange).not.toHaveBeenCalled();
  });

  it('q は tagline/address でなく店名だけを検索する', async () => {
    const { find } = await load();
    const res = await find.GET(req('/api/shops/find?q=東京都'));
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body).toMatchObject({ items: [], total: 0 });
    expect(kvMocks.mget).toHaveBeenCalledOnce();
  });

  it.each([
    { shops: '', facilitator: '1', relay: '1', agent: '1' },
    { shops: '1', facilitator: '', relay: '1', agent: '1' },
    { shops: '1', facilitator: '1', relay: '', agent: '1' },
    { shops: '1', facilitator: '1', relay: '1', agent: '' },
  ])('4 flag AND のどれか OFF は404: %o', async (flags) => {
    const { find } = await load(flags);
    expect((await find.GET(req('/api/shops/find'))).status).toBe(404);
    expect(rate.check).not.toHaveBeenCalled();
    expect(kvMocks.lrange).not.toHaveBeenCalled();
  });
});

describe('GET /api/paid/jpyc-shops/search', () => {
  it('未課金は KV を読まず 2 JPYC の402 challenge', async () => {
    const { paid } = await load();
    const res = await paid.GET(req('/api/paid/jpyc-shops/search?q=alpha'));
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: Array<{
        resource: string;
        extra: { openpay: { merchantValue: string } };
      }>;
    };
    expect(body.accepts[0]).toMatchObject({
      resource: 'https://open-pay.jp/api/paid/jpyc-shops/search',
      extra: {
        openpay: { merchantValue: (2n * 10n ** 18n).toString() },
      },
    });
    expect(kvMocks.lrange).not.toHaveBeenCalled();
    expect(payment.verify).not.toHaveBeenCalled();
    expect(payment.settle).not.toHaveBeenCalled();
  });

  it('支払い header 付きの index/summary KV 障害は503で verify/settle 不発火', async () => {
    state.summaryMgetFails = true;
    const { paid } = await load();
    const res = await paid.GET(
      req('/api/paid/jpyc-shops/search', true),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'storage_unavailable',
    });
    expect(kvMocks.lrange).toHaveBeenCalledOnce();
    expect(kvMocks.mget).toHaveBeenCalledOnce();
    expect(payment.verify).not.toHaveBeenCalled();
    expect(payment.settle).not.toHaveBeenCalled();
  });

  it('snapshot を先に確定後 verify→settle し、検索 item と三値を返す', async () => {
    state.lives.set('bravo', '{bad');
    const { paid } = await load();
    const res = await paid.GET(
      req(
        '/api/paid/jpyc-shops/search?acceptingNow=true&limit=20',
        true,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query: { acceptingNow: boolean };
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.query.acceptingNow).toBe(true);
    expect(body.total).toBe(3);
    expect(body.items.map((item) => item.handle)).toEqual([
      'alpha',
      'charlie',
      'delta',
    ]);
    expect(body.items[0]).toMatchObject({
      handle: 'alpha',
      acceptingNow: true,
      pageUrl: 'https://open-pay.jp/@alpha',
      menuUrl: '/api/agent-order/menu?h=alpha',
      menu: { itemCount: 2, minPrice: '100', maxPrice: '500' },
      live: { paused: false, soldOutCount: 0, updatedAt: 10 },
    });
    expect(body.items[0]).not.toHaveProperty('phone');
    expect(kvMocks.mget).toHaveBeenCalledTimes(2);
    expect(kvMocks.mget.mock.invocationCallOrder[1]).toBeLessThan(
      payment.verify.mock.invocationCallOrder[0],
    );
    expect(payment.verify).toHaveBeenCalledOnce();
    expect(payment.settle).toHaveBeenCalledOnce();
  });

  it('専用 limiter は読取前に shops-paid 10/分、超過は429', async () => {
    rate.allowed = false;
    const { paid } = await load();
    const res = await paid.GET(
      req('/api/paid/jpyc-shops/search', true),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(rate.check).toHaveBeenCalledWith(
      'shops-paid',
      'hashed-ip',
      10,
      60,
    );
    expect(kvMocks.lrange).not.toHaveBeenCalled();
    expect(payment.verify).not.toHaveBeenCalled();
    expect(payment.settle).not.toHaveBeenCalled();
  });
});

describe('Shops OpenAPI', () => {
  it('teaser/find/有料 route・2 JPYC・acceptingNow 三値を記述する', async () => {
    const { openapi } = await load();
    const res = await openapi.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      paths: Record<
        string,
        { get: Record<string, unknown> & { responses: Record<string, unknown> } }
      >;
      components: {
        schemas: {
          ShopSearchItem: {
            properties: {
              acceptingNow: { type: string[]; description: string };
            };
          };
          ShopFindItem: {
            required: string[];
            additionalProperties: boolean;
          };
        };
      };
    };
    expect(body.paths).toHaveProperty('/api/shops');
    expect(body.paths).toHaveProperty('/api/shops/find');
    expect(body.paths).toHaveProperty('/api/paid/jpyc-shops/search');
    expect(body.components.schemas.ShopFindItem.required).toEqual([
      'handle',
      'name',
      'mode',
      'acceptingNow',
    ]);
    expect(body.components.schemas.ShopFindItem.additionalProperties).toBe(false);
    expect(
      body.paths['/api/paid/jpyc-shops/search'].get['x-price-jpyc'],
    ).toBe(2);
    expect(
      body.paths['/api/paid/jpyc-shops/search'].get.responses,
    ).toHaveProperty('402');
    expect(
      body.components.schemas.ShopSearchItem.properties.acceptingNow.type,
    ).toEqual(['boolean', 'null']);
    expect(
      body.components.schemas.ShopSearchItem.properties.acceptingNow.description,
    ).toContain('indeterminate');
  });
});
