// 公開 example と Error schema を実 route の応答に照合する (B-R9d)。
// 決済は送らず、未署名の 402・設定不備の 503・query 不正の 400 だけを呼ぶ。
import Ajv2020 from 'ajv/dist/2020';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_OPENAPI_RESPONSES, BASE_OPENAPI_SCHEMAS } from '@/lib/openapi/components';

const validateError = new Ajv2020({ strict: false }).compile(BASE_OPENAPI_SCHEMAS.Error);

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '1');
  vi.stubEnv('NEXT_PUBLIC_JPYC_MAINNET_ADDRESS', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', '0x1111111111111111111111111111111111111111');
  vi.stubEnv('X402_PAY_TO_ADDRESS', '0x2222222222222222222222222222222222222222');
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', '0x3333333333333333333333333333333333333333');
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '1');
  vi.stubEnv('X402_NETWORK', 'base');
  vi.stubEnv('X402_TEST_MODE', '');
  vi.stubEnv('ENABLE_X402_ARC_GATEWAY', '');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('OpenAPI response examples and schemas', () => {
  it('PaymentRequired example matches the complete v1 body; the v2 header maps maxAmountRequired to amount', async () => {
    const { GET } = await import('@/app/api/paid/japan-web3-directory/route');
    const example = BASE_OPENAPI_RESPONSES.PaymentRequired.content['application/json'].example;
    const response = await GET(new NextRequest(example.accepts[0].resource));

    expect(response.status).toBe(402);
    expect(await response.text()).toBe(JSON.stringify(example));
    const header = response.headers.get('PAYMENT-REQUIRED');
    expect(header).not.toBeNull();
    const v2 = JSON.parse(Buffer.from(header!, 'base64').toString('utf8'));
    const { maxAmountRequired, resource, description, mimeType, outputSchema, ...accept } = example.accepts[0];
    expect(v2).toEqual({
      x402Version: 2,
      resource: { url: resource, description, mimeType },
      accepts: [{ ...accept, amount: maxAmountRequired }],
      error: example.error,
      extensions: { bazaar: { info: outputSchema } },
    });
  });

  it.each([
    ['jpyc-services', () => import('@/app/api/paid/jpyc/services/route')],
    ['jpyc-payments', () => import('@/app/api/paid/stablecoin-payments/route')],
    ['usdc-services', () => import('@/app/api/paid/usdc/jpyc/services/route')],
    ['usdc-payments', () => import('@/app/api/paid/usdc/stablecoin-payments/route')],
  ] as const)('%s: Monitor query errors match the shared Error schema', async (_name, load) => {
    const { GET } = await load();
    for (const query of ['chain=polygon', 'changedSince=2026-02-30', 'limit=201']) {
      const response = await GET(new NextRequest(`https://open-pay.jp/api/paid/monitor?${query}`));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ ok: false, error: 'invalid_query' });
      expect(validateError(body)).toBe(true);
    }
  });

  it.each([
    ['JPYC', () => import('@/app/api/paid/jpyc/services/route')],
    ['USDC', () => import('@/app/api/paid/usdc/jpyc/services/route')],
  ] as const)('%s: actual payment_facility_unavailable body validates without ok', async (rail, load) => {
    if (rail === 'JPYC') vi.stubEnv('X402_PAY_TO_ADDRESS', '');
    else vi.stubEnv('X402_NETWORK', 'invalid-network');
    const { GET } = await load();
    const response = await GET(new NextRequest('https://open-pay.jp/api/paid/monitor'));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      x402Version: 1,
      error: 'payment_facility_unavailable',
      message: expect.any(String),
    });
    expect(validateError(body)).toBe(true);
  });

  it('preserves the legacy ok/error shape, including previously permitted extra fields', () => {
    for (const error of ['invalid_query', 'not_found', 'rate_limited', 'storage_unavailable']) {
      expect(validateError({ ok: false, error })).toBe(true);
      expect(validateError({ ok: false, error, x402Version: 9, message: ['legacy extra field'] })).toBe(true);
      expect(validateError({ error })).toBe(false);
      expect(validateError({ ok: true, error })).toBe(false);
    }
  });

  it('adds the snapshot fallback and requires the complete facility error shape when ok is absent', () => {
    expect(validateError({ error: 'snapshot_required' })).toBe(true);
    expect(validateError({ error: 'payment_facility_unavailable' })).toBe(false);
    expect(validateError({ error: 'payment_facility_unavailable', x402Version: 1 })).toBe(false);
    expect(validateError({ error: 'payment_facility_unavailable', x402Version: 2, message: 'unavailable' })).toBe(false);
    expect(validateError({ error: 'unknown_error' })).toBe(false);
  });
});
