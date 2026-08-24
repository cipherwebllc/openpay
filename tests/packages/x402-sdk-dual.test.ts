// createDualGate / createListingClient (packages/x402-sdk) の unit テスト。
// 検証の柱: (1) USDC 面の障害は JPYC のみへ degrade (本体を止めない)、(2) レール振り分け
// (PAYMENT-SIGNATURE / x-payment の network) とリレー中継、(3) 402 への USDC accepts 追記、
// (4) listing client の attested 明示必須 + SIWE cookie の往復。

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const OPENPAY_ORIGIN = 'https://openpay.test';
const RESOURCE = 'https://seller.test/api/paid/report';
const RESOURCE_ID = 'res-dual-1';

type AnySdk = {
  createDualGate: (options: Record<string, unknown>) => {
    handle: (request: Request) => Promise<Response | { paymentResponseHeader: string }>;
    verify: (
      request: Request,
    ) => Promise<Response | { settle: () => Promise<Response | { paymentResponseHeader: string }> }>;
  };
  createListingClient: (options: Record<string, unknown>) => {
    address: string;
    register: (input: Record<string, unknown>) => Promise<{ resource: { id: string } }>;
    list: () => Promise<unknown[]>;
    deactivate: (id: string) => Promise<boolean>;
  };
};

async function loadSdk(): Promise<AnySdk> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as unknown as AnySdk;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

const JPYC_ACCEPT = {
  scheme: 'exact',
  network: 'eip155:137',
  maxAmountRequired: '1000000000000000000',
  resource: RESOURCE,
  description: 'paid report',
  payTo: '0x2222222222222222222222222222222222222222',
  asset: '0x1111111111111111111111111111111111111111',
  extra: { name: 'JPY Coin', version: '1' },
};

const USDC_FACE = {
  resourceId: RESOURCE_ID,
  v1Accepts: {
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: '1000',
    resource: RESOURCE,
    payTo: '0x3333333333333333333333333333333333333333',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    extra: { name: 'USD Coin', version: '2' },
  },
  v2Accept: { scheme: 'exact', network: 'eip155:8453', amount: '1000' },
  paymentRequiredHeader: b64({ x402Version: 2 }),
};

type Routes = {
  requirements?: () => Response;
  relayVerify?: () => Response;
  relaySettle?: () => Response;
  facVerify?: () => Response;
  facSettle?: () => Response;
};

// URL でルーティングする fetch モック。呼び出しを記録して中継先とレールを検証する。
function routingFetch(routes: Routes) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, body });
    if (u.startsWith(`${OPENPAY_ORIGIN}/api/discovery`)) {
      return jsonResponse({ items: [{ resource: RESOURCE, accepts: [JPYC_ACCEPT] }] });
    }
    if (u.startsWith(`${OPENPAY_ORIGIN}/api/x402/relay/requirements`)) {
      return routes.requirements?.() ?? jsonResponse(USDC_FACE);
    }
    if (u === `${OPENPAY_ORIGIN}/api/x402/relay/verify`) {
      return routes.relayVerify?.() ?? jsonResponse({ isValid: true, payer: '0xabc' });
    }
    if (u === `${OPENPAY_ORIGIN}/api/x402/relay/settle`) {
      return routes.relaySettle?.() ?? jsonResponse({ success: true, transaction: '0xtx' });
    }
    if (u === `${OPENPAY_ORIGIN}/api/facilitator/verify`) {
      return routes.facVerify?.() ?? jsonResponse({ isValid: false, invalidReason: 'jpyc_invalid' });
    }
    if (u === `${OPENPAY_ORIGIN}/api/facilitator/settle`) {
      return routes.facSettle?.() ?? jsonResponse({ success: false });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

async function makeGate(routes: Routes = {}) {
  const sdk = await loadSdk();
  const { fetchImpl, calls } = routingFetch(routes);
  const gate = sdk.createDualGate({
    resourceUrl: RESOURCE,
    resourceId: RESOURCE_ID,
    openpayOrigin: OPENPAY_ORIGIN,
    fetchImpl,
  });
  return { gate, calls };
}

describe('createDualGate', () => {
  it('resourceId なしは即 throw (設定ミスを黙って JPYC 専用にしない)', async () => {
    const sdk = await loadSdk();
    expect(() =>
      sdk.createDualGate({ resourceUrl: RESOURCE, openpayOrigin: OPENPAY_ORIGIN }),
    ).toThrow(/resourceId/);
  });

  it('未払い: 402 に JPYC + USDC の accepts を並記し PAYMENT-REQUIRED ヘッダを付ける', async () => {
    const { gate } = await makeGate();
    const res = (await gate.handle(new Request(RESOURCE))) as Response;
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBe(USDC_FACE.paymentRequiredHeader);
    const body = await res.json();
    expect(body.accepts).toHaveLength(2);
    expect(body.accepts[0].network).toBe('eip155:137');
    expect(body.accepts[1].network).toBe('base');
  });

  it('隔離: USDC 面の取得失敗 (404/例外) は JPYC のみの 402 へ degrade する', async () => {
    for (const requirements of [
      () => jsonResponse({ error: 'resource_not_found' }, 404),
      () => {
        throw new Error('network down');
      },
    ]) {
      const { gate } = await makeGate({ requirements });
      const res = (await gate.handle(new Request(RESOURCE))) as Response;
      expect(res.status).toBe(402);
      expect(res.headers.get('payment-required')).toBeNull();
      const body = await res.json();
      expect(body.accepts).toHaveLength(1);
      expect(body.accepts[0].network).toBe('eip155:137');
    }
  });

  it('v2 PAYMENT-SIGNATURE → リレー verify/settle に中継し receipt ヘッダを返す', async () => {
    const { gate, calls } = await makeGate();
    const sig = b64({ x402Version: 2, accepted: USDC_FACE.v2Accept, payload: {} });
    const result = await gate.handle(
      new Request(RESOURCE, { headers: { 'payment-signature': sig } }),
    );
    expect(result).not.toBeInstanceOf(Response);
    const settlement = JSON.parse(
      Buffer.from(
        (result as { paymentResponseHeader: string }).paymentResponseHeader,
        'base64',
      ).toString('utf8'),
    );
    expect(settlement).toMatchObject({ success: true, transaction: '0xtx' });
    const verifyCall = calls.find((c) => c.url.endsWith('/relay/verify'));
    expect(verifyCall?.body).toEqual({ resourceId: RESOURCE_ID, paymentSignatureHeader: sig });
    expect(calls.some((c) => c.url.endsWith('/relay/settle'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/api/facilitator/'))).toBe(false);
  });

  it('v1 x-payment (network=base) → USDC レール。verify 拒否は 402 (両 accepts)', async () => {
    const { gate, calls } = await makeGate({
      relayVerify: () => jsonResponse({ isValid: false, invalidReason: 'insufficient_funds' }),
    });
    const header = b64({ scheme: 'exact', network: 'base', payload: {} });
    const res = (await gate.handle(
      new Request(RESOURCE, { headers: { 'x-payment': header } }),
    )) as Response;
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('insufficient_funds');
    expect(body.accepts).toHaveLength(2);
    const verifyCall = calls.find((c) => c.url.endsWith('/relay/verify'));
    expect(verifyCall?.body).toEqual({ resourceId: RESOURCE_ID, paymentHeader: header });
  });

  it('USDC レール settle 失敗 → 402 settlement_failed (解錠しない)', async () => {
    const { gate } = await makeGate({
      relaySettle: () => jsonResponse({ success: false, errorReason: 'settle_boom' }),
    });
    const sig = b64({ x402Version: 2, accepted: USDC_FACE.v2Accept, payload: {} });
    const res = (await gate.handle(
      new Request(RESOURCE, { headers: { 'payment-signature': sig } }),
    )) as Response;
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('settle_boom');
  });

  it('v1 x-payment (network=eip155:137) → JPYC レールへ委譲し、402 に USDC を追記する', async () => {
    const { gate, calls } = await makeGate();
    const header = b64({ scheme: 'exact', network: 'eip155:137', payload: {} });
    const res = (await gate.handle(
      new Request(RESOURCE, { headers: { 'x-payment': header } }),
    )) as Response;
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('jpyc_invalid'); // JPYC facilitator の判定がそのまま伝わる
    expect(body.accepts.map((a: { network: string }) => a.network)).toEqual([
      'eip155:137',
      'base',
    ]);
    expect(res.headers.get('payment-required')).toBe(USDC_FACE.paymentRequiredHeader);
    expect(calls.some((c) => c.url.endsWith('/api/facilitator/verify'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/relay/verify'))).toBe(false);
  });
});

// hardhat/anvil の公知テスト鍵 #0 (資産を置かない前提の鍵・SIWE 署名のみに使用)。
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

type Call = { url: string; init?: RequestInit };

function listingFetch(opts: { firstResourcesStatus?: number } = {}) {
  const calls: Call[] = [];
  let resourcesHits = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith('/api/auth/siwe/nonce')) {
      return jsonResponse({ ok: true, nonce: `testnonce${String(calls.length).padStart(3, '0')}` });
    }
    if (u.endsWith('/api/auth/siwe/verify')) {
      return jsonResponse({ ok: true }, 200, { 'set-cookie': 'op_sess=tok; Path=/; HttpOnly' });
    }
    if (u.endsWith('/api/facilitator/resources') && init?.method === 'POST') {
      resourcesHits += 1;
      if (resourcesHits === 1 && opts.firstResourcesStatus) {
        return jsonResponse({ error: 'unauthorized' }, opts.firstResourcesStatus);
      }
      const body = JSON.parse(String(init.body));
      return jsonResponse(
        { resource: { id: 'res-1', ...body }, paywallSnippet: 'snippet' },
        201,
      );
    }
    if (u.endsWith('/api/facilitator/resources')) {
      return jsonResponse({ resources: [{ id: 'res-1' }] });
    }
    if (init?.method === 'DELETE') {
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe('createListingClient', () => {
  it('attested: true の明示なしでは登録を拒否する (fetch 前に throw・SDK は代行表明しない)', async () => {
    const sdk = await loadSdk();
    const { fetchImpl, calls } = listingFetch();
    const client = sdk.createListingClient({
      privateKey: TEST_PK,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    await expect(
      client.register({ url: 'https://s.test/x', description: 'd', priceJpyc: '1', category: 'api' }),
    ).rejects.toThrow(/attested: true is required/);
    expect(calls).toHaveLength(0);
  });

  it('register: SIWE (nonce→署名→verify) → cookie 付き POST に入力 + usdc + attested が乗る', async () => {
    const sdk = await loadSdk();
    const { fetchImpl, calls } = listingFetch();
    const client = sdk.createListingClient({
      privateKey: TEST_PK,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const result = await client.register({
      url: 'https://s.test/x',
      description: 'd',
      priceJpyc: '100',
      category: 'api',
      usdc: { priceUsd: '0.01', serviceName: 'S' },
      attested: true,
    });
    expect(result.resource.id).toBe('res-1');

    const verifyCall = calls.find((c) => c.url.endsWith('/siwe/verify'));
    const siweBody = JSON.parse(String(verifyCall!.init!.body));
    expect(siweBody.message).toContain('openpay.test');
    expect(siweBody.message).toContain(client.address);
    expect(siweBody.message).toContain('testnonce001');
    expect(siweBody.signature).toMatch(/^0x/);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/facilitator/resources') && c.init?.method === 'POST',
    );
    expect(
      (postCall!.init!.headers as Record<string, string>).cookie,
    ).toBe('op_sess=tok');
    expect(JSON.parse(String(postCall!.init!.body))).toMatchObject({
      url: 'https://s.test/x',
      priceJpyc: '100',
      usdc: { priceUsd: '0.01', serviceName: 'S' },
      attested: true,
    });
  });

  it('セッション失効 (401) は 1 回だけ SIWE し直して再試行する', async () => {
    const sdk = await loadSdk();
    const { fetchImpl, calls } = listingFetch({ firstResourcesStatus: 401 });
    const client = sdk.createListingClient({
      privateKey: TEST_PK,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const result = await client.register({
      url: 'https://s.test/x',
      description: 'd',
      priceJpyc: '1',
      category: 'api',
      attested: true,
    });
    expect(result.resource.id).toBe('res-1');
    expect(calls.filter((c) => c.url.endsWith('/siwe/nonce'))).toHaveLength(2);
  });

  it('list / deactivate: cookie を再利用して GET / DELETE する', async () => {
    const sdk = await loadSdk();
    const { fetchImpl, calls } = listingFetch();
    const client = sdk.createListingClient({
      privateKey: TEST_PK,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    expect(await client.list()).toHaveLength(1);
    expect(await client.deactivate('res-1')).toBe(true);
    // SIWE は初回 1 回だけ (cookie 再利用)。
    expect(calls.filter((c) => c.url.endsWith('/siwe/nonce'))).toHaveLength(1);
    const del = calls.find((c) => c.init?.method === 'DELETE');
    expect(del?.url).toContain('/api/facilitator/resources/res-1');
    expect((del!.init!.headers as Record<string, string>).cookie).toBe('op_sess=tok');
  });
});
