// vanillaGate の facilitator 切替フェンス (agentic.market 裁定 2026-08-16):
//   - 既定 (cdpAuth なし): 従来 URL・authorization ヘッダ無し = 挙動完全不変
//   - cdp: CDP URL + リクエストごとの Bearer JWT (uri claim が verify/settle に束縛)
// wire body は両者で同一 (掟 12: 追加のみ・応答/順序を変えない)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { generateKeyPairSync } from 'node:crypto';

vi.mock('server-only', () => ({}));

const configHold = vi.hoisted(() => ({
  vanillaFacilitator: { url: 'https://facilitator.payai.network' } as {
    url: string;
    cdpAuth?: { keyId: string; keySecret: string };
  },
}));

vi.mock('@/lib/x402/config', () => ({
  x402Config: {
    network: 'base',
    payTo: '0x1111111111111111111111111111111111111111',
    testMode: false,
    get vanillaFacilitator() {
      return configHold.vanillaFacilitator;
    },
  },
}));

import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';

function ed25519Secret(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(
    (privateKey.export({ format: 'jwk' }) as { d: string }).d,
    'base64url',
  );
  const pub = Buffer.from(
    (publicKey.export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  );
  return Buffer.concat([seed, pub]).toString('base64');
}

const RESOURCE = {
  resourceUrl: 'https://open-pay.jp/api/paid/usdc/stores',
  description: 'test resource',
  price: '$0.02',
};

function v1PaymentHeader(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { signature: '0xsig', authorization: {} },
    }),
  ).toString('base64');
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ isValid: true, payer: '0xabc', success: true, transaction: '0xtx' }),
  });
  configHold.vanillaFacilitator = { url: 'https://facilitator.payai.network' };
});

async function run(): Promise<void> {
  const req = new Request(RESOURCE.resourceUrl, {
    headers: { 'x-payment': v1PaymentHeader() },
  });
  await handleVanillaPaidGet(req, RESOURCE, () =>
    NextResponse.json({ ok: true }),
  );
}

describe('vanillaGate facilitator 切替', () => {
  it('既定: 従来 URL へ・authorization ヘッダ無し (挙動不変の回帰)', async () => {
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://facilitator.payai.network/verify',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://facilitator.payai.network/settle',
    );
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as { headers: Record<string, string> }).headers;
      expect(headers.authorization).toBeUndefined();
    }
  });

  it('cdp: CDP URL へ・verify/settle それぞれの uri claim を持つ Bearer JWT が付く', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.cdp.coinbase.com/platform/v2/x402/verify',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.cdp.coinbase.com/platform/v2/x402/settle',
    );
    const uris: string[] = [];
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as { headers: Record<string, string> }).headers;
      expect(headers.authorization).toMatch(/^Bearer /);
      const claims = JSON.parse(
        Buffer.from(
          headers.authorization.slice(7).split('.')[1],
          'base64url',
        ).toString('utf8'),
      );
      expect(claims.iss).toBe('cdp');
      expect(claims.sub).toBe('org/key-1');
      uris.push(claims.uri);
    }
    expect(uris).toEqual([
      'POST api.cdp.coinbase.com/platform/v2/x402/verify',
      'POST api.cdp.coinbase.com/platform/v2/x402/settle',
    ]);
    // CDP へは v2 ワイヤ (2026-08-20 実測: v1 body は 400 invalid_request)。
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.x402Version).toBe(2);
    expect(body.paymentPayload.x402Version).toBe(2);
    expect(body.paymentRequirements.network).toBe('eip155:8453');
    expect(body.paymentRequirements.amount).toBe(body.paymentRequirements.amount);
    expect(typeof body.paymentRequirements.amount).toBe('string');
    expect(body.paymentRequirements.maxAmountRequired).toBeUndefined();
    expect(body.paymentPayload.accepted).toEqual(body.paymentRequirements);
    expect(body.paymentPayload.resource.url).toBe(RESOURCE.resourceUrl);
    // 署名部 (payload) は client の値をそのまま同梱
    expect(body.paymentPayload.payload.signature).toBe('0xsig');
  });

  // Bazaar カタログ登録は facilitator に送る paymentPayload.extensions から抽出される
  // (coinbase/x402 bazaar/facilitator.ts extractDiscoveryInfo)。402 応答に載せるだけでは
  // 登録されない (2026-08-20 未掲載の真因)。
  it('cdp: 宣言のある resource は verify/settle 双方の paymentPayload.extensions.bazaar を運ぶ', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    await handleVanillaPaidGet(
      req,
      { ...RESOURCE, outputSchema: { input: { type: 'http', method: 'GET' } } },
      () => NextResponse.json({ ok: true }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const sent = JSON.parse((call[1] as { body: string }).body) as {
        paymentPayload: {
          resource: { url: string };
          extensions: {
            bazaar: { info: Record<string, unknown>; schema: Record<string, unknown> };
          };
        };
      };
      // 抽出側は resource.url と extensions.bazaar の両方を要求する
      expect(sent.paymentPayload.resource.url).toBe(RESOURCE.resourceUrl);
      expect(sent.paymentPayload.extensions.bazaar.info).toEqual({
        input: { type: 'http', method: 'GET' },
      });
      expect(sent.paymentPayload.extensions.bazaar.schema.$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
    }
  });

  // 掲載カードの serviceName/tags/iconUrl は settle 時に確定する (#384 と同じ経路) ので、
  // 402 だけでなく facilitator へ送る paymentPayload.resource にも同じ値を載せる。
  it('cdp: serviceName/tags/iconUrl は verify/settle の paymentPayload.resource にも載る', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    await handleVanillaPaidGet(
      req,
      {
        ...RESOURCE,
        outputSchema: { input: { type: 'http', method: 'GET' } },
        serviceName: 'JPYC Supply by Chain',
        tags: ['jpyc', 'token-supply'],
        iconUrl: 'https://open-pay.jp/icon-512.png',
      },
      () => NextResponse.json({ ok: true }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const sent = JSON.parse((call[1] as { body: string }).body) as {
        paymentPayload: { resource: { url: string; serviceName?: string; tags?: string[]; iconUrl?: string } };
      };
      expect(sent.paymentPayload.resource.serviceName).toBe('JPYC Supply by Chain');
      expect(sent.paymentPayload.resource.tags).toEqual(['jpyc', 'token-supply']);
      expect(sent.paymentPayload.resource.iconUrl).toBe('https://open-pay.jp/icon-512.png');
    }
  });

  it('cdp: メタ未指定の resource は resource に serviceName/tags/iconUrl を持たない (既存 4 本の挙動不変)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    await run();
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { paymentPayload: { resource: Record<string, unknown> } };
    expect(Object.keys(sent.paymentPayload.resource).sort()).toEqual(['description', 'mimeType', 'url']);
  });

  it('cdp: 宣言のない resource は extensions を積まない (store 商品など)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    await run();
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { paymentPayload: { extensions?: unknown } };
    expect(sent.paymentPayload.extensions).toBeUndefined();
  });

  it('既定 (payai): wire body は v1 のまま (network=base・maxAmountRequired)', async () => {
    await run();
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.x402Version).toBe(1);
    expect(body.paymentRequirements.network).toBe('base');
    expect(typeof body.paymentRequirements.maxAmountRequired).toBe('string');
    expect(body.paymentPayload.accepted).toBeUndefined();
  });

  // CDP は invalid な支払いを 200 でなく 4xx + 正規の判定 body で返す (2026-08-20 本番実測)。
  it('cdp: verify 400 + isValid:false は 503 でなく 402 challenge (settle は呼ばれない)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        isValid: false,
        invalidReason: 'invalid_payload',
        payer: '0xabc',
      }),
    });
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_payload');
  });

  it('cdp: verify 400 でも判定 body でなければ従来どおり 503', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ errorType: 'invalid_request' }),
    });
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(503);
  });

  it('cdp: verify 500 は判定 body があっても 503 (障害は fail-closed)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ isValid: false }),
    });
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(503);
  });

  it('既定 (payai): 非 2xx は従来どおり 503 (v1 挙動不変の回帰)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ isValid: false, invalidReason: 'x' }),
    });
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(503);
  });

  it('cdp: JWT 生成が throw したら 503 (課金なし・fail-closed)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'k', keySecret: 'broken!!' },
    };
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
