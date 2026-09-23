import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: log }));

const RESOURCE = {
  resourceUrl: 'https://open-pay.jp/api/paid/hello',
  description: 'test resource',
  price: '$0.001',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'testnet');
  vi.stubEnv('VERCEL_ENV', 'development');
  for (const key of [
    'X402_NETWORK', 'X402_PAY_TO_ADDRESS', 'X402_PRICE', 'X402_ASSET',
    'X402_TEST_MODE', 'X402_FACILITATOR_URL', 'X402_VANILLA_FACILITATOR',
    'CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'ENABLE_X402_ARC_GATEWAY',
  ]) vi.stubEnv(key, '');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const PRODUCTION_SIGNALS = [
  { key: 'NEXT_PUBLIC_NETWORK_ENV', value: 'mainnet' },
  { key: 'VERCEL_ENV', value: 'production' },
] as const;

describe.each(PRODUCTION_SIGNALS)('B15: $key=$value', ({ key, value }) => {
  beforeEach(() => vi.stubEnv(key, value));

  it.each(['Base', 'base-mainnet', 'base ', ' '])('unknown network %j disables x402 and logs without throwing during module load', async (network) => {
    vi.stubEnv('X402_NETWORK', network);
    vi.stubEnv('ENABLE_X402_ARC_GATEWAY', '1');
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.network).toBeNull();
    expect(x402Config.payTo).toBeNull();
    expect(x402Config.defaultPrice).toBeNull();
    expect(x402Config.arcGateway).toEqual({ enabled: false });
    expect(log.error).toHaveBeenCalledWith('x402.config.invalid_network', expect.objectContaining({
      network,
      message: expect.stringMatching(/X402_NETWORK.*disabled/),
    }));
    // OpenAPI shares the config import; invalid payment settings must not crash it.
    await expect(import('@/lib/openapi/document')).resolves.toHaveProperty('buildOpenApiDocument');
  });

  it.each([false, true])('unknown network returns 503 before challenge/content/fetch (testMode=%s)', async (testMode) => {
    vi.stubEnv('X402_NETWORK', 'Base');
    vi.stubEnv('X402_TEST_MODE', String(testMode));
    const { handleVanillaPaidGet, buildRelayAccepts } = await import('@/lib/x402/vanillaGate');
    const content = vi.fn(() => NextResponse.json({ secret: 'paid content' }));
    for (const headers of [new Headers(), new Headers({ 'x-payment': 'signed-payment' })]) {
      const res = await handleVanillaPaidGet(new Request(RESOURCE.resourceUrl, { headers }), RESOURCE, content);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        x402Version: 1,
        error: 'payment_facility_unavailable',
        message: 'Payment service is unavailable.',
      });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.has('PAYMENT-REQUIRED')).toBe(false);
      expect(res.headers.has('PAYMENT-RESPONSE')).toBe(false);
    }
    expect(content).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(() => buildRelayAccepts({ ...RESOURCE, payTo: '0x1111111111111111111111111111111111111111' })).toThrow();
  });

  it.each(['base', 'base-sepolia', 'polygon', 'polygon-amoy'])('explicit supported network %s is preserved', async (network) => {
    vi.stubEnv('X402_NETWORK', network);
    vi.stubEnv('X402_PAY_TO_ADDRESS', '0x1111111111111111111111111111111111111111');
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.network).toBe(network);
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('missing/empty network %j keeps the existing default', async (network) => {
    vi.stubEnv('X402_NETWORK', network);
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.network).toBe('base-sepolia');
    expect(log.error).not.toHaveBeenCalled();
  });
});

it.each(['development', 'test', 'production'])('without production deployment signals, NODE_ENV=%s keeps the development/testnet default', async (nodeEnv) => {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('X402_NETWORK', 'Base');
  const { x402Config } = await import('@/lib/x402/config');
  expect(x402Config.network).toBe('base-sepolia');
  const { handleVanillaPaidGet } = await import('@/lib/x402/vanillaGate');
  const res = await handleVanillaPaidGet(new Request(RESOURCE.resourceUrl), RESOURCE, () => NextResponse.json({ ok: true }));
  expect(res.status).toBe(402);
  expect(await res.json()).toMatchObject({ accepts: [expect.objectContaining({ network: 'base-sepolia' })] });
  expect(log.error).not.toHaveBeenCalled();
});
