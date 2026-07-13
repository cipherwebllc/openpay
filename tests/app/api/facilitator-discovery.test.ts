// x402 facilitator 登録 (resources) + discovery route テスト。
// kv を in-memory モック、requireSession (SIWE) をモック、env を stub + resetModules で flag ON。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getAddress, type Hex } from 'viem';
import {
  merchantResourcesKey,
  resourceKey,
  MAX_RESOURCES_PER_MERCHANT,
} from '@/lib/x402/registry';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const STRANGER = getAddress('0x9999999999999999999999999999999999999999');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
const FIRST_PARTY_SELLER = getAddress('0x1234567890123456789012345678901234567890');

const store = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  failLrange: false, // true で kvLrange を fail させ登録数カウントの KV エラー枝を検証
  failSet: false, // true で kvSet を fail させ createResource の保存失敗 (503) を検証
  failEval: false, // true で kvEval を fail させ update/deactivate の storage エラー (503) を検証
}));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  kvGet: async (k: string) => ({ ok: true as const, value: store.kv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => {
    if (store.failSet) return { ok: false as const, reason: 'kv_error' };
    store.kv.set(k, v);
    return { ok: true as const, value: 'OK' as const };
  },
  kvLpush: async (k: string, v: string) => {
    const a = store.lists.get(k) ?? [];
    a.unshift(v);
    store.lists.set(k, a);
    return { ok: true as const, value: a.length };
  },
  kvLrange: async (k: string, start: number, stop: number) => {
    if (store.failLrange) return { ok: false as const, reason: 'kv_error' };
    const a = store.lists.get(k) ?? [];
    const end = stop < 0 ? a.length : stop + 1;
    return { ok: true as const, value: a.slice(start, end) };
  },
  // CAS_CREATE / CAS_UPDATE / CAS_DEACTIVATE (registry) の Lua セマンティクスを in-memory で再現。
  kvEval: async (script: string, keys: string[], args: string[]) => {
    if (store.failEval) return { ok: false as const, reason: 'kv_error' };
    // CAS_CREATE: LLEN(merchant index) cap 判定 + SET(resource) + LPUSH(discovery/merchant index)。
    if (script.includes("redis.call('LLEN'")) {
      const cap = Number(args[2]);
      const merchantList = store.lists.get(keys[2]) ?? [];
      if (merchantList.length >= cap) return { ok: true as const, value: -2 };
      store.kv.set(keys[0], args[0]);
      const idx = store.lists.get(keys[1]) ?? [];
      idx.unshift(args[1]);
      store.lists.set(keys[1], idx);
      merchantList.unshift(args[1]);
      store.lists.set(keys[2], merchantList);
      return { ok: true as const, value: 1 };
    }
    const raw = store.kv.get(keys[0]);
    if (raw === undefined) return { ok: true as const, value: -1 };
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw);
    } catch {
      return { ok: true as const, value: -2 };
    }
    if (typeof o !== 'object' || o === null || typeof o.merchant !== 'string') {
      return { ok: true as const, value: -2 };
    }
    if ((o.merchant as string).toLowerCase() !== args[0].toLowerCase()) {
      return { ok: true as const, value: 0 };
    }
    if (script.includes('o.url=ARGV[2]')) {
      if (o.active === false) return { ok: true as const, value: -3 }; // 削除済は編集不可
      o.url = args[1];
      o.description = args[2];
      o.priceJpyc = args[3];
      o.category = args[4];
      o.payTo = args[5];
      if (args[6]) o.docsUrl = args[6];
      else delete o.docsUrl;
      if (args[7]) o.license = args[7];
      else delete o.license;
      o.updatedAt = Number(args[8]);
      const enc = JSON.stringify(o);
      store.kv.set(keys[0], enc);
      return { ok: true as const, value: enc };
    }
    if (o.active === false) return { ok: true as const, value: 2 };
    o.active = false;
    store.kv.set(keys[0], JSON.stringify(o));
    return { ok: true as const, value: 1 };
  },
}));

const { mockRequireSession } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
}));
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: mockRequireSession,
}));

const resourceRate = vi.hoisted(() => ({
  allowed: true,
  check: vi.fn(),
}));
const ipRate = vi.hoisted(() => {
  const state = { allowed: true };
  return {
    state,
    check: vi.fn(
      async (_scope: string, hashedIp: string | null) =>
        hashedIp === null || state.allowed,
    ),
  };
});
vi.mock('@/lib/relay/relayGuards', () => ({
  checkReadRateLimit: (...args: unknown[]) => {
    resourceRate.check(...args);
    return Promise.resolve(resourceRate.allowed);
  },
  checkIpRateLimit: ipRate.check,
}));

const mockLoggerWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
  },
}));

// モデレーション probe をモック (実 fetch を避ける)。既定 false = ゲート済扱いで通す。
// isPrivateHost は parseResourceInput が使うため false (テスト URL は public 扱い) を返す。
const { mockFreelyAccessible, mockProbeGate } = vi.hoisted(() => ({
  mockFreelyAccessible: vi.fn(async () => false),
  mockProbeGate: vi.fn(
    async (): Promise<'openpay' | 'foreign' | 'unknown'> => 'unknown',
  ),
}));
vi.mock('@/lib/x402/moderation', () => ({
  isFreelyAccessible: mockFreelyAccessible,
  probeGate: mockProbeGate,
  isPrivateHost: () => false,
}));

type ResourcesMod = {
  GET: () => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
};

type RouteCtx = { params: Promise<{ id: string }> };
type IdRouteMod = {
  PATCH: (req: Request, ctx: RouteCtx) => Promise<Response>;
  DELETE: (req: Request, ctx: RouteCtx) => Promise<Response>;
};

function ctx(id: string): RouteCtx {
  return { params: Promise.resolve({ id }) };
}

async function load(flag = '1'): Promise<{
  resources: ResourcesMod;
  idRoute: IdRouteMod;
  discovery: () => Promise<Response>;
}> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', flag);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
  vi.stubEnv('X402_PAY_TO_ADDRESS', FIRST_PARTY_SELLER);
  vi.resetModules();
  const resources = (await import(
    '@/app/api/facilitator/resources/route'
  )) as ResourcesMod;
  const idRoute = (await import(
    '@/app/api/facilitator/resources/[id]/route'
  )) as IdRouteMod;
  const discovery = await import('@/app/api/discovery/route');
  return { resources, idRoute, discovery: discovery.GET as () => Promise<Response> };
}

function postReq(body: Record<string, unknown>, ip?: string): Request {
  return new Request('http://x/resources', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip ? { 'x-vercel-forwarded-for': ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

function patchReq(body: Record<string, unknown>, ip?: string): Request {
  return new Request('http://x/resources/id', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(ip ? { 'x-vercel-forwarded-for': ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

// validBody で 1 件登録し、採番された id を返す (owner=OWNER でサインイン済前提)。
async function seedOne(resources: ResourcesMod): Promise<string> {
  const res = await resources.POST(postReq(validBody));
  const body = (await res.json()) as { resource: { id: string } };
  return body.resource.id;
}

const validBody = {
  url: 'https://api.example.jp/paid/translate',
  description: 'JP→EN 翻訳 API',
  priceJpyc: '1000',
  category: 'api',
  docsUrl: 'https://docs.example.jp/openapi.json',
  license: 'Commercial use with attribution.',
  attested: true, // 新規登録は正当性表明が必須
};

beforeEach(() => {
  store.kv.clear();
  store.lists.clear();
  store.failLrange = false;
  store.failSet = false;
  store.failEval = false;
  mockRequireSession.mockReset();
  resourceRate.allowed = true;
  resourceRate.check.mockReset();
  ipRate.state.allowed = true;
  ipRate.check.mockClear();
  mockLoggerWarn.mockReset();
  mockFreelyAccessible.mockReset();
  mockFreelyAccessible.mockResolvedValue(false); // 既定: ゲート済 (通す)
  mockProbeGate.mockReset();
  mockProbeGate.mockResolvedValue('unknown'); // 既定: 判定不能 = fail-open (通す)
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('x402 facilitator /resources', () => {
  it('flag OFF → POST/GET 404', async () => {
    const { resources } = await load('');
    expect((await resources.POST(postReq(validBody))).status).toBe(404);
    expect((await resources.GET()).status).toBe(404);
    expect(ipRate.check).not.toHaveBeenCalled();
  });

  it('IP rate limit → session lookup 前に 429 + Retry-After', async () => {
    vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');
    const { resources } = await load();
    ipRate.state.allowed = false;

    const res = await resources.POST(postReq(validBody, '203.0.113.20'));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(ipRate.check).toHaveBeenCalledWith(
      'x402-resource-write',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      30,
      60,
    );
    expect(mockRequireSession).not.toHaveBeenCalled();
  });

  it('未認証 → 401 (requireSession)', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }),
    });
    expect((await resources.POST(postReq(validBody))).status).toBe(401);
  });

  it('認証 + 正常 → 201 + resource + paywallSnippet (owner=session)', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const res = await resources.POST(postReq(validBody));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      resource: {
        merchant: string;
        url: string;
        priceJpyc: string;
        docsUrl?: string;
        license?: string;
        updatedAt?: number;
        active: boolean;
      };
      paywallSnippet: string;
    };
    expect(getAddress(body.resource.merchant)).toBe(OWNER);
    expect(body.resource.url).toBe(validBody.url);
    expect(body.resource.priceJpyc).toBe('1000');
    expect(body.resource.docsUrl).toBe(validBody.docsUrl);
    expect(body.resource.license).toBe(validBody.license);
    expect(body.resource.updatedAt).toEqual(expect.any(Number));
    expect(body.resource.active).toBe(true);
    // 自己完結ゲート: リポ内 import を含まず、verify/settle 転送を含む
    expect(body.paywallSnippet).not.toContain('@/lib');
    expect(body.paywallSnippet).toContain("'verify'");
    expect(body.paywallSnippet).toContain(validBody.url);
  });

  it('無料公開 URL (probe が 200) → 400 resource_not_gated', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    mockFreelyAccessible.mockResolvedValue(true); // 誰でも無料取得できる = 拒否対象
    const secret = 'Bearer-should-not-leak';
    const url = `https://hooks.example.com/api/webhooks/${secret}?token=${secret}`;
    const res = await resources.POST(postReq({ ...validBody, url }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('resource_not_gated');
    const [, fields] = mockLoggerWarn.mock.calls.find(
      ([event]) => event === 'x402.facilitator.resource_not_gated',
    )!;
    expect(fields).toMatchObject({
      resourceOrigin: 'https://hooks.example.com',
      resourceHash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(JSON.stringify(fields)).not.toContain(secret);
    expect(fields).not.toHaveProperty('url');
  });

  it('wallet rate limit → probe/body parse 前に 429 + Retry-After', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    resourceRate.allowed = false;

    const res = await resources.POST(postReq(validBody));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(resourceRate.check).toHaveBeenCalledWith(
      `x402res:${OWNER.toLowerCase()}`,
      10,
      60,
    );
    expect(mockFreelyAccessible).not.toHaveBeenCalled();
    expect(mockProbeGate).not.toHaveBeenCalled();
  });

  it('正当性表明なし (attested 欠如) → 400 attestation_required', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const { attested: _omit, ...noAttest } = validBody;
    void _omit;
    const res = await resources.POST(postReq(noAttest));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('attestation_required');
  });

  it('認証 + 不正 url → 400 invalid_url', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const res = await resources.POST(postReq({ ...validBody, url: 'ftp://x' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_url');
  });

  it('GET → owner の登録一覧を返す', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    await resources.POST(postReq(validBody));
    const res = await resources.GET();
    const body = (await res.json()) as { resources: Array<{ url: string }> };
    expect(body.resources.map((r) => r.url)).toContain(validBody.url);
  });

  it('登録数カウントの KV エラー → 503 (上限 bypass させない)', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    store.failLrange = true;
    expect((await resources.POST(postReq(validBody))).status).toBe(503);
  });

  it('GET 一覧の KV エラー → 503 (空一覧と誤認させない)', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    store.failLrange = true;
    expect((await resources.GET()).status).toBe(503);
  });

  it('不正 JSON → 400 invalid_json', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const bad = new Request('http://x/resources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await resources.POST(bad);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_json');
  });

  it('8KiB 超 body → 413 payload_too_large (rate limit 後・parse 前)', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const res = await resources.POST(
      postReq({ ...validBody, padding: 'x'.repeat(9 * 1024) }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(resourceRate.check).toHaveBeenCalledOnce();
    expect(mockFreelyAccessible).not.toHaveBeenCalled();
  });

  it('登録上限到達 → 429 too_many_resources', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    // owner の登録 index を上限ぶん埋める (countMerchantResources が上限を返す)。
    store.lists.set(
      merchantResourcesKey(OWNER),
      Array(MAX_RESOURCES_PER_MERCHANT).fill('x'),
    );
    const res = await resources.POST(postReq(validBody));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('too_many_resources');
  });

  it('境界: 上限 -1 件なら登録できる (201)', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    store.lists.set(
      merchantResourcesKey(OWNER),
      Array(MAX_RESOURCES_PER_MERCHANT - 1).fill('x'),
    );
    expect((await resources.POST(postReq(validBody))).status).toBe(201);
  });

  it('KV 保存失敗 (createResource storage) → 503 storage_unavailable', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    store.failEval = true; // createResource は CAS_CREATE (kvEval) で原子保存する
    const res = await resources.POST(postReq(validBody));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('storage_unavailable');
  });
});

describe('x402 facilitator /resources/[id] PATCH (編集)', () => {
  it('flag OFF → 404 (session 不要で弾く)', async () => {
    const { idRoute } = await load('');
    const res = await idRoute.PATCH(patchReq(validBody), ctx('id1'));
    expect(res.status).toBe(404);
  });

  it('IP rate limit → session/owner lookup 前に 429 + Retry-After', async () => {
    vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');
    const { idRoute } = await load();
    ipRate.state.allowed = false;

    const res = await idRoute.PATCH(
      patchReq(validBody, '203.0.113.21'),
      ctx('id1'),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(ipRate.check).toHaveBeenCalledWith(
      'x402-resource-write',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      30,
      60,
    );
    expect(mockRequireSession).not.toHaveBeenCalled();
  });

  it('未認証 → 401', async () => {
    const { idRoute } = await load();
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }),
    });
    expect((await idRoute.PATCH(patchReq(validBody), ctx('id1'))).status).toBe(401);
  });

  it('owner が編集 → 200 + 更新後 resource', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    const res = await idRoute.PATCH(
      patchReq({ ...validBody, description: '更新後', priceJpyc: '2000' }),
      ctx(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: { description: string; priceJpyc: string } };
    expect(body.resource.description).toBe('更新後');
    expect(body.resource.priceJpyc).toBe('2000');
  });

  it('編集は公開カタログに反映される', async () => {
    const { resources, idRoute, discovery } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    await idRoute.PATCH(patchReq({ ...validBody, priceJpyc: '3000' }), ctx(id));
    const body = (await (await discovery()).json()) as {
      items: Array<{ resource: string; priceJpyc: string }>;
    };
    expect(body.items.find((i) => i.resource === validBody.url)?.priceJpyc).toBe('3000');
  });

  it('他人の掲載 → 403 (owner-auth)', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    mockRequireSession.mockResolvedValue({ ok: true, address: STRANGER });
    resourceRate.check.mockClear();
    expect((await idRoute.PATCH(patchReq(validBody), ctx(id))).status).toBe(403);
    expect(resourceRate.check).not.toHaveBeenCalled();
  });

  it('存在しない id → 404', async () => {
    const { idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    expect((await idRoute.PATCH(patchReq(validBody), ctx('nope'))).status).toBe(404);
  });

  it('不正 url → 400 invalid_url', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    const res = await idRoute.PATCH(patchReq({ ...validBody, url: 'ftp://x' }), ctx(id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_url');
  });

  it('不正 JSON → 400 invalid_json', async () => {
    const { idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const bad = new Request('http://x/resources/id', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await idRoute.PATCH(bad, ctx('id1'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_json');
  });

  it('owner の 8KiB 超 PATCH body → 413 (probe 前)', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    resourceRate.check.mockClear();
    mockFreelyAccessible.mockClear();
    const res = await idRoute.PATCH(
      patchReq({ ...validBody, padding: 'x'.repeat(9 * 1024) }),
      ctx(id),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(resourceRate.check).toHaveBeenCalledOnce();
    expect(mockFreelyAccessible).not.toHaveBeenCalled();
  });

  it('soft-delete 済の編集 → 404 (監査データ保護)', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    await idRoute.DELETE(new Request('http://x'), ctx(id));
    const res = await idRoute.PATCH(patchReq({ ...validBody, priceJpyc: '9999' }), ctx(id));
    expect(res.status).toBe(404);
  });

  it('編集で無料公開 URL に差し替え → 400 resource_not_gated', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    mockFreelyAccessible.mockResolvedValue(true); // 差し替え先が誰でも無料取得できる
    const res = await idRoute.PATCH(patchReq(validBody), ctx(id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('resource_not_gated');
  });

  it('owner の PATCH wallet rate limit → probe 前に 429 + Retry-After', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    resourceRate.check.mockClear();
    mockFreelyAccessible.mockClear();
    mockProbeGate.mockClear();
    resourceRate.allowed = false;

    const res = await idRoute.PATCH(patchReq(validBody), ctx(id));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(resourceRate.check).toHaveBeenCalledWith(
      `x402res:${OWNER.toLowerCase()}`,
      10,
      60,
    );
    expect(mockFreelyAccessible).not.toHaveBeenCalled();
    expect(mockProbeGate).not.toHaveBeenCalled();
  });

  it('非 owner の PATCH は moderation probe を実行しない (SSRF 踏み台化防止)', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    mockFreelyAccessible.mockClear();
    mockRequireSession.mockResolvedValue({ ok: true, address: STRANGER });
    mockFreelyAccessible.mockResolvedValue(true); // 呼ばれたら probe された証拠
    const res = await idRoute.PATCH(patchReq(validBody), ctx(id));
    expect(res.status).toBe(403); // owner-auth が probe より先に弾く
    expect(mockFreelyAccessible).not.toHaveBeenCalled();
  });

  it('編集の CAS が KV エラー → 503 storage_unavailable (未存在と誤魔化さない)', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    store.failEval = true;
    const res = await idRoute.PATCH(patchReq({ ...validBody, priceJpyc: '2000' }), ctx(id));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('storage_unavailable');
  });
});

describe('x402 facilitator /resources/[id] DELETE (無効化)', () => {
  it('flag OFF → 404', async () => {
    const { idRoute } = await load('');
    expect((await idRoute.DELETE(new Request('http://x'), ctx('id1'))).status).toBe(404);
  });

  it('未認証 → 401', async () => {
    const { idRoute } = await load();
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }),
    });
    expect((await idRoute.DELETE(new Request('http://x'), ctx('id1'))).status).toBe(401);
  });

  it('owner が無効化 → 200 {ok} + 公開カタログから消える', async () => {
    const { resources, idRoute, discovery } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    const res = await idRoute.DELETE(new Request('http://x'), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const body = (await (await discovery()).json()) as { items: Array<{ resource: string }> };
    expect(body.items.map((i) => i.resource)).not.toContain(validBody.url);
  });

  it('冪等: 2 回目も 200', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    await idRoute.DELETE(new Request('http://x'), ctx(id));
    expect((await idRoute.DELETE(new Request('http://x'), ctx(id))).status).toBe(200);
  });

  it('他人の掲載 → 403', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    mockRequireSession.mockResolvedValue({ ok: true, address: STRANGER });
    expect((await idRoute.DELETE(new Request('http://x'), ctx(id))).status).toBe(403);
  });

  it('存在しない id → 404', async () => {
    const { idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    expect((await idRoute.DELETE(new Request('http://x'), ctx('nope'))).status).toBe(404);
  });

  it('無効化の CAS が KV エラー → 503 storage_unavailable', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    store.failEval = true;
    const res = await idRoute.DELETE(new Request('http://x'), ctx(id));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('storage_unavailable');
  });
});

describe('x402 /discovery', () => {
  it('flag OFF → 404', async () => {
    const { discovery } = await load('');
    expect((await discovery()).status).toBe(404);
  });

  it('KV エラー → 503 (空カタログと誤認/キャッシュさせない・無 Cache-Control)', async () => {
    const { discovery } = await load();
    store.failLrange = true; // index 読取が失敗
    const res = await discovery();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('storage_unavailable');
    expect(res.headers.get('cache-control')).toBeNull(); // 503 は edge に焼き付けない
  });

  it('登録済 resource を accepts (fee 込み PaymentRequirements) 付きで列挙', async () => {
    const { resources, discovery } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    await resources.POST(postReq(validBody));

    const res = await discovery();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      x402Version: number;
      items: Array<{
        resource: string;
        priceJpyc: string;
        docsUrl?: string;
        license?: string;
        updatedAt?: string;
        accepts: Array<{
          scheme: string;
          network: string;
          maxAmountRequired: string;
          extra: { openpay: { merchantValue: string; feeValue: string } };
        }>;
      }>;
    };
    expect(body.items).toHaveLength(3);
    const item = body.items.find((i) => i.resource === validBody.url);
    expect(item).toBeTruthy();
    if (!item) return;
    expect(item.resource).toBe(validBody.url);
    expect(item.docsUrl).toBe(validBody.docsUrl);
    expect(item.license).toBe(validBody.license);
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item.accepts).toHaveLength(1);
    const pr = item.accepts[0];
    expect(pr.scheme).toBe('exact');
    expect(pr.network).toBe('eip155:80002');
    // 1000 JPYC + 1% (10 JPYC) = 1010 JPYC 総額。
    expect(pr.extra.openpay.merchantValue).toBe((1000n * 10n ** 18n).toString());
    expect(pr.extra.openpay.feeValue).toBe((10n * 10n ** 18n).toString());
    expect(pr.maxAmountRequired).toBe((1010n * 10n ** 18n).toString());
  });

  it('旧 record に比較メタデータが無ければ discovery item でも省略する', async () => {
    const { resources, discovery } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    const saved = JSON.parse(store.kv.get(resourceKey(id))!) as Record<string, unknown>;
    delete saved.docsUrl;
    delete saved.license;
    delete saved.updatedAt;
    store.kv.set(resourceKey(id), JSON.stringify(saved));

    const body = (await (await discovery()).json()) as {
      items: Array<Record<string, unknown>>;
    };
    const item = body.items.find((candidate) => candidate.resource === validBody.url);
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty('docsUrl');
    expect(item).not.toHaveProperty('license');
    expect(item).not.toHaveProperty('updatedAt');
  });

  it('不正 priceJpyc の resource → accepts=[] で列挙 (カタログ自体は出す)', async () => {
    const { resources, discovery } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    // 保存済 record の priceJpyc を壊す: BigInt('abc') が throw → route の catch → accepts=[]。
    const rec = JSON.parse(store.kv.get(resourceKey(id))!) as { priceJpyc: string };
    rec.priceJpyc = 'abc';
    store.kv.set(resourceKey(id), JSON.stringify(rec));
    const body = (await (await discovery()).json()) as {
      items: Array<{ priceJpyc: string; accepts: unknown[] }>;
    };
    expect(body.items).toHaveLength(3);
    const item = body.items.find((i) => i.priceJpyc === 'abc');
    expect(item).toBeTruthy();
    expect(item?.accepts).toEqual([]); // 不正 price は accepts 生成不能 → 空
  });

  it('foreign ゲート (USDC 等の 402) の URL は 422 gate_not_openpay + スニペット同梱で拒否', async () => {
    const { resources } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    mockProbeGate.mockResolvedValueOnce('foreign');
    const res = await resources.POST(postReq(validBody));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; paywallSnippet?: string };
    expect(body.error).toBe('gate_not_openpay');
    // 鶏卵解決: 拒否応答にコピペで動くゲートを同梱する
    expect(body.paywallSnippet).toContain(validBody.url);
    expect(body.paywallSnippet).toContain("'verify'");
  });

  it('KV 空でも first-party resource 2 件を先頭に返す', async () => {
    const { discovery } = await load();
    const body = (await (await discovery()).json()) as {
      x402Version: number;
      items: Array<{
        resource: string;
        priceJpyc: string;
        docsUrl: string;
        license: string;
        accepts: Array<{ extra: { openpay: { merchant: string; merchantValue: string; feeValue: string } } }>;
      }>;
    };
    expect(body.x402Version).toBe(1);
    expect(body.items.map((i) => i.resource)).toEqual([
      'https://open-pay.jp/api/paid/demo',
      'https://open-pay.jp/api/paid/stores',
    ]);
    expect(body.items[0].priceJpyc).toBe('1');
    expect(body.items.every((item) => item.docsUrl === 'https://open-pay.jp/api/openapi.json')).toBe(true);
    expect(body.items.every((item) => item.license.length > 0 && item.license.length <= 60)).toBe(true);
    expect(body.items[0].accepts[0].extra.openpay.merchant).toBe(FIRST_PARTY_SELLER);
    expect(body.items[0].accepts[0].extra.openpay.merchantValue).toBe(
      (1n * 10n ** 18n).toString(),
    );
    expect(body.items[0].accepts[0].extra.openpay.feeValue).toBe(
      (2n * 10n ** 18n).toString(),
    );
  });

  it('X402_PAY_TO_ADDRESS 未設定 → first-party は非掲載 (壊れた accepts を並べない)・KV 分は不変', async () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
    vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
    vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
    vi.stubEnv('X402_FEE_BPS', '100');
    vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
    vi.stubEnv('X402_PAY_TO_ADDRESS', '');
    vi.resetModules();
    const discovery = await import('@/app/api/discovery/route');
    const body = (await (await (discovery.GET as () => Promise<Response>)()).json()) as {
      items: Array<{ resource: string }>;
    };
    // 直前の it は同一 KV 空状態 + payTo 設定ありで first-party 2 件を検証している。
    // payTo 未設定では 0 件 = 非掲載が成立する。
    expect(body.items).toEqual([]);
  });

  it('first-party requirements 生成失敗は accepts:[] で掲載せず即時除外', async () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', '');
    vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
    vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
    vi.stubEnv('X402_PAY_TO_ADDRESS', FIRST_PARTY_SELLER);
    vi.resetModules();
    const discovery = await import('@/app/api/discovery/route');
    const body = (await (await discovery.GET()).json()) as {
      items: Array<{ resource: string; accepts: unknown[] }>;
    };
    expect(body.items).toEqual([]);
  });

  it('first-party hidden state は公開 discovery だけから除外し、source URL 一致時だけ verifiedAt を出す', async () => {
    const { discovery } = await load();
    const demoUrl = 'https://open-pay.jp/api/paid/demo';
    store.kv.set(
      'x402:fpverify:/api/paid/demo',
      JSON.stringify({
        hidden: true,
        verification: {
          lastOkAt: '2026-07-14T00:00:00.000Z',
          lastCheckedAt: '2026-07-14T02:00:00.000Z',
          failures: 3,
          lastRunId: '2026071402',
          probedUrl: demoUrl,
        },
      }),
    );
    store.kv.set(
      'x402:fpverify:/api/paid/stores',
      JSON.stringify({
        hidden: false,
        verification: {
          lastOkAt: '2026-07-14T01:00:00.000Z',
          lastCheckedAt: '2026-07-14T01:00:00.000Z',
          failures: 0,
          lastRunId: '2026071401',
          probedUrl: 'https://open-pay.jp/api/paid/stores',
        },
      }),
    );
    const body = (await (await discovery()).json()) as {
      items: Array<{ resource: string; verifiedAt: string | null }>;
    };
    expect(body.items.map((item) => item.resource)).toEqual([
      'https://open-pay.jp/api/paid/stores',
    ]);
    expect(body.items[0].verifiedAt).toBe('2026-07-14T01:00:00.000Z');
  });

  it('複数登録は新しい順 (LPUSH) で列挙される', async () => {
    const { resources, discovery } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    await resources.POST(
      postReq({ ...validBody, url: 'https://api.example.jp/paid/first', description: '1番目' }),
    );
    await resources.POST(
      postReq({ ...validBody, url: 'https://api.example.jp/paid/second', description: '2番目' }),
    );
    const body = (await (await discovery()).json()) as {
      items: Array<{ resource: string }>;
    };
    expect(body.items.map((i) => i.resource)).toEqual([
      'https://open-pay.jp/api/paid/demo',
      'https://open-pay.jp/api/paid/stores',
      'https://api.example.jp/paid/second',
      'https://api.example.jp/paid/first',
    ]);
  });

  it('外部 hidden resource は discovery から除外するが owner 一覧には残す', async () => {
    const { resources, discovery } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    const saved = JSON.parse(store.kv.get(resourceKey(id))!) as Record<string, unknown>;
    saved.hidden = true;
    saved.verification = {
      lastCheckedAt: '2026-07-14T02:00:00.000Z',
      failures: 3,
      lastRunId: '2026071402',
      probedUrl: validBody.url,
    };
    store.kv.set(resourceKey(id), JSON.stringify(saved));

    const publicBody = (await (await discovery()).json()) as {
      items: Array<{ resource: string }>;
    };
    expect(publicBody.items.map((item) => item.resource)).not.toContain(validBody.url);
    const ownerBody = (await (await resources.GET()).json()) as {
      resources: Array<{ id: string; hidden?: boolean }>;
    };
    expect(ownerBody.resources).toContainEqual(expect.objectContaining({ id, hidden: true }));
  });

  it('多数登録 (>RESOLVE_CONCURRENCY) でもバッチ跨ぎで新しい順を完全維持', async () => {
    // resolveIds は同時数を 25 に制限するチャンク並列。境界 (25) を跨いでも index の新しい順
    // (LPUSH) が保たれることを 30 件で検証する (バッチ並列で順序が壊れない回帰ガード)。
    const { resources, discovery } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const N = 30;
    for (let i = 0; i < N; i++) {
      await resources.POST(
        postReq({ ...validBody, url: `https://api.example.jp/paid/r${i}`, description: `r${i}` }),
      );
    }
    const body = (await (await discovery()).json()) as { items: Array<{ resource: string }> };
    expect(body.items).toHaveLength(N + 2);
    // 完全な逆順 (最後に登録した r29 が先頭・r0 が末尾)。
    expect(body.items.slice(2).map((i) => i.resource)).toEqual(
      Array.from({ length: N }, (_, i) => `https://api.example.jp/paid/r${N - 1 - i}`),
    );
  });

  it('200 応答は edge キャッシュ可能 (Cache-Control s-maxage)', async () => {
    const { discovery } = await load();
    const res = await discovery();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=10, stale-while-revalidate=30',
    );
  });

  it('flag OFF (404) は Cache-Control を付けない', async () => {
    const { discovery } = await load('');
    const res = await discovery();
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('OpenAPI は discovery item の比較フィールドを optional schema として定義する', async () => {
    await load();
    const openapi = await import('@/app/api/openapi.json/route');
    const res = await openapi.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      paths: Record<string, unknown>;
      components: {
        schemas: Record<
          string,
          { required?: string[]; properties?: Record<string, Record<string, unknown>> }
        >;
      };
    };
    expect(body.paths).toHaveProperty('/api/discovery');
    const schema = body.components.schemas.DiscoveryItem;
    expect(schema.properties).toMatchObject({
      docsUrl: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 512 },
      license: { type: 'string', maxLength: 60 },
      updatedAt: { type: 'string', format: 'date-time' },
      verifiedAt: { type: ['string', 'null'], format: 'date-time' },
    });
    expect(schema.required).not.toEqual(expect.arrayContaining(['docsUrl', 'license', 'updatedAt']));
  });
});
