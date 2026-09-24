// @vitest-environment node
// R6b: route ごとの IP limiter の「鍵・窓・名前空間・IP 不明時の扱い」を KV の境界で固定する。
// relayGuards / ipHash / relayRoute は本物を使い、@/lib/kv の INCR/EXPIRE だけを差し替える。
// 呼び出し側を wrapper に寄せても、ここで見る KV 鍵と応答が 1 byte も変わらないことが条件
// (鍵が変わると本番のカウンタがリセットされる = B-R6 の範囲)。
//
// 現行の 2 戦略:
//   ip-bucket: 鍵 `iprl:v1:<scope>:<HMAC(IPv4 /32・IPv6 /64)>`・INCR の初回 TTL = 窓 (初回起点の固定窓)・
//              IP 不明や IP_HASH_SECRET 欠落は KV に触れず通す。
//   ip-prefix: 鍵 `rl:read:<key(匿名化 prefix: IPv4 /24・IPv6 /64)>:<floor(now/窓)>`・時計に揃えた固定窓・
//              初回だけ EXPIRE 窓×2・IP 不明は共有の 'unknown' bucket・secret は使わない。
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  kvConfigured: true,
  limiterResult: { ok: true, value: 1 } as { ok: true; value: number } | { ok: false; reason: string },
  kvIncr: vi.fn(),
  kvExpire: vi.fn(),
}));

vi.mock('@/lib/kv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kv')>()),
  isKvConfigured: () => h.kvConfigured,
  kvIncr: h.kvIncr,
  kvExpire: h.kvExpire,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableTipMessage: true,
      enableWeb3Directory: true,
      enableShopsApi: true,
      enableX402Facilitator: true,
      enableOrderRelay: true,
      enableAgentOrder: true,
      enableHandles: true,
      enablePushNotify: true,
      pushVapidPublicKey: 'test-public-key',
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () => ({ ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' }),
}));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => true }));
vi.mock('@/lib/x402/hostedStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/hostedStore')>()),
  getHostedProduct: async () => ({
    id: 'h_' + 'a'.repeat(32),
    productKind: 'license',
    owner: '0x1111111111111111111111111111111111111111',
    license: { definitionHash: 'd', tokenChainId: 137, contract: '0x2222222222222222222222222222222222222222', tokenId: '1' },
  }),
}));
vi.mock('@/lib/handleStore', () => ({
  listHandlesForOwner: async () => null,
  resolveHandle: async () => ({ ok: true, record: null }),
  releaseHandle: async () => 'released',
}));
vi.mock('@/lib/tipMessages', () => ({
  listTipMessages: async () => [],
  deleteTipMessages: async () => true,
}));
vi.mock('@/lib/push/store', () => ({
  listPushSubscriptions: async () => ({ ok: true, value: [] }),
  upsertPushSubscription: async () => ({ ok: true, value: [] }),
  removePushSubscription: async () => ({ ok: true, value: [] }),
}));
vi.mock('@/lib/push/server', () => ({
  sendPushToWallet: async () => ({ attempted: 0, sent: 0, removed: 0, failed: 0 }),
}));

const SECRET = '0123456789abcdef0123456789abcdef';
const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const PRODUCT_ID = 'h_' + 'a'.repeat(32);
// 2026-09-24T00:00:30Z: 60 秒窓の途中 (窓の境界で bucket がずれないことも別に見る)。
const NOW = Date.UTC(2026, 8, 24, 0, 0, 30);
const digest = (network: string) => createHmac('sha256', SECRET).update(`ip:${network}`).digest('hex');
const isLimiterKey = (key: unknown) => typeof key === 'string' && (key.startsWith('iprl:') || key.startsWith('rl:read:'));
const limiterIncrCalls = () => h.kvIncr.mock.calls.filter(([key]) => isLimiterKey(key));
const limiterExpireCalls = () => h.kvExpire.mock.calls.filter(([key]) => isLimiterKey(key));

type Headers4 = Record<string, string>;

// 真の利用者 IP を Cloudflare 経由 (信頼できる接続元) で渡す。
function trusted(ip: string): Headers4 {
  return { 'x-vercel-forwarded-for': '172.71.0.1', 'cf-connecting-ip': ip };
}

function makeRequest(url: string, method: string, headers: Headers4, body?: string): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

type Expected429 = { body: string; headers: Record<string, string | null> };

type BucketRoute = {
  name: string;
  scope: string;
  max: number;
  windowSec: number;
  call: (headers: Headers4) => Promise<Response | null>;
  denied: Expected429;
};

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

const bucketRoutes: BucketRoute[] = [
  {
    name: 'SIWE nonce', scope: 'siwe-nonce', max: 60, windowSec: 60,
    call: async (hd) => (await import('@/app/api/auth/siwe/nonce/route')).POST(makeRequest('https://test.local/api/auth/siwe/nonce', 'POST', hd)),
    denied: { body: '{"error":"rate_limited"}', headers: { 'retry-after': '60', 'cache-control': null } },
  },
  {
    name: 'SIWE verify', scope: 'siwe-verify', max: 30, windowSec: 60,
    call: async (hd) => (await import('@/app/api/auth/siwe/verify/route')).POST(makeRequest('https://test.local/api/auth/siwe/verify', 'POST', hd, '{}')),
    denied: { body: '{"error":"rate_limited"}', headers: { 'retry-after': '60', 'cache-control': null } },
  },
  {
    name: 'license descriptor', scope: 'license-products', max: 30, windowSec: 60,
    call: async (hd) => (await import('@/app/api/license/products/[id]/route')).GET(
      makeRequest(`https://test.local/api/license/products/${PRODUCT_ID}`, 'GET', hd), ctx({ id: PRODUCT_ID })),
    denied: { body: '{"error":"rate_limited"}', headers: { 'retry-after': '60', 'cache-control': 'no-store' } },
  },
  {
    name: 'license verify', scope: 'license-verify', max: 30, windowSec: 60,
    call: async (hd) => (await import('@/app/api/license/verify/route')).GET(
      makeRequest(`https://test.local/api/license/verify?address=0x1111111111111111111111111111111111111111&product=${PRODUCT_ID}`, 'GET', hd)),
    denied: { body: '{"error":"rate_limited"}', headers: { 'retry-after': '60', 'cache-control': 'no-store' } },
  },
  {
    name: 'shops (free)', scope: 'shops', max: 30, windowSec: 60,
    call: async (hd) => (await import('@/app/api/shops/_shared')).guardFreeShopsApi(makeRequest('https://test.local/api/shops', 'GET', hd)),
    denied: { body: '{"ok":false,"error":"rate_limited"}', headers: { 'retry-after': '60', 'cache-control': null } },
  },
  {
    name: 'shops (paid)', scope: 'shops-paid', max: 10, windowSec: 60,
    call: async (hd) => (await import('@/app/api/shops/_shared')).guardPaidShopsApi(makeRequest('https://test.local/api/shops/find', 'GET', hd)),
    denied: { body: '{"ok":false,"error":"rate_limited"}', headers: { 'retry-after': '60', 'cache-control': null } },
  },
  {
    name: 'directory', scope: 'directory', max: 30, windowSec: 60,
    call: async (hd) => (await import('@/app/api/directory/_shared')).guardFreeDirectoryApi(makeRequest('https://test.local/api/directory', 'GET', hd)),
    denied: { body: '{"ok":false,"error":"rate_limited"}', headers: { 'retry-after': '60', 'cache-control': null } },
  },
  {
    name: 'tip messages GET', scope: 'tip-messages', max: 30, windowSec: 60,
    call: async (hd) => (await import('@/app/api/tip-messages/route')).GET(makeRequest('https://test.local/api/tip-messages', 'GET', hd)),
    denied: { body: '{"error":"rate_limited"}', headers: { 'retry-after': '60', 'cache-control': 'private, no-store' } },
  },
  {
    name: 'tip messages DELETE', scope: 'tip-messages', max: 30, windowSec: 60,
    call: async (hd) => (await import('@/app/api/tip-messages/route')).DELETE(makeRequest('https://test.local/api/tip-messages', 'DELETE', hd)),
    denied: { body: '{"error":"rate_limited"}', headers: { 'retry-after': '60', 'cache-control': 'private, no-store' } },
  },
];

type PrefixRoute = {
  name: string;
  key: (prefix: string) => string;
  max: number;
  windowSec: number;
  call: (headers: Headers4) => Promise<Response>;
  deniedBody: string;
};

const prefixRoutes: PrefixRoute[] = [
  {
    name: 'handle availability GET', key: (p) => `handleavail:${p}`, max: 60, windowSec: 60,
    call: async (hd) => (await import('@/app/api/handle/[handle]/route')).GET(
      makeRequest('https://test.local/api/handle/testshop123', 'GET', hd), ctx({ handle: 'testshop123' })),
    deniedBody: '{"ok":false,"error":"rate_limited"}',
  },
  {
    name: 'push subscribe GET', key: (p) => `pushsub:${WALLET.toLowerCase()}:${p}`, max: 20, windowSec: 60,
    call: async (hd) => (await import('@/app/api/push/subscribe/route')).GET(makeRequest('https://test.local/api/push/subscribe', 'GET', hd)),
    deniedBody: '{"ok":false,"error":"rate_limited"}',
  },
  {
    name: 'push subscribe POST', key: (p) => `pushsub:${WALLET.toLowerCase()}:${p}`, max: 20, windowSec: 60,
    call: async (hd) => (await import('@/app/api/push/subscribe/route')).POST(makeRequest('https://test.local/api/push/subscribe', 'POST', hd, '{}')),
    deniedBody: '{"ok":false,"error":"rate_limited"}',
  },
  {
    name: 'push subscribe DELETE', key: (p) => `pushsub:${WALLET.toLowerCase()}:${p}`, max: 20, windowSec: 60,
    call: async (hd) => (await import('@/app/api/push/subscribe/route')).DELETE(makeRequest('https://test.local/api/push/subscribe', 'DELETE', hd, '{}')),
    deniedBody: '{"ok":false,"error":"rate_limited"}',
  },
  {
    name: 'push test POST', key: (p) => `pushtest:${WALLET.toLowerCase()}:${p}`, max: 1, windowSec: 60,
    call: async (hd) => (await import('@/app/api/push/test/route')).POST(makeRequest('https://test.local/api/push/test', 'POST', hd)),
    deniedBody: '{"ok":false,"error":"rate_limited"}',
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('IP_HASH_SECRET', SECRET);
  h.kvConfigured = true;
  h.limiterResult = { ok: true, value: 1 };
  h.kvIncr.mockReset().mockImplementation(async (key: string) =>
    isLimiterKey(key) ? h.limiterResult : { ok: false, reason: 'unconfigured' });
  h.kvExpire.mockReset().mockResolvedValue({ ok: true, value: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.each(bucketRoutes)('ip-bucket: $name', (route) => {
  it.each([
    ['IPv4 (/32)', '203.0.113.9', '203.0.113.9'],
    ['IPv4-mapped IPv6 (/32 に揃える)', '::ffff:203.0.113.9', '203.0.113.9'],
    ['IPv6 (/64 にまとめる)', '2001:db8:1234:5678::1', '2001:db8:1234:5678::'],
  ])('上限超過: %s の鍵・窓・429 応答', async (_label, ip, network) => {
    h.limiterResult = { ok: true, value: route.max + 1 };
    const res = await route.call(trusted(ip));
    expect(limiterIncrCalls()).toEqual([[`iprl:v1:${route.scope}:${digest(network)}`, { initialTtlSec: route.windowSec }]]);
    expect(limiterExpireCalls()).toEqual([]);
    expect(res?.status).toBe(429);
    expect(await res!.text()).toBe(route.denied.body);
    for (const [name, value] of Object.entries(route.denied.headers)) {
      expect(res!.headers.get(name)).toBe(value);
    }
  });

  it('カウントが上限ちょうどなら通す', async () => {
    h.limiterResult = { ok: true, value: route.max };
    const res = await route.call(trusted('203.0.113.9'));
    expect(limiterIncrCalls()).toEqual([[`iprl:v1:${route.scope}:${digest('203.0.113.9')}`, { initialTtlSec: route.windowSec }]]);
    expect(res?.status ?? 200).not.toBe(429);
  });

  it('信頼できない cf-connecting-ip は無視し、接続元 (XFF) の bucket を使う', async () => {
    h.limiterResult = { ok: true, value: route.max + 1 };
    const res = await route.call({ 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': '203.0.113.9' });
    expect(limiterIncrCalls()).toEqual([[`iprl:v1:${route.scope}:${digest('198.51.100.7')}`, { initialTtlSec: route.windowSec }]]);
    expect(res?.status).toBe(429);
  });

  it('IP 不明なら KV に触れず通す (共有 bucket に寄せない)', async () => {
    h.limiterResult = { ok: true, value: 10_000 };
    const res = await route.call({});
    expect(limiterIncrCalls()).toEqual([]);
    expect(res?.status ?? 200).not.toBe(429);
  });

  it('IP_HASH_SECRET 欠落なら KV に触れず通す', async () => {
    vi.stubEnv('IP_HASH_SECRET', '');
    h.limiterResult = { ok: true, value: 10_000 };
    const res = await route.call(trusted('203.0.113.9'));
    expect(limiterIncrCalls()).toEqual([]);
    expect(res?.status ?? 200).not.toBe(429);
  });

  it('INCR の失敗は通す (fail-open)', async () => {
    h.limiterResult = { ok: false, reason: 'timeout' };
    const res = await route.call(trusted('203.0.113.9'));
    expect(limiterIncrCalls()).toHaveLength(1);
    expect(res?.status ?? 200).not.toBe(429);
  });
});

describe.each(prefixRoutes)('ip-prefix: $name', (route) => {
  const bucket = Math.floor(NOW / (route.windowSec * 1000));

  it.each([
    ['IPv4 (/24)', '203.0.113.9', '203.0.113.0/24'],
    ['IPv4-mapped IPv6 (/24)', '::ffff:203.0.113.9', '203.0.113.0/24'],
    ['IPv6 (/64)', '2001:db8:1234:5678::1', '2001:db8:1234:5678::/64'],
  ])('上限超過: %s の鍵と 429 応答 (EXPIRE は初回だけ)', async (_label, ip, prefix) => {
    h.limiterResult = { ok: true, value: route.max + 1 };
    const res = await route.call(trusted(ip));
    expect(limiterIncrCalls()).toEqual([[`rl:read:${route.key(prefix)}:${bucket}`]]);
    expect(limiterExpireCalls()).toEqual(route.max + 1 === 1 ? [[`rl:read:${route.key(prefix)}:${bucket}`, route.windowSec * 2]] : []);
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(route.deniedBody);
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it('初回 (カウント 1) は窓 2 つ分の EXPIRE を付けて通す', async () => {
    h.limiterResult = { ok: true, value: 1 };
    const res = await route.call(trusted('203.0.113.9'));
    const key = `rl:read:${route.key('203.0.113.0/24')}:${bucket}`;
    expect(limiterIncrCalls()).toEqual([[key]]);
    expect(limiterExpireCalls()).toEqual([[key, route.windowSec * 2]]);
    expect(res.status).not.toBe(429);
  });

  it('カウントが上限ちょうどなら通す', async () => {
    h.limiterResult = { ok: true, value: route.max };
    const res = await route.call(trusted('203.0.113.9'));
    expect(res.status).not.toBe(429);
  });

  it('窓は時計に揃う (次の分で bucket が変わる)', async () => {
    vi.setSystemTime(Math.ceil(NOW / 60_000) * 60_000);
    await route.call(trusted('203.0.113.9'));
    expect(limiterIncrCalls()).toEqual([[`rl:read:${route.key('203.0.113.0/24')}:${bucket + 1}`]]);
  });

  it('IP 不明は共有の unknown bucket に数える', async () => {
    h.limiterResult = { ok: true, value: route.max + 1 };
    const res = await route.call({});
    expect(limiterIncrCalls()).toEqual([[`rl:read:${route.key('unknown')}:${bucket}`]]);
    expect(res.status).toBe(429);
  });

  it('信頼できない cf-connecting-ip は無視し、接続元 (XFF) の prefix を使う', async () => {
    await route.call({ 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': '203.0.113.9' });
    expect(limiterIncrCalls()).toEqual([[`rl:read:${route.key('198.51.100.0/24')}:${bucket}`]]);
  });

  it('IP_HASH_SECRET は使わない (欠落でも同じ鍵で数える)', async () => {
    vi.stubEnv('IP_HASH_SECRET', '');
    await route.call(trusted('203.0.113.9'));
    expect(limiterIncrCalls()).toEqual([[`rl:read:${route.key('203.0.113.0/24')}:${bucket}`]]);
  });

  it('KV 未設定なら KV に触れず通す', async () => {
    h.kvConfigured = false;
    const res = await route.call(trusted('203.0.113.9'));
    expect(limiterIncrCalls()).toEqual([]);
    expect(res.status).not.toBe(429);
  });

  it('INCR の失敗は通す (fail-open)', async () => {
    h.limiterResult = { ok: false, reason: 'network_error' };
    const res = await route.call(trusted('203.0.113.9'));
    expect(limiterIncrCalls()).toHaveLength(1);
    expect(limiterExpireCalls()).toEqual([]);
    expect(res.status).not.toBe(429);
  });
});
