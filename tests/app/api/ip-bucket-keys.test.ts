import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ ipLimit: vi.fn() }));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: h.ipLimit,
  checkReadRateLimit: vi.fn(),
}));
vi.mock('@/lib/kv', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/kv')>(),
  isKvConfigured: () => true,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env,
    enableTipMessage: true, enableWeb3Directory: true, enableShopsApi: true,
    enableX402Facilitator: true, enableOrderRelay: true, enableAgentOrder: true,
  } };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () => ({ ok: true, address: '0x1111111111111111111111111111111111111111' }),
}));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => true }));
vi.mock('@/lib/x402/hostedStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/x402/hostedStore')>(),
  getHostedProduct: async () => ({ id: 'h_' + 'a'.repeat(32), productKind: 'license', license: {} }),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const SECRET = '0123456789abcdef0123456789abcdef';
const WALLET = '0x1111111111111111111111111111111111111111';
const ID = 'h_' + 'a'.repeat(32);
const context = { params: Promise.resolve({ id: ID }) };
const digest = (network: string) => createHmac('sha256', SECRET).update(`ip:${network}`).digest('hex');

function requestFor(ip: string): Request {
  return new Request(`https://test.local/?address=${WALLET}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vercel-forwarded-for': '172.71.0.1',
      'cf-connecting-ip': ip,
    },
    body: '{}',
  });
}

beforeEach(() => {
  vi.stubEnv('IP_HASH_SECRET', SECRET);
  vi.stubEnv('ENABLE_AGENT_PURCHASES', '1');
  h.ipLimit.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

type RouteCase = {
  name: string;
  scope: string;
  max: number;
  call: (req: Request) => Promise<Response>;
};

// Exercise the real client-IP selection and HMAC at the route/limiter boundary.
// Deny at the limiter so the tests do not access storage or RPCs.
const routes: RouteCase[] = [
  { name: 'SIWE nonce', scope: 'siwe-nonce', max: 60, call: async (r) => (await import('@/app/api/auth/siwe/nonce/route')).POST(r) },
  { name: 'SIWE verify', scope: 'siwe-verify', max: 30, call: async (r) => (await import('@/app/api/auth/siwe/verify/route')).POST(r) },
  { name: 'tip messages GET', scope: 'tip-messages', max: 30, call: async (r) => (await import('@/app/api/tip-messages/route')).GET(r) },
  { name: 'tip messages DELETE', scope: 'tip-messages', max: 30, call: async (r) => (await import('@/app/api/tip-messages/route')).DELETE(r) },
  { name: 'agent activity', scope: 'agent-activity', max: 20, call: async (r) => (await import('@/app/api/agent/activity/route')).GET(r) },
  { name: 'agent challenge', scope: 'agent-purchases-challenge', max: 20, call: async (r) => (await import('@/app/api/agent/proof/challenge/route')).GET(r) },
  { name: 'agent verify', scope: 'agent-purchases-verify', max: 10, call: async (r) => (await import('@/app/api/agent/proof/verify/route')).POST(r) },
  { name: 'agent unbind', scope: 'agent-purchases-unbind', max: 30, call: async (r) => (await import('@/app/api/agent/proof/unbind/route')).POST(r) },
  { name: 'agent purchases', scope: 'agent-purchases-purchases', max: 60, call: async (r) => (await import('@/app/api/agent/purchases/route')).GET(r) },
  { name: 'agent bindings', scope: 'agent-purchases-bindings', max: 60, call: async (r) => (await import('@/app/api/agent/purchases/bindings/route')).GET(r) },
  { name: 'discovery resource', scope: 'x402-discovery-resource', max: 60, call: async (r) => (await import('@/app/api/discovery/[id]/route')).GET(r, context) },
  { name: 'resource POST', scope: 'x402-resource-write', max: 30, call: async (r) => (await import('@/app/api/facilitator/resources/route')).POST(r) },
  { name: 'resource PATCH', scope: 'x402-resource-write', max: 30, call: async (r) => (await import('@/app/api/facilitator/resources/[id]/route')).PATCH(r, context) },
  { name: 'directory', scope: 'directory', max: 30, call: async (r) => (await import('@/app/api/directory/route')).GET(new Request('https://test.local/api/directory', { headers: r.headers })) },
  { name: 'directory categories', scope: 'directory', max: 30, call: async (r) => (await import('@/app/api/directory/categories/route')).GET(r) },
  { name: 'directory tags', scope: 'directory', max: 30, call: async (r) => (await import('@/app/api/directory/tags/route')).GET(r) },
  { name: 'shops', scope: 'shops', max: 30, call: async (r) => (await import('@/app/api/shops/route')).GET(r) },
  { name: 'shops find', scope: 'shops', max: 30, call: async (r) => (await import('@/app/api/shops/find/route')).GET(new Request('https://test.local/api/shops/find', { headers: r.headers })) },
  { name: 'license descriptor', scope: 'license-products', max: 30, call: async (r) => (await import('@/app/api/license/products/[id]/route')).GET(r, context) },
  { name: 'license verification', scope: 'license-verify', max: 30, call: async (r) => (await import('@/app/api/license/verify/route')).GET(new Request(`https://test.local/api/license/verify?address=${WALLET}&product=${ID}`, { headers: r.headers })) },
  ...['content', 'delivery', 'product-read', 'products-read', 'products-write', 'seller-read', 'seller-write', 'library'].map((scope) => ({
    name: `store ${scope}`, scope: `creator-store:${scope}`, max: 60,
    call: async (r: Request) => {
      const result = await (await import('@/app/api/store/_shared')).requireStoreSeller(r, scope);
      if (result.ok) throw new Error('expected limiter rejection');
      return result.response;
    },
  })),
];

describe.each(routes)('$name bucket key', ({ scope, max, call }) => {
  it('shares one /64 across rotating hosts and keeps other /64s and IPv4 hosts separate', async () => {
    for (const [ip, network] of [
      ['2001:db8:1234:5678::1', '2001:db8:1234:5678::'],
      ['2001:0DB8:1234:5678:ffff:ffff:ffff:ffff', '2001:db8:1234:5678::'],
      ['2001:db8:1234:5679::1', '2001:db8:1234:5679::'],
      ['203.0.113.9', '203.0.113.9'],
      ['::ffff:203.0.113.9', '203.0.113.9'],
      ['203.0.113.10', '203.0.113.10'],
    ]) {
      h.ipLimit.mockClear();
      expect((await call(requestFor(ip))).status).toBe(429);
      expect(h.ipLimit.mock.calls).toEqual([[scope, digest(network), max, 60]]);
    }
  });
});

it.each([
  ['agent activity', 300], ['agent challenge', 200], ['agent verify', 100], ['agent purchases', 1000],
] as const)('%s uses the /64 bucket for its daily window too', async (name, dailyMax) => {
  const route = routes.find((route) => route.name === name)!;
  for (const ip of ['2001:db8:1234:5678::1', '2001:db8:1234:5678::2']) {
    h.ipLimit.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await route.call(requestFor(ip))).status).toBe(429);
    expect(h.ipLimit.mock.calls).toEqual([
      [route.scope, digest('2001:db8:1234:5678::'), route.max, 60],
      [`${route.scope}-day`, digest('2001:db8:1234:5678::'), dailyMax, 86400],
    ]);
  }
});

it('keeps the shared paid-shops guard on its existing /128 key for PR 10b', async () => {
  const { guardPaidShopsApi } = await import('@/app/api/shops/_shared');
  for (const ip of ['2001:db8::1', '2001:db8::2']) {
    h.ipLimit.mockClear();
    expect((await guardPaidShopsApi(requestFor(ip)))?.status).toBe(429);
    expect(h.ipLimit.mock.calls).toEqual([['shops-paid', digest(ip), 10, 60]]);
  }
});
