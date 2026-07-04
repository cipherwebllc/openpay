import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getAddress } from 'viem';

const routeMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  settle: vi.fn(),
}));

vi.mock('@/app/api/facilitator/verify/route', () => ({
  POST: routeMocks.verify,
}));
vi.mock('@/app/api/facilitator/settle/route', () => ({
  POST: routeMocks.settle,
}));

const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const PAYER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');
const TX_HASH = `0x${'ab'.repeat(32)}`;

type PaidRoute = { GET: (req: Request) => Promise<Response> };

function paymentPayload() {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:80002',
    payload: {
      signature: `0x${'11'.repeat(65)}`,
      authorization: {
        from: PAYER,
        validAfter: '0',
        validBefore: '9999999999',
        intentSalt: `0x${'22'.repeat(32)}`,
      },
    },
  };
}

function paymentHeader(): string {
  return Buffer.from(JSON.stringify(paymentPayload()), 'utf8').toString('base64');
}

function req(path: string, xPayment?: string): Request {
  return new Request(`http://test.local${path}`, {
    headers: xPayment ? { 'X-PAYMENT': xPayment } : undefined,
  });
}

async function load(flag = '1'): Promise<{ demo: PaidRoute; stores: PaidRoute }> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', flag);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.resetModules();
  const demo = (await import('@/app/api/paid/demo/route')) as PaidRoute;
  const stores = (await import('@/app/api/paid/stores/route')) as PaidRoute;
  return { demo, stores };
}

beforeEach(() => {
  routeMocks.verify.mockReset();
  routeMocks.settle.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('first-party paid x402 routes', () => {
  it('flag OFF → 404', async () => {
    const { demo, stores } = await load('');
    expect((await demo.GET(req('/api/paid/demo'))).status).toBe(404);
    expect((await stores.GET(req('/api/paid/stores'))).status).toBe(404);
  });

  it('payment header なし → 402 + forwarder-split accepts', async () => {
    const { demo } = await load();
    const res = await demo.GET(req('/api/paid/demo'));
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: Array<{
        resource: string;
        maxAmountRequired: string;
        extra: { openpay: { merchant: string; merchantValue: string; feeValue: string } };
      }>;
    };
    expect(body.accepts).toHaveLength(1);
    const pr = body.accepts[0];
    expect(pr.resource).toBe('https://open-pay.jp/api/paid/demo');
    expect(pr.extra.openpay.merchant).toBe(SELLER);
    expect(pr.extra.openpay.merchantValue).toBe((1n * 10n ** 18n).toString());
    expect(pr.extra.openpay.feeValue).toBe((2n * 10n ** 18n).toString());
    expect(pr.maxAmountRequired).toBe((3n * 10n ** 18n).toString());
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('不正 X-PAYMENT → 402', async () => {
    const { demo } = await load();
    const res = await demo.GET(req('/api/paid/demo', 'not-json'));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('invalid_payment_payload');
  });

  it('verify が invalid → 402 + accepts を返し settle しない', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: false, invalidReason: 'signature_mismatch' }),
    );
    const { demo } = await load();
    const res = await demo.GET(req('/api/paid/demo', paymentHeader()));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; accepts: unknown[] };
    expect(body.error).toBe('signature_mismatch');
    expect(body.accepts).toHaveLength(1);
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('正しい payment → verify→settle 後に demo JSON + X-PAYMENT-RESPONSE', async () => {
    routeMocks.verify.mockResolvedValue(NextResponse.json({ isValid: true, payer: PAYER }));
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { demo } = await load();
    const res = await demo.GET(req('/api/paid/demo', paymentHeader()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; paidAt: string; payer: string };
    expect(body.message).toBe('Payment verified — welcome to the x402 + JPYC rail.');
    expect(body.payer).toBe(PAYER);
    expect(Date.parse(body.paidAt)).not.toBeNaN();
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);

    const sentVerify = (await routeMocks.verify.mock.calls[0][0].json()) as {
      paymentPayload: unknown;
      paymentRequirements: { resource: string };
    };
    expect(sentVerify.paymentPayload).toEqual(paymentPayload());
    expect(sentVerify.paymentRequirements.resource).toBe(
      'https://open-pay.jp/api/paid/demo',
    );
    const paymentResponse = JSON.parse(
      Buffer.from(res.headers.get('x-payment-response') ?? '', 'base64').toString('utf8'),
    );
    expect(paymentResponse).toMatchObject({ success: true, transaction: TX_HASH, payer: PAYER });
  });

  it('/api/paid/stores は ExploreEntry の公開 JSON を返す', async () => {
    routeMocks.verify.mockResolvedValue(NextResponse.json({ isValid: true, payer: PAYER }));
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({ success: true, transaction: TX_HASH, network: 'eip155:80002' }),
    );
    const { stores } = await load();
    const res = await stores.GET(req('/api/paid/stores', paymentHeader()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ name: string; category: string; url: string; description?: unknown }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toMatchObject({
      name: 'JPYC EX',
      category: 'exchange',
      url: 'https://jpyc.co.jp/',
    });
    expect(body.items[0].description).toBeUndefined();
  });
});
