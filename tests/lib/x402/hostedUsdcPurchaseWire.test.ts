import { describe, expect, it } from 'vitest';
import {
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  buildHostedUsdcPurchaseTypedData,
  createHostedUsdcAuthorization,
  encodeHostedUsdcPaymentHeader,
  HOSTED_USDC_ADDRESS,
  HOSTED_USDC_CHAIN_ID,
  hostedUsdcPaymentSnapshotMatchesQuote,
  HostedUsdcPurchaseWireError,
  normalizeHostedUsdcPaymentRequired,
  normalizeHostedUsdcPaymentSnapshot,
} from '@/lib/x402/hostedUsdcPurchaseWire';

const NOW = 1_800_000_000_000;
const RESOURCE_ID = 'h_usdc-product';
const TITLE = 'Base USDC 商品';
const PRICE_JPYC = '300';
const MERCHANT = getAddress(
  '0x1111111111111111111111111111111111111111',
);
const PAYER = getAddress('0x2222222222222222222222222222222222222222');
const INTENT_SALT = `0x${'33'.repeat(32)}` as Hex;
const SERVER_NONCE = keccak256(
  stringToHex(
    `openpay:creator-store-usdc-vanilla-v1:${INTENT_SALT}`,
  ),
);
const SIGNATURE = `0x${'55'.repeat(65)}` as Hex;
const RATE_FETCHED_AT = NOW - 60_000;
const QUOTE_EXPIRES_AT = NOW + 120_000;

function paymentRequired(): Record<string, unknown> {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '2000000',
        resource: `https://open-pay.jp/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}&rail=usdc`,
        description: TITLE,
        mimeType: 'application/json',
        payTo: MERCHANT,
        maxTimeoutSeconds: 180,
        asset: HOSTED_USDC_ADDRESS,
        extra: {
          name: 'USD Coin',
          version: '2',
          decimals: 6,
          assetTransferMethod: 'eip3009',
          openpay: {
            rail: 'usdc',
            deploymentVersion: 'creator-store-usdc-vanilla-v1',
            intentSalt: INTENT_SALT,
            nonce: SERVER_NONCE,
            usdcQuoteAtomic: '2000000',
            priceJpyc: PRICE_JPYC,
            rateScaled: '150000000',
            rateFetchedAt: RATE_FETCHED_AT,
            fxQuoteExpiresAt: QUOTE_EXPIRES_AT,
            rounding: 'ceil',
            authorizationValidBeforeMax: String(
              Math.floor(QUOTE_EXPIRES_AT / 1_000),
            ),
          },
        },
      },
    ],
  };
}

function binding() {
  return {
    selectedRail: 'usdc' as const,
    resourceId: RESOURCE_ID,
    title: TITLE,
    priceJpyc: PRICE_JPYC,
    merchant: MERCHANT,
    payer: PAYER,
  };
}

function accept(body: Record<string, unknown>): Record<string, unknown> {
  return (body.accepts as Record<string, unknown>[])[0]!;
}

function openpay(body: Record<string, unknown>): Record<string, unknown> {
  return (accept(body).extra as { openpay: Record<string, unknown> }).openpay;
}

function expectWireCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error('expected normalizer to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(HostedUsdcPurchaseWireError);
    expect((error as HostedUsdcPurchaseWireError).code).toBe(code);
  }
}

describe('hostedUsdcPurchaseWire', () => {
  it('Base native USDC の server quote/nonce だけで typed data と v1 header を組む', () => {
    const quote = normalizeHostedUsdcPaymentRequired(
      paymentRequired(),
      binding(),
      NOW,
    );
    expect(quote).toMatchObject({
      rail: 'usdc',
      chainId: HOSTED_USDC_CHAIN_ID,
      asset: HOSTED_USDC_ADDRESS,
      merchant: MERCHANT,
      intentSalt: INTENT_SALT,
      nonce: SERVER_NONCE,
      usdcQuoteAtomic: 2_000_000n,
      paidUsdc: '2',
      priceJpyc: PRICE_JPYC,
      payment: {
        version: 1,
        rail: 'usdc',
        paidAtomic: '2000000',
        priceJpyc: PRICE_JPYC,
      },
    });

    const authorization = createHostedUsdcAuthorization(
      quote,
      PAYER,
      Math.floor(NOW / 1_000),
    );
    expect(authorization).toEqual({
      from: PAYER,
      to: MERCHANT,
      value: '2000000',
      validAfter: '0',
      validBefore: String(Math.floor(QUOTE_EXPIRES_AT / 1_000)),
      nonce: SERVER_NONCE,
    });
    const typed = buildHostedUsdcPurchaseTypedData(quote, authorization);
    expect(typed).toMatchObject({
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: HOSTED_USDC_ADDRESS,
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: PAYER,
        to: MERCHANT,
        value: 2_000_000n,
        validAfter: 0n,
        nonce: SERVER_NONCE,
      },
    });
    const decoded = JSON.parse(
      Buffer.from(
        encodeHostedUsdcPaymentHeader(quote, authorization, SIGNATURE),
        'base64',
      ).toString('utf8'),
    );
    expect(decoded).toEqual({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { signature: SIGNATURE, authorization },
    });
  });

  it.each([
    {
      name: 'network',
      code: 'network_mismatch',
      mutate: (body: Record<string, unknown>) => {
        accept(body).network = 'eip155:8453';
      },
    },
    {
      name: 'native asset',
      code: 'asset_mismatch',
      mutate: (body: Record<string, unknown>) => {
        accept(body).asset = '0x9999999999999999999999999999999999999999';
      },
    },
    {
      name: 'EIP-712 domain',
      code: 'domain_mismatch',
      mutate: (body: Record<string, unknown>) => {
        (accept(body).extra as Record<string, unknown>).name = 'USDC';
      },
    },
    {
      name: 'seller payTo',
      code: 'merchant_mismatch',
      mutate: (body: Record<string, unknown>) => {
        accept(body).payTo = PAYER;
      },
    },
    {
      name: 'selected resource',
      code: 'product_mismatch',
      mutate: (body: Record<string, unknown>) => {
        accept(body).resource =
          `https://open-pay.jp/api/paid/hosted/h_other?payer=${PAYER}&rail=usdc`;
      },
    },
    {
      name: 'selected rail',
      code: 'rail_mismatch',
      mutate: (body: Record<string, unknown>) => {
        openpay(body).rail = 'jpyc';
      },
    },
    {
      name: 'card price',
      code: 'price_mismatch',
      mutate: (body: Record<string, unknown>) => {
        openpay(body).priceJpyc = '301';
      },
    },
    {
      name: 'canonical quote amount',
      code: 'amount_mismatch',
      mutate: (body: Record<string, unknown>) => {
        openpay(body).usdcQuoteAtomic = '1999999';
      },
    },
    {
      name: 'deployment version',
      code: 'intent_mismatch',
      mutate: (body: Record<string, unknown>) => {
        openpay(body).deploymentVersion = 'creator-store-usdc-v2';
      },
    },
    {
      name: 'server nonce',
      code: 'server_nonce_required',
      mutate: (body: Record<string, unknown>) => {
        delete openpay(body).nonce;
      },
    },
    {
      name: '別 intent の nonce',
      code: 'server_nonce_required',
      mutate: (body: Record<string, unknown>) => {
        openpay(body).nonce = `0x${'99'.repeat(32)}`;
      },
    },
    {
      name: 'quote audit expiry',
      code: 'intent_mismatch',
      mutate: (body: Record<string, unknown>) => {
        openpay(body).fxQuoteExpiresAt = RATE_FETCHED_AT + 180_001;
      },
    },
  ])('$name 改竄を署名前に拒否する', ({ code, mutate }) => {
    const body = paymentRequired();
    mutate(body);
    expectWireCode(
      () => normalizeHostedUsdcPaymentRequired(body, binding(), NOW),
      code,
    );
  });

  it('期限切れ quote と曖昧な複数 accepts を拒否する', () => {
    expectWireCode(
      () =>
        normalizeHostedUsdcPaymentRequired(
          paymentRequired(),
          binding(),
          QUOTE_EXPIRES_AT,
        ),
      'quote_expired',
    );
    const body = paymentRequired();
    body.accepts = [accept(body), structuredClone(accept(body))];
    expectWireCode(
      () => normalizeHostedUsdcPaymentRequired(body, binding(), NOW),
      'invalid_402',
    );
  });

  it('P1 payment snapshot を厳格 parse し、402 quote と一致するものだけ採用する', () => {
    const quote = normalizeHostedUsdcPaymentRequired(
      paymentRequired(),
      binding(),
      NOW,
    );
    expect(normalizeHostedUsdcPaymentSnapshot(quote.payment)).toEqual(
      quote.payment,
    );
    expect(hostedUsdcPaymentSnapshotMatchesQuote(quote.payment, quote)).toBe(
      true,
    );

    const tampered = structuredClone(quote.payment) as unknown as {
      paidAtomic: string;
      asset: Address;
    };
    tampered.paidAtomic = '2000001';
    expect(hostedUsdcPaymentSnapshotMatchesQuote(tampered, quote)).toBe(false);
    tampered.asset = PAYER;
    expect(normalizeHostedUsdcPaymentSnapshot(tampered)).toBeNull();
  });
});
