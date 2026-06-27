// x402 facilitator 登録 (resources) + discovery route テスト。
// kv を in-memory モック、requireSession (SIWE) をモック、env を stub + resetModules で flag ON。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getAddress, type Hex } from 'viem';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const STRANGER = getAddress('0x9999999999999999999999999999999999999999');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');

const store = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  failLrange: false, // true で kvLrange を fail させ登録数カウントの KV エラー枝を検証
}));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  kvGet: async (k: string) => ({ ok: true as const, value: store.kv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => {
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
  // CAS_UPDATE / CAS_DEACTIVATE (registry) の Lua セマンティクスを in-memory で再現 (script で分岐)。
  kvEval: async (script: string, keys: string[], args: string[]) => {
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

function postReq(body: Record<string, unknown>): Request {
  return new Request('http://x/resources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchReq(body: Record<string, unknown>): Request {
  return new Request('http://x/resources/id', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
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
};

beforeEach(() => {
  store.kv.clear();
  store.lists.clear();
  store.failLrange = false;
  mockRequireSession.mockReset();
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
      resource: { merchant: string; url: string; priceJpyc: string; active: boolean };
      paywallSnippet: string;
    };
    expect(getAddress(body.resource.merchant)).toBe(OWNER);
    expect(body.resource.url).toBe(validBody.url);
    expect(body.resource.priceJpyc).toBe('1000');
    expect(body.resource.active).toBe(true);
    expect(body.paywallSnippet).toContain('createJpycPaymentRequirements');
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
});

describe('x402 facilitator /resources/[id] PATCH (編集)', () => {
  it('flag OFF → 404 (session 不要で弾く)', async () => {
    const { idRoute } = await load('');
    const res = await idRoute.PATCH(patchReq(validBody), ctx('id1'));
    expect(res.status).toBe(404);
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
    const body = (await (await discovery()).json()) as { items: Array<{ priceJpyc: string }> };
    expect(body.items[0].priceJpyc).toBe('3000');
  });

  it('他人の掲載 → 403 (owner-auth)', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    mockRequireSession.mockResolvedValue({ ok: true, address: STRANGER });
    expect((await idRoute.PATCH(patchReq(validBody), ctx(id))).status).toBe(403);
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

  it('soft-delete 済の編集 → 404 (監査データ保護)', async () => {
    const { resources, idRoute } = await load();
    mockRequireSession.mockResolvedValue({ ok: true, address: OWNER });
    const id = await seedOne(resources);
    await idRoute.DELETE(new Request('http://x'), ctx(id));
    const res = await idRoute.PATCH(patchReq({ ...validBody, priceJpyc: '9999' }), ctx(id));
    expect(res.status).toBe(404);
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
    const body = (await (await discovery()).json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
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
});

describe('x402 /discovery', () => {
  it('flag OFF → 404', async () => {
    const { discovery } = await load('');
    expect((await discovery()).status).toBe(404);
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
        accepts: Array<{
          scheme: string;
          network: string;
          maxAmountRequired: string;
          extra: { openpay: { merchantValue: string; feeValue: string } };
        }>;
      }>;
    };
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.resource).toBe(validBody.url);
    expect(item.accepts).toHaveLength(1);
    const pr = item.accepts[0];
    expect(pr.scheme).toBe('exact');
    expect(pr.network).toBe('eip155:80002');
    // 1000 JPYC + 1% (10 JPYC) = 1010 JPYC 総額。
    expect(pr.extra.openpay.merchantValue).toBe((1000n * 10n ** 18n).toString());
    expect(pr.extra.openpay.feeValue).toBe((10n * 10n ** 18n).toString());
    expect(pr.maxAmountRequired).toBe((1010n * 10n ** 18n).toString());
  });
});
