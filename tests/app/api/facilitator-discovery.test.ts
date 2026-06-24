// x402 facilitator 登録 (resources) + discovery route テスト。
// kv を in-memory モック、requireSession (SIWE) をモック、env を stub + resetModules で flag ON。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getAddress, type Hex } from 'viem';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');

const store = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  lists: new Map<string, string[]>(),
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
    const a = store.lists.get(k) ?? [];
    const end = stop < 0 ? a.length : stop + 1;
    return { ok: true as const, value: a.slice(start, end) };
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

async function load(flag = '1'): Promise<{
  resources: ResourcesMod;
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
  const discovery = await import('@/app/api/discovery/route');
  return { resources, discovery: discovery.GET as () => Promise<Response> };
}

function postReq(body: Record<string, unknown>): Request {
  return new Request('http://x/resources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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
