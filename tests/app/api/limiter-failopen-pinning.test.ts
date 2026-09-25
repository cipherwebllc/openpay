// @vitest-environment node
// B-R6e: R6a (#613) と同じ実 KV transport で throw/reject を注入する。
// R6b wrapper / IP 処理 / logger も実物。limiter の no-throw / fail-open を route ごとに固定する。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const h = vi.hoisted(() => ({
  session: vi.fn(),
  send: vi.fn(),
  listSubscriptions: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  listMessages: vi.fn(),
  deleteMessages: vi.fn(),
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: {
    ...actual.env,
    enablePushNotify: true,
    pushVapidPublicKey: 'test-public-key',
    enableTipMessage: true,
  } };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({ requireSession: h.session }));
vi.mock('@/lib/push/server', () => ({ sendPushToWallet: h.send }));
vi.mock('@/lib/push/store', () => ({
  listPushSubscriptions: h.listSubscriptions,
  upsertPushSubscription: h.upsert,
  removePushSubscription: h.remove,
}));
vi.mock('@/lib/tipMessages', () => ({
  listTipMessages: h.listMessages,
  deleteTipMessages: h.deleteMessages,
}));

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ENDPOINT_HASH = 'a'.repeat(64);
const SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/sub/1',
  keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
};
const SUMMARY = { attempted: 1, sent: 1, pruned: 0, failed: 0 };
const fetchMock = vi.fn();
const failures = [
  { name: 'throw', fail: () => { throw new Error('KV offline'); } },
  { name: 'reject', fail: () => Promise.reject(new Error('KV offline')) },
];

type Route = {
  name: string;
  method: string;
  body?: unknown;
  call: (req: Request) => Promise<Response>;
  result: unknown;
  effect: typeof h.send;
  command: string;
};
const routes: Route[] = [
  {
    name: 'push/test', method: 'POST',
    call: async (req) => (await import('@/app/api/push/test/route')).POST(req),
    result: { ok: true, ...SUMMARY }, effect: h.send, command: 'INCR',
  },
  {
    name: 'push/subscribe', method: 'GET',
    call: async (req) => (await import('@/app/api/push/subscribe/route')).GET(req),
    result: { subscribed: true, includeAmount: true }, effect: h.listSubscriptions, command: 'INCR',
  },
  {
    name: 'push/subscribe', method: 'POST', body: { subscription: SUBSCRIPTION, locale: 'ja' },
    call: async (req) => (await import('@/app/api/push/subscribe/route')).POST(req),
    result: { ok: true, count: 1 }, effect: h.upsert, command: 'INCR',
  },
  {
    name: 'push/subscribe', method: 'DELETE', body: { endpoint: SUBSCRIPTION.endpoint },
    call: async (req) => (await import('@/app/api/push/subscribe/route')).DELETE(req),
    result: { ok: true, count: 0 }, effect: h.remove, command: 'INCR',
  },
  {
    name: 'tip-messages', method: 'GET',
    call: async (req) => (await import('@/app/api/tip-messages/route')).GET(req),
    result: { items: [] }, effect: h.listMessages, command: 'EVAL',
  },
  {
    name: 'tip-messages', method: 'DELETE',
    call: async (req) => (await import('@/app/api/tip-messages/route')).DELETE(req),
    result: { ok: true }, effect: h.deleteMessages, command: 'EVAL',
  },
];

function request(route: Pick<Route, 'name' | 'method' | 'body'>): Request {
  return new Request(`https://test.local/api/${route.name}?endpointHash=${ENDPOINT_HASH}`, {
    method: route.method,
    headers: {
      'content-type': 'application/json',
      'x-vercel-forwarded-for': '203.0.113.9',
    },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  });
}
function commands(): unknown[][] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://r6e-kv.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'r6e-test-token');
  vi.stubEnv('KV_REST_API_URL', '');
  vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');
  vi.stubGlobal('fetch', fetchMock);
  h.session.mockResolvedValue({ ok: true, address: OWNER });
  h.send.mockResolvedValue(SUMMARY);
  h.listSubscriptions.mockResolvedValue({ ok: true, value: [{ endpointHash: ENDPOINT_HASH, includeAmount: true }] });
  h.upsert.mockResolvedValue({ ok: true, value: [SUBSCRIPTION] });
  h.remove.mockResolvedValue({ ok: true, value: [] });
  h.listMessages.mockResolvedValue([]);
  h.deleteMessages.mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(routes)('B-R6e $method /api/$name', (route) => {
  it.each(failures)('limiter transport $name でも owner 本体の応答を保つ', async ({ fail }) => {
    fetchMock.mockImplementation(fail);
    const response = await route.call(request(route));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(route.result);
    expect(h.session).toHaveBeenCalledOnce();
    expect(route.effect.mock.calls[0][0]).toBe(OWNER);
    if (route.name === 'tip-messages') {
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(commands().map(([command]) => command)).toEqual([route.command]);
  });

  if (route.command === 'INCR') {
    it.each(failures)('初回 TTL の transport $name でも本体を止めない', async ({ fail }) => {
      fetchMock.mockImplementation(fail).mockResolvedValueOnce(new Response('{"result":1}'));
      const response = await route.call(request(route));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(route.result);
      expect(commands().map(([command]) => command)).toEqual(['INCR', 'EXPIRE']);
    });
  }
});

describe('B-R6e store seller address limiter', () => {
  it.each(failures)('IP/address limiter transport $name でも SIWE owner を返す', async ({ fail }) => {
    fetchMock.mockImplementation(fail);
    const { requireStoreSeller } = await import('@/app/api/store/_shared');
    await expect(requireStoreSeller(request({ name: 'store/products', method: 'GET' }), 'products-read'))
      .resolves.toEqual({ ok: true, address: OWNER });
    expect(commands().map(([command]) => command)).toEqual(['EVAL', 'INCR']);
    expect(commands()[1][1]).toMatch(new RegExp(`^rl:read:creator-store:products-read:${OWNER.toLowerCase()}:\\d+$`));
    expect(h.session).toHaveBeenCalledOnce();
  });

  it.each(failures)('address TTL transport $name でも SIWE owner を返す', async ({ fail }) => {
    fetchMock.mockImplementation(fail)
      .mockResolvedValueOnce(new Response('{"result":1}'))
      .mockResolvedValueOnce(new Response('{"result":1}'));
    const { requireStoreSeller } = await import('@/app/api/store/_shared');
    await expect(requireStoreSeller(request({ name: 'store/products', method: 'GET' }), 'products-read'))
      .resolves.toEqual({ ok: true, address: OWNER });
    expect(commands().map(([command]) => command)).toEqual(['EVAL', 'INCR', 'EXPIRE']);
  });

  it.each([401, 503])('limiter 障害でも session の %i を許可へ変えない', async (status) => {
    fetchMock.mockRejectedValue(new Error('KV offline'));
    const body = { ok: false, error: status === 401 ? 'unauthenticated' : 'session_storage_unavailable' };
    h.session.mockResolvedValue({ ok: false, response: NextResponse.json(body, { status }) });
    const { requireStoreSeller } = await import('@/app/api/store/_shared');
    const auth = await requireStoreSeller(request({ name: 'store/products', method: 'GET' }), 'products-read');
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error('session must remain required');
    expect(auth.response.status).toBe(status);
    expect(await auth.response.json()).toEqual(body);
    expect(auth.response.headers.get('cache-control')).toBe('private, no-store');
    expect(auth.response.headers.get('vary')).toBe('Cookie');
    expect(commands().map(([command]) => command)).toEqual(['EVAL']);
  });
});
