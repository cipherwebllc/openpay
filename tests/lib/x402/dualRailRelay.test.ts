// dual-rail リレー (/api/x402/relay/*) の unit テスト。
// 検証の柱: (1) flag OFF で完全 inert (404)・CDP 鍵なしは 503、(2) 掲載メタは registry の
// 登録値のみから注入され呼び出し body 由来の値が facilitator へ流れない (catalog poisoning 防止)、
// (3) facilitator の判定 body は素通し・障害 (5xx) は 503。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAddress } from 'viem';

const state = vi.hoisted(() => ({
  flags: { enableX402DualRail: true, enableX402Facilitator: true },
  cdpAuth: { keyId: 'k', keySecret: 's' } as
    | { keyId: string; keySecret: string }
    | undefined,
  rateLimited: false,
  resource: null as unknown,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...mod,
    env: new Proxy(mod.env, {
      get: (t, p) =>
        p in state.flags
          ? state.flags[p as keyof typeof state.flags]
          : (t as Record<string | symbol, unknown>)[p],
    }),
  };
});

vi.mock('@/lib/x402/config', () => ({
  x402Config: {
    network: 'base',
    payTo: '0x00000000000000000000000000000000000000FE',
    testMode: false,
    get vanillaFacilitator() {
      return { url: 'https://cdp.example', cdpAuth: state.cdpAuth };
    },
  },
}));

vi.mock('@/lib/x402/cdpJwt', () => ({
  generateCdpJwt: () => 'test-jwt',
}));

vi.mock('@/lib/x402/registry', () => ({
  getResource: vi.fn(async () => state.resource),
}));

vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: vi.fn(async () => !state.rateLimited),
}));

import {
  handleDualRailRelay,
  handleDualRailRequirements,
} from '@/lib/x402/dualRailRelay';

const SELLER = getAddress('0x1111111111111111111111111111111111111111');
const SELLER_USDC = getAddress('0x2222222222222222222222222222222222222222');
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    merchant: SELLER,
    url: 'https://seller.example/api/data',
    description: 'Seller paid data API',
    priceJpyc: '10',
    category: 'api',
    payTo: SELLER,
    network: 'eip155:137',
    active: true,
    createdAt: 1,
    usdc: { payTo: SELLER_USDC, priceUsd: '0.005', serviceName: 'Seller Data' },
    ...over,
  };
}

// v1 X-PAYMENT ヘッダ (base64 JSON)。network は v1 命名 'base'。
function v1Header(network = 'base'): string {
  return Buffer.from(
    JSON.stringify({
      scheme: 'exact',
      network,
      payload: { authorization: {}, signature: '0xsig' },
    }),
    'utf8',
  ).toString('base64');
}

function post(path: string, body: unknown): Request {
  return new Request(`https://open-pay.jp/api/x402/relay/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function reqGet(resourceId?: string): Request {
  const q = resourceId === undefined ? '' : `?resourceId=${resourceId}`;
  return new Request(`https://open-pay.jp/api/x402/relay/requirements${q}`);
}

const fetchMock = vi.fn();

beforeEach(() => {
  state.flags.enableX402DualRail = true;
  state.flags.enableX402Facilitator = true;
  state.cdpAuth = { keyId: 'k', keySecret: 's' };
  state.rateLimited = false;
  state.resource = record();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

function facilitatorReplies(status: number, body: unknown) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('dualRailRelay gate', () => {
  it.each(['enableX402DualRail', 'enableX402Facilitator'] as const)(
    'flag OFF (%s) → 404 (完全 inert)',
    async (flag) => {
      state.flags[flag] = false;
      const res = await handleDualRailRelay(
        post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
        'verify',
      );
      expect(res.status).toBe(404);
      const reqs = await handleDualRailRequirements(reqGet('res-1'));
      expect(reqs.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('CDP 鍵なし → 503 (fallback facilitator へ黙って流さない)', async () => {
    state.cdpAuth = undefined;
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'relay_unconfigured' });
  });

  it('rate limit 超過 → 429', async () => {
    state.rateLimited = true;
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(429);
  });
});

describe('dualRailRelay resolveTarget (登録リソース限定)', () => {
  it.each([
    ['未登録', null],
    ['無効化済', record({ active: false })],
    ['モデレーション hidden', record({ hidden: true })],
    ['USDC 面なし (JPYC のみ出品)', record({ usdc: undefined })],
  ])('%s → 404 resource_not_found', async (_label, resource) => {
    state.resource = resource;
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'resource_not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resourceId 欠落/型不正 → 400', async () => {
    const res = await handleDualRailRelay(
      post('verify', { paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_resource_id' });
  });
});

describe('dualRailRequirements', () => {
  it('登録値から USDC 要件一式を返す (payTo=出品者・Base USDC・atomic 変換)', async () => {
    const res = await handleDualRailRequirements(reqGet('res-1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.resourceId).toBe('res-1');
    expect(body.v1Accepts).toMatchObject({
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '5000', // $0.005 → 6 桁 atomic
      resource: 'https://seller.example/api/data',
      payTo: SELLER_USDC,
      asset: BASE_USDC,
    });
    expect(body.v2Accept.network).toBe('eip155:8453');
    expect(body.v2Accept.amount).toBe('5000');
    // paymentRequiredHeader はそのまま PAYMENT-REQUIRED に載せられる完成形。
    const decoded = JSON.parse(
      Buffer.from(body.paymentRequiredHeader as string, 'base64').toString('utf8'),
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe('https://seller.example/api/data');
    expect(decoded.resource.serviceName).toBe('Seller Data');
    expect(decoded.accepts).toEqual([body.v2Accept]);
    expect(decoded.extensions.bazaar.schema).toBeDefined(); // CDP は schema 無しを掲載拒否
  });

  it('resourceId なし → 400', async () => {
    const res = await handleDualRailRequirements(reqGet());
    expect(res.status).toBe(400);
  });
});

describe('dualRailRelay verify/settle', () => {
  it('支払いヘッダなし / 形不一致 → 400 invalid_payment_payload (facilitator 不着)', async () => {
    for (const body of [
      { resourceId: 'res-1' },
      { resourceId: 'res-1', paymentHeader: v1Header('polygon') }, // network 不一致
      { resourceId: 'res-1', paymentHeader: 'not-base64-json' },
    ]) {
      const res = await handleDualRailRelay(post('verify', body), 'verify');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_payment_payload' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('JSON でない body → 400', async () => {
    const res = await handleDualRailRelay(
      new Request('https://open-pay.jp/api/x402/relay/verify', {
        method: 'POST',
        body: 'not-json',
      }),
      'verify',
    );
    expect(res.status).toBe(400);
  });

  it('verify: 判定 body を素通しし、wire は registry の登録値だけを載せる', async () => {
    facilitatorReplies(200, { isValid: true, payer: '0xabc' });
    const res = await handleDualRailRelay(
      post('verify', {
        resourceId: 'res-1',
        paymentHeader: v1Header(),
        // 呼び出し側が掲載メタを差し込もうとしても無視される (catalog poisoning 防止)。
        resource: { url: 'https://evil.example/spam', description: 'spam' },
      }),
      'verify',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: true, payer: '0xabc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cdp.example/verify');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-jwt',
    );
    const wire = JSON.parse(init.body as string);
    expect(wire.x402Version).toBe(2);
    expect(wire.paymentPayload.resource.url).toBe('https://seller.example/api/data');
    expect(wire.paymentPayload.resource.description).toBe('Seller paid data API');
    expect(wire.paymentPayload.resource.serviceName).toBe('Seller Data');
    expect(wire.paymentPayload.accepted.payTo).toBe(SELLER_USDC);
    expect(wire.paymentPayload.extensions.bazaar).toBeDefined();
    expect(JSON.stringify(wire)).not.toContain('evil.example');
  });

  it('verify: CDP の 4xx 判定 body (isValid:false) も素通し (障害と混同しない)', async () => {
    facilitatorReplies(400, { isValid: false, invalidReason: 'invalid_payload' });
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      isValid: false,
      invalidReason: 'invalid_payload',
    });
  });

  it('settle: /settle に届き success body を素通し', async () => {
    facilitatorReplies(200, { success: true, transaction: '0xtx', payer: '0xabc' });
    const res = await handleDualRailRelay(
      post('settle', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'settle',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, transaction: '0xtx' });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://cdp.example/settle',
    );
  });

  it('facilitator 5xx → 503 (判定なしを成功にも失敗にも見せない)', async () => {
    facilitatorReplies(500, { error: 'boom' });
    const res = await handleDualRailRelay(
      post('settle', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'settle',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'facilitator_unavailable' });
  });

  it('v2 PAYMENT-SIGNATURE ヘッダも受理する (accepted は要件一式と一致)', async () => {
    // 出品者は requirements の v2Accept をそのまま 402 に載せ、購入者 client がそれを
    // accepted に写して支払う — その round-trip を再現する。
    const reqs = await handleDualRailRequirements(reqGet('res-1'));
    const { v2Accept } = await reqs.json();
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: v2Accept,
        payload: { authorization: {}, signature: '0xsig' },
      }),
      'utf8',
    ).toString('base64');
    facilitatorReplies(200, { isValid: true, payer: '0xabc' });
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentSignatureHeader: header }),
      'verify',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: true, payer: '0xabc' });
  });
});
