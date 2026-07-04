import { describe, expect, it } from 'vitest';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import {
  buildPaymentRequiredV2,
  decodePaymentSignatureHeaderValue,
  encodePaymentRequiredHeaderValue,
  encodePaymentResponseHeaderValue,
  toV2Accept,
  v2PayloadToV1Body,
  type PaymentPayloadV2,
  type PaymentRequirementsV1,
} from '@/lib/x402/v2';

const PAYER = '0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA';
const PAY_TO = '0x752b7aad0089286eb7b553d84d05233d80c9fcb4';
const SELLER = '0x1234567890123456789012345678901234567890';
const FEE_RECEIVER = '0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e';
const ASSET = '0x00000000000000000000000000000000000Ca11a';
const TX_HASH = `0x${'ab'.repeat(32)}`;

const v1Requirement = {
  scheme: 'exact',
  network: 'eip155:80002',
  maxAmountRequired: '3000000000000000000',
  resource: 'https://open-pay.jp/api/paid/demo',
  description: 'OpenPay x402 demo',
  mimeType: 'application/json',
  payTo: PAY_TO,
  maxTimeoutSeconds: 600,
  asset: ASSET,
  extra: {
    name: 'JPY Coin',
    version: '1',
    decimals: 18,
    assetTransferMethod: 'eip3009',
    openpay: {
      mode: 'forwarder-split',
      forwarder: PAY_TO,
      merchant: SELLER,
      merchantValue: '1000000000000000000',
      feeReceiver: FEE_RECEIVER,
      feeValue: '2000000000000000000',
      commitVersion: `0x${'01'.repeat(32)}`,
    },
  },
} satisfies PaymentRequirementsV1;

function paymentPayloadV2(): PaymentPayloadV2 {
  return {
    x402Version: 2,
    resource: {
      url: v1Requirement.resource,
      description: v1Requirement.description,
      mimeType: v1Requirement.mimeType,
    },
    accepted: toV2Accept(v1Requirement),
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

describe('x402 v2 wire helpers', () => {
  it('encodes PaymentRequiredV2 and SettleResponse byte-compatible with @x402/core/http', () => {
    const required = buildPaymentRequiredV2({
      url: v1Requirement.resource,
      description: v1Requirement.description,
      mimeType: v1Requirement.mimeType,
      accepts: [toV2Accept(v1Requirement)],
      bazaarInfo: {
        input: { type: 'http', method: 'GET', discoverable: true },
        output: { type: 'object' },
      },
      error: 'payment_required',
    });
    const requiredHeader = encodePaymentRequiredHeaderValue(required);
    expect(requiredHeader).toBe(
      encodePaymentRequiredHeader(
        required as Parameters<typeof encodePaymentRequiredHeader>[0],
      ),
    );
    expect(decodePaymentRequiredHeader(requiredHeader)).toEqual(required);

    const settleResponse = {
      success: true,
      transaction: TX_HASH,
      network: 'eip155:80002',
      payer: PAYER,
    };
    const responseHeader = encodePaymentResponseHeaderValue(settleResponse);
    expect(responseHeader).toBe(
      encodePaymentResponseHeader(
        settleResponse as Parameters<typeof encodePaymentResponseHeader>[0],
      ),
    );
    expect(decodePaymentResponseHeader(responseHeader)).toEqual(settleResponse);
  });

  it('decodes official @x402/core PaymentPayloadV2 signature headers', () => {
    const payload = paymentPayloadV2();
    const officialHeader = encodePaymentSignatureHeader(
      payload as Parameters<typeof encodePaymentSignatureHeader>[0],
    );

    expect(decodePaymentSignatureHeaderValue(officialHeader)).toEqual(
      decodePaymentSignatureHeader(officialHeader),
    );
    expect(decodePaymentSignatureHeaderValue(officialHeader)).toEqual(payload);
  });

  it('converts only when the accepted v2 requirement strictly matches the original v1 requirement', () => {
    const payload = paymentPayloadV2();
    const payloadExtra = payload.accepted.extra as Record<string, unknown> & {
      openpay: Record<string, unknown>;
    };

    expect(v2PayloadToV1Body(payload, [v1Requirement])).toEqual({
      x402Version: 1,
      paymentPayload: {
        x402Version: 1,
        scheme: 'exact',
        network: 'eip155:80002',
        payload: payload.payload,
      },
      paymentRequirements: v1Requirement,
    });

    expect(
      v2PayloadToV1Body(
        {
          ...payload,
          accepted: { ...payload.accepted, amount: '4000000000000000000' },
        },
        [v1Requirement],
      ),
    ).toBeNull();
    expect(
      v2PayloadToV1Body(
        {
          ...payload,
          accepted: {
            ...payload.accepted,
            payTo: '0x000000000000000000000000000000000000dEaD',
          },
        },
        [v1Requirement],
      ),
    ).toBeNull();
    expect(
      v2PayloadToV1Body(
        {
          ...payload,
          accepted: {
            ...payload.accepted,
            extra: {
              ...payloadExtra,
              openpay: {
                ...payloadExtra.openpay,
                feeValue: '1',
              },
            },
          },
        },
        [v1Requirement],
      ),
    ).toBeNull();
  });
});
