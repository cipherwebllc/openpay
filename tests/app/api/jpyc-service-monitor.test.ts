// JPYC Service Monitor の route 2 本 (/api/paid/jpyc/services・/api/paid/usdc/jpyc/services)。
// envelope の契約は tests/lib/directory/serviceMonitor.test.ts が担うので、ここは route 境界:
// flag ゲート / query 検証 (402 より先に 400) / content (test mode) / snapshot 不能 503。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

const verificationMocks = vi.hoisted(() => ({
  snapshot: {} as Record<
    string,
    { checkedAt: string; ok: boolean; sourceUrl: string }
  > | null,
}));

vi.mock('@/lib/directory/verification', () => ({
  readDirectoryVerificationSnapshot: async () => verificationMocks.snapshot,
}));

const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');

type Route = { GET: (req: Request) => Promise<Response> };

async function loadUsdc(flags: { directory?: string } = {}): Promise<Route> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', flags.directory ?? '1');
  vi.stubEnv('X402_NETWORK', 'base');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.stubEnv('X402_TEST_MODE', 'true'); // gate バイパス = content 契約の検証に集中
  vi.resetModules();
  return (await import('@/app/api/paid/usdc/jpyc/services/route')) as unknown as Route;
}

async function loadJpyc(
  directoryFlag = '1',
  facilitatorFlag = '1',
): Promise<Route> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', directoryFlag);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', facilitatorFlag);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '1');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.resetModules();
  return (await import('@/app/api/paid/jpyc/services/route')) as unknown as Route;
}

function req(base: string, qs = ''): Request {
  return new Request(`https://open-pay.jp${base}${qs}`);
}

beforeEach(() => {
  verificationMocks.snapshot = {};
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /api/paid/usdc/jpyc/services (test mode)', () => {
  const PATH = '/api/paid/usdc/jpyc/services';

  it('flag OFF → 404', async () => {
    const route = await loadUsdc({ directory: '' });
    expect((await route.GET(req(PATH))).status).toBe(404);
  });

  it('不正 query → 400 (402/署名より先に弾く)', async () => {
    const route = await loadUsdc();
    for (const qs of ['?changedSince=bad', '?limit=0', '?limit=999']) {
      const res = await route.GET(req(PATH, qs));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_query' });
    }
  });

  it('snapshot: mode=snapshot・全 published 行 + baseline changes', async () => {
    const route = await loadUsdc();
    const res = await route.GET(req(PATH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('snapshot');
    expect(body.services.length).toBe(body.totalServices);
    expect(body.changes.length).toBeGreaterThan(0);
    expect(body.notice.code).toBe('sourced-facts-only');
  });

  it('delta: 未来側の changedSince は changes:[] を明示 (変更なし契約)', async () => {
    const route = await loadUsdc();
    const res = await route.GET(req(PATH, '?changedSince=9999-12-31'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('delta');
    expect(body.changes).toEqual([]);
    expect(body.services).toEqual([]);
  });

  it('検証スナップショット不能 → 503 (settle されない側の 5xx)', async () => {
    verificationMocks.snapshot = null;
    const route = await loadUsdc();
    const res = await route.GET(req(PATH));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'storage_unavailable' });
  });
});

describe('GET /api/paid/jpyc/services (facilitator gate)', () => {
  const PATH = '/api/paid/jpyc/services';

  it.each([
    ['directory OFF', '', '1'],
    ['facilitator OFF', '1', ''],
  ])('%s → 404', async (_label, dir, fac) => {
    const route = await loadJpyc(dir, fac);
    expect((await route.GET(req(PATH))).status).toBe(404);
  });

  it('不正 query → 400 (402 より先)', async () => {
    const route = await loadJpyc();
    const res = await route.GET(req(PATH, '?changedSince=nope'));
    expect(res.status).toBe(400);
  });

  it('支払いなし → 402。accepts の resource は本 route・価格 2 JPYC + 手数料', async () => {
    const route = await loadJpyc();
    const res = await route.GET(req(PATH, '?changedSince=2026-08-20'));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.accepts).toHaveLength(1);
    const accept = body.accepts[0];
    expect(accept.resource).toBe(`https://open-pay.jp${PATH}`);
    // 2 JPYC + facilitator fee (floor 1 JPYC・1% < floor) = 3 JPYC
    expect(accept.maxAmountRequired).toBe((3n * 10n ** 18n).toString());
    expect(accept.extra.openpay.merchantValue).toBe((2n * 10n ** 18n).toString());
  });
});

describe('GET /api/paid/usdc/stablecoin-payments (test mode・2 商品目)', () => {
  const PATH = '/api/paid/usdc/stablecoin-payments';

  async function loadPaymentUsdc(flags: { directory?: string } = {}): Promise<Route> {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', flags.directory ?? '1');
    vi.stubEnv('X402_NETWORK', 'base');
    vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
    vi.stubEnv('X402_TEST_MODE', 'true');
    vi.resetModules();
    return (await import(
      '@/app/api/paid/usdc/stablecoin-payments/route'
    )) as unknown as Route;
  }

  it('flag OFF → 404', async () => {
    const route = await loadPaymentUsdc({ directory: '' });
    expect((await route.GET(req(PATH))).status).toBe(404);
  });

  it('不正 query → 400', async () => {
    const route = await loadPaymentUsdc();
    expect((await route.GET(req(PATH, '?changedSince=bad'))).status).toBe(400);
  });

  it('snapshot: 決済スコープの履歴が provider 中心の行で返る', async () => {
    const route = await loadPaymentUsdc();
    const res = await route.GET(req(PATH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('snapshot');
    expect(body.changes.length).toBeGreaterThanOrEqual(4);
    expect(body.changes[0]).toHaveProperty('provider');
    expect(body.changes[0]).toHaveProperty('assets');
    expect(body.notice.code).toBe('sourced-facts-only');
  });

  it('delta: 未来日は changes:[] を明示', async () => {
    const route = await loadPaymentUsdc();
    const body = await (await route.GET(req(PATH, '?changedSince=9999-12-31'))).json();
    expect(body.mode).toBe('delta');
    expect(body.changes).toEqual([]);
  });
});

describe('GET /api/paid/stablecoin-payments (JPYC facilitator gate・2 商品目)', () => {
  const PATH = '/api/paid/stablecoin-payments';

  async function loadPaymentJpyc(): Promise<Route> {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
    vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
    vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
    vi.stubEnv('X402_FEE_BPS', '100');
    vi.stubEnv('X402_FEE_FLOOR_JPYC', '1');
    vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
    vi.resetModules();
    return (await import(
      '@/app/api/paid/stablecoin-payments/route'
    )) as unknown as Route;
  }

  it('支払いなし → 402。価格 2 JPYC + 手数料 = 3 JPYC・resource は本 route', async () => {
    const route = await loadPaymentJpyc();
    const res = await route.GET(req(PATH, '?changedSince=2026-08-01'));
    expect(res.status).toBe(402);
    const body = await res.json();
    const accept = body.accepts[0];
    expect(accept.resource).toBe(`https://open-pay.jp${PATH}`);
    expect(accept.maxAmountRequired).toBe((3n * 10n ** 18n).toString());
  });
});
