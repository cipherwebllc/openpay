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
