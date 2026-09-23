// JPYC Service Monitor の route 2 本 (/api/paid/jpyc/services・/api/paid/usdc/jpyc/services)。
// envelope の契約は tests/lib/directory/serviceMonitor.test.ts が担うので、ここは route 境界:
// flag ゲート / query 検証 (402 より先に 400) / content (test mode) / snapshot 不能 503。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { NextResponse } from 'next/server';
// @ts-expect-error SDK source of truth is JavaScript without declarations.
import { validateAcceptForPayment } from '../../../packages/x402-sdk/src/guards.mjs';

const verificationMocks = vi.hoisted(() => ({
  read: vi.fn(),
  snapshot: {} as Record<
    string,
    { checkedAt: string; ok: boolean; sourceUrl: string }
  > | null,
}));

vi.mock('@/lib/directory/verification', () => ({
  readDirectoryVerificationSnapshot: async () => {
    verificationMocks.read();
    return verificationMocks.snapshot;
  },
}));

const paidMocks = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn(), lookup: vi.fn(), promote: vi.fn() }));
vi.mock('@/app/api/facilitator/verify/route', () => ({ POST: paidMocks.verify }));
vi.mock('@/app/api/facilitator/settle/route', () => ({ POST: paidMocks.settle }));
vi.mock('@/lib/x402/paymentRedelivery', async (original) => ({
  ...await original<typeof import('@/lib/x402/paymentRedelivery')>(),
  lookupPaymentRedelivery: paidMocks.lookup,
  claimPaymentRedelivery: async () => ({ kind: 'unavailable' }),
  promotePaymentRedelivery: paidMocks.promote,
}));

const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
const SETTLEMENT = { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:80002', payer: SELLER };

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

async function paidReq(route: Route, header: 'X-PAYMENT' | 'PAYMENT-SIGNATURE'): Promise<Request> {
  const url = 'https://open-pay.jp/api/paid/jpyc/services?changedSince=2026-08-20';
  const challenge = await route.GET(new Request(url));
  const required = JSON.parse(Buffer.from(challenge.headers.get('PAYMENT-REQUIRED')!, 'base64').toString());
  const payload = {
    signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}21b`,
    authorization: { from: SELLER, validAfter: '0', validBefore: '9999999999', intentSalt: `0x${'22'.repeat(32)}` },
  };
  const payment = header === 'X-PAYMENT'
    ? { x402Version: 1, scheme: 'exact', network: 'eip155:80002', payload }
    : { x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload };
  return new Request(url, { headers: { [header]: Buffer.from(JSON.stringify(payment)).toString('base64') } });
}

beforeEach(() => {
  vi.clearAllMocks();
  verificationMocks.snapshot = {};
  paidMocks.verify.mockImplementation(async () => NextResponse.json({ isValid: true, payer: SELLER }));
  paidMocks.settle.mockImplementation(async () => NextResponse.json(SETTLEMENT));
  paidMocks.lookup.mockResolvedValue({ kind: 'missing' });
  paidMocks.promote.mockResolvedValue({ kind: 'unavailable' });
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

  // E4: openapi/Bazaar は changedSince/limit の 2 引数だけを宣言する。未知キーや暦上
  // 実在しない日付を黙って通すと宣言とのずれに気づけないので、支払い要求より先に 400。
  it('E4: 未知キー・暦上実在しない日付は 400 (402/署名より先に弾く)', async () => {
    const route = await loadUsdc();
    for (const qs of ['?since=2026-08-20', '?changedSince=2026-08-20&extra=1', '?changedSince=2026-02-30']) {
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
    // 次回エコー用カーソル (route 境界でも generatedAt の UTC 日付が出る)。
    expect(body.nextChangedSince).toBe(body.generatedAt.slice(0, 10));
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

  it.each(['X-PAYMENT', 'PAYMENT-SIGNATURE'] as const)('B13: %s snapshot 障害は verify/settle 前の 503', async (header) => {
    const route = await loadJpyc();
    const request = await paidReq(route, header);
    verificationMocks.snapshot = null;
    const res = await route.GET(request);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(paidMocks.verify).not.toHaveBeenCalled();
    expect(paidMocks.settle).not.toHaveBeenCalled();
    expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeNull();
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
  });

  it('B13: unpaid challenge は snapshot 障害に依存しない', async () => {
    verificationMocks.snapshot = null;
    const route = await loadJpyc();
    expect((await route.GET(req(PATH))).status).toBe(402);
    expect(verificationMocks.read).not.toHaveBeenCalled();
  });

  it('B13: snapshot を先読みし、settle 中の KV 障害でも配信・同一支払いの再配信を維持する', async () => {
    const route = await loadJpyc();
    const request = await paidReq(route, 'X-PAYMENT');
    paidMocks.settle.mockImplementation(async () => {
      verificationMocks.snapshot = null;
      return NextResponse.json(SETTLEMENT);
    });
    const res = await route.GET(request.clone());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: 'delta' });
    expect(verificationMocks.read).toHaveBeenCalledTimes(1);
    expect(verificationMocks.read.mock.invocationCallOrder[0]).toBeLessThan(paidMocks.settle.mock.invocationCallOrder[0]);
    paidMocks.lookup.mockResolvedValue({ kind: 'match', record: { state: 'settled', settlement: SETTLEMENT } });
    verificationMocks.snapshot = {};
    const redelivery = await route.GET(request.clone());
    expect(redelivery.status).toBe(200);
    expect(redelivery.headers.get('X-PAYMENT-RESPONSE')).toBe(res.headers.get('X-PAYMENT-RESPONSE'));
    expect(paidMocks.verify).toHaveBeenCalledTimes(1);
    expect(paidMocks.settle).toHaveBeenCalledTimes(1);
  });

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

  it('E4: 未知キー・暦上実在しない日付は 400 (402 より先)', async () => {
    const route = await loadJpyc();
    for (const qs of ['?since=2026-08-20', '?changedSince=2026-02-30']) {
      expect((await route.GET(req(PATH, qs))).status).toBe(400);
    }
  });

  it('支払いなし → 402。accepts の resource は本 route + 実リクエストの query・価格 2 JPYC + 手数料', async () => {
    const route = await loadJpyc();
    const res = await route.GET(req(PATH, '?changedSince=2026-08-20'));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.accepts).toHaveLength(1);
    const accept = body.accepts[0];
    // 買い手 (SDK / MCP) は accept.resource と要求 URL の query まで一致を要求する。query を落とすと
    // delta 購入 (?changedSince=) が resource_mismatch で買えない (2026-09-23 実機で発覚)。
    expect(accept.resource).toBe(`https://open-pay.jp${PATH}?changedSince=2026-08-20`);
    expect(validateAcceptForPayment(accept, `https://open-pay.jp${PATH}?changedSince=2026-08-20`).reasons).not.toContain('resource_mismatch');
    // v2 ヘッダの resource.url も同じ値。
    const v2 = res.headers.get('PAYMENT-REQUIRED');
    expect(v2).not.toBeNull();
    expect(JSON.parse(Buffer.from(v2!, 'base64').toString('utf8')).resource.url).toBe(`https://open-pay.jp${PATH}?changedSince=2026-08-20`);
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

  it('支払いなし → 402。価格 2 JPYC + 手数料 = 3 JPYC・resource は本 route + query', async () => {
    const route = await loadPaymentJpyc();
    const res = await route.GET(req(PATH, '?changedSince=2026-08-01'));
    expect(res.status).toBe(402);
    const body = await res.json();
    const accept = body.accepts[0];
    expect(accept.resource).toBe(`https://open-pay.jp${PATH}?changedSince=2026-08-01`);
    expect(accept.maxAmountRequired).toBe((3n * 10n ** 18n).toString());
  });
});
