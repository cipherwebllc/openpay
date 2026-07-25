import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getAddress } from 'viem';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayloadV2, PaymentRequiredV2 } from '@/lib/x402/v2';

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

function exactPayload() {
  return {
    signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}21b`,
    authorization: {
      from: PAYER,
      validAfter: '0',
      validBefore: '9999999999',
      intentSalt: `0x${'22'.repeat(32)}`,
    },
  };
}

function req(path: string, headers?: HeadersInit): Request {
  return new Request(`http://test.local${path}`, { headers });
}

async function load(flag = '1'): Promise<{ demo: PaidRoute }> {
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
  return { demo };
}

async function paymentRequired(demo: PaidRoute): Promise<PaymentRequiredV2> {
  const res = await demo.GET(req('/api/paid/demo'));
  expect(res.status).toBe(402);
  const header = res.headers.get('PAYMENT-REQUIRED');
  expect(header).toBeTruthy();
  return decodePaymentRequiredHeader(header ?? '') as PaymentRequiredV2;
}

function paymentSignature(payload: PaymentPayloadV2): string {
  return encodePaymentSignatureHeader(
    payload as Parameters<typeof encodePaymentSignatureHeader>[0],
  );
}

function payloadFor(required: PaymentRequiredV2): PaymentPayloadV2 {
  return {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: exactPayload(),
  };
}

beforeEach(() => {
  routeMocks.verify.mockReset();
  routeMocks.settle.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('first-party paid x402 v2 routes', () => {
  it('402 challenge keeps the v1 JSON body and adds PAYMENT-REQUIRED v2 header', async () => {
    const { demo } = await load();
    const res = await demo.GET(new Request('https://open-pay.jp/api/paid/demo'));
    expect(res.status).toBe(402);

    const body = (await res.json()) as {
      x402Version: 1;
      accepts: Array<{
        resource: string;
        maxAmountRequired: string;
        outputSchema?: { input?: { type: string; method: string; discoverable: boolean } };
      }>;
      error: string;
    };
    expect(body).toMatchObject({
      x402Version: 1,
      error: 'payment_required',
    });
    expect(body.accepts[0]).toMatchObject({
      resource: 'https://open-pay.jp/api/paid/demo',
      maxAmountRequired: (3n * 10n ** 18n).toString(),
    });

    const header = res.headers.get('PAYMENT-REQUIRED');
    expect(header).toBeTruthy();
    const required = decodePaymentRequiredHeader(header ?? '') as PaymentRequiredV2;
    expect(required.x402Version).toBe(2);
    expect(required.resource).toEqual({
      url: 'https://open-pay.jp/api/paid/demo',
      description: 'OpenPay x402 demo — pay 1 JPYC and unlock a signed hello.',
      mimeType: 'application/json',
    });
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:80002',
      amount: body.accepts[0].maxAmountRequired,
      asset: JPYC_AMOY,
      payTo: FORWARDER,
      maxTimeoutSeconds: 600,
    });
    expect(required.accepts[0]).not.toHaveProperty('maxAmountRequired');
    expect(required.extensions).toEqual({
      bazaar: {
        info: body.accepts[0].outputSchema,
      },
    });
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('PAYMENT-SIGNATURE v2 payment verifies, settles, and returns both response headers', async () => {
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
    const required = await paymentRequired(demo);
    const v2Payload = payloadFor(required);
    const res = await demo.GET(
      req('/api/paid/demo', {
        'PAYMENT-SIGNATURE': paymentSignature(v2Payload),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeTruthy();
    const paymentResponse = res.headers.get('PAYMENT-RESPONSE');
    expect(paymentResponse).toBeTruthy();
    expect(decodePaymentResponseHeader(paymentResponse ?? '')).toMatchObject({
      success: true,
      transaction: TX_HASH,
      network: 'eip155:80002',
      payer: PAYER,
    });
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);

    const sentVerify = (await routeMocks.verify.mock.calls[0][0].json()) as {
      x402Version: 1;
      paymentPayload: unknown;
      paymentRequirements: { maxAmountRequired: string; payTo: string; extra: unknown };
    };
    expect(sentVerify.paymentPayload).toEqual({
      x402Version: 1,
      scheme: 'exact',
      network: 'eip155:80002',
      payload: exactPayload(),
    });
    expect(sentVerify.paymentRequirements.maxAmountRequired).toBe(
      required.accepts[0].amount,
    );
    expect(sentVerify.paymentRequirements.payTo).toBe(FORWARDER);
  });

  it.each([
    [
      'amount',
      (payload: PaymentPayloadV2): PaymentPayloadV2 => ({
        ...payload,
        accepted: { ...payload.accepted, amount: '4000000000000000000' },
      }),
    ],
    [
      'payTo',
      (payload: PaymentPayloadV2): PaymentPayloadV2 => ({
        ...payload,
        accepted: {
          ...payload.accepted,
          payTo: '0x000000000000000000000000000000000000dEaD',
        },
      }),
    ],
    [
      'extra.openpay.feeValue',
      (payload: PaymentPayloadV2): PaymentPayloadV2 => {
        const extra = payload.accepted.extra as {
          openpay: Record<string, unknown>;
        };
        return {
          ...payload,
          accepted: {
            ...payload.accepted,
            extra: {
              ...extra,
              openpay: {
                ...extra.openpay,
                feeValue: '1',
              },
            },
          },
        };
      },
    ],
  ])(
    'tampered v2 accepted.%s is rejected before facilitator dispatch',
    async (_field, tamper) => {
      const { demo } = await load();
      const required = await paymentRequired(demo);
      const res = await demo.GET(
        req('/api/paid/demo', {
          'PAYMENT-SIGNATURE': paymentSignature(tamper(payloadFor(required))),
        }),
      );

      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe('invalid_payment_payload');
      expect(routeMocks.verify).not.toHaveBeenCalled();
      expect(routeMocks.settle).not.toHaveBeenCalled();
    },
  );
});
