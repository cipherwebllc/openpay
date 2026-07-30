import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const FORWARDER =
  '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4' as Address;
const MERCHANT =
  '0x2222222222222222222222222222222222222222' as Address;
const FEE_RECEIVER =
  '0x3333333333333333333333333333333333333333' as Address;
const PAYER =
  '0x1111111111111111111111111111111111111111' as Address;
const JPYC =
  '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
const INTENT_SALT = `0x${'ab'.repeat(32)}` as Hex;
const SIGNATURE = `0x${'cd'.repeat(65)}` as Hex;
const PRICE_JPYC = '1200';
const PRICE = 1_200n * 10n ** 18n;
const FEE = 12n * 10n ** 18n;

vi.mock('@/lib/env', () => ({
  env: {
    networkEnv: 'testnet',
    feeReceiver: '0x3333333333333333333333333333333333333333',
    feeReceiverConfigured: true,
  },
}));

vi.mock('@/lib/relay/forwarderConfig', () => ({
  configuredJpycForwarderFor: () =>
    '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));

import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';
import {
  buildHostedPurchaseSignPreview,
  buildHostedPurchaseTypedData,
  createHostedPurchaseAuthorization,
  encodeHostedPaymentHeader,
  HostedPurchaseWireError,
  hostedPaymentPayload,
  hostedPurchaseFeeValue,
  normalizeHostedPaymentRequired,
} from '@/lib/x402/hostedPurchaseWire';

type SdkPaymentModule = {
  buildTypedDataFromPaymentRequirements: (
    accept: unknown,
    authorization: {
      from: Address;
      validAfter: string;
      validBefore: string;
      intentSalt: Hex;
    },
  ) => { accept: unknown; typedData: unknown };
  encodePaymentPayload: (payload: unknown) => string;
  paymentPayloadFor: (
    accept: { scheme: string; network: string },
    authorization: unknown,
    signature: Hex,
  ) => unknown;
};

let sdk: SdkPaymentModule;

beforeAll(async () => {
  const path = resolve(
    process.cwd(),
    'packages/x402-sdk/src/payment.mjs',
  );
  sdk = (await import(pathToFileURL(path).href)) as SdkPaymentModule;
});

function paymentRequired(): Record<string, unknown> {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:80002',
        maxAmountRequired: (PRICE + FEE).toString(),
        resource: `https://open-pay.jp/api/paid/hosted/h_fixture?payer=${PAYER}`,
        description: 'Fixture product',
        mimeType: 'application/json',
        payTo: FORWARDER,
        maxTimeoutSeconds: 600,
        asset: JPYC,
        extra: {
          name: 'JPY Coin',
          version: '1',
          decimals: 18,
          assetTransferMethod: 'eip3009',
          openpay: {
            mode: 'forwarder-split',
            forwarder: FORWARDER,
            merchant: MERCHANT,
            merchantValue: PRICE.toString(),
            feeReceiver: FEE_RECEIVER,
            feeValue: FEE.toString(),
            commitVersion: FORWARDER_COMMIT_VERSION,
            intentSalt: INTENT_SALT,
            authorizationValidBeforeMax: '2000000000',
            deploymentVersion: 'creator-store-v1',
          },
        },
      },
    ],
    error: 'payment_required',
  };
}

function mutateAccept(
  mutate: (accept: Record<string, unknown>) => void,
): Record<string, unknown> {
  const body = structuredClone(paymentRequired());
  mutate((body.accepts as Record<string, unknown>[])[0]);
  return body;
}

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(HostedPurchaseWireError);
    return (error as HostedPurchaseWireError).code;
  }
}

describe('hostedPurchaseWire', () => {
  it('SDK normalize/build と typed-data・v1 X-PAYMENT byte が完全一致する', () => {
    const body = paymentRequired();
    const rawAccept = (body.accepts as unknown[])[0];
    const quote = normalizeHostedPaymentRequired(
      body,
      PRICE_JPYC,
      MERCHANT,
    );
    const authorization = createHostedPurchaseAuthorization(
      quote,
      PAYER,
      1_900_000_000,
    );

    const oursTypedData = buildHostedPurchaseTypedData(
      quote,
      authorization,
    );
    const sdkBuilt = sdk.buildTypedDataFromPaymentRequirements(
      rawAccept,
      authorization,
    );

    expect(authorization).toEqual({
      from: PAYER,
      validAfter: '0',
      validBefore: '1900000600',
      // server 発行 salt が byte/case とも変わらず署名素材へ入る。
      intentSalt: INTENT_SALT,
    });
    expect(oursTypedData).toEqual(sdkBuilt.typedData);

    const oursPayload = hostedPaymentPayload(
      quote,
      authorization,
      SIGNATURE,
    );
    const sdkPayload = sdk.paymentPayloadFor(
      sdkBuilt.accept as { scheme: string; network: string },
      authorization,
      SIGNATURE,
    );
    expect(oursPayload).toEqual(sdkPayload);
    expect(encodeHostedPaymentHeader(oursPayload)).toBe(
      sdk.encodePaymentPayload(sdkPayload),
    );
  });

  it('validBefore=min(server上限, now+10分)、validAfter=0', () => {
    const body = paymentRequired();
    const openpay = (
      (
        (body.accepts as Record<string, unknown>[])[0]
          .extra as Record<string, unknown>
      ).openpay as Record<string, unknown>
    );
    openpay.authorizationValidBeforeMax = '1900000123';
    const quote = normalizeHostedPaymentRequired(
      body,
      PRICE_JPYC,
      MERCHANT,
    );

    expect(
      createHostedPurchaseAuthorization(quote, PAYER, 1_900_000_000),
    ).toMatchObject({
      validAfter: '0',
      validBefore: '1900000123',
      intentSalt: INTENT_SALT,
    });
  });

  it('SignReassurance preview は検証済み wire の金額・宛先・10分期限をそのまま使う', () => {
    const quote = normalizeHostedPaymentRequired(
      paymentRequired(),
      PRICE_JPYC,
      MERCHANT,
    );

    expect(
      buildHostedPurchaseSignPreview(quote, 'Fixture product'),
    ).toEqual({
      kind: 'jpyc-recover',
      amountHuman: '1200',
      feeHuman: '12',
      totalHuman: '1212',
      totalAtomic: (PRICE + FEE).toString(),
      merchant: MERCHANT,
      forwarder: FORWARDER,
      storeName: 'Fixture product',
      gasMode: 'customer',
      expiresInMin: 10,
      decimals: 18,
      symbol: 'JPYC',
    });
  });

  it('SignReassurance preview は短いserver期限を分単位で切り捨てて表示する', () => {
    const body = paymentRequired();
    const openpay = (
      (
        (body.accepts as Record<string, unknown>[])[0]
          .extra as Record<string, unknown>
      ).openpay as Record<string, unknown>
    );
    openpay.authorizationValidBeforeMax = '1900000299';
    const quote = normalizeHostedPaymentRequired(
      body,
      PRICE_JPYC,
      MERCHANT,
    );

    expect(
      buildHostedPurchaseSignPreview(
        quote,
        'Fixture product',
        1_900_000_000,
      ).expiresInMin,
    ).toBe(4);
    expect(
      buildHostedPurchaseSignPreview(
        quote,
        'Fixture product',
        1_900_000_300,
      ).expiresInMin,
    ).toBe(0);
  });

  it('手数料は max(1 JPYC, merchantValueの1%)', () => {
    expect(hostedPurchaseFeeValue(10n * 10n ** 18n)).toBe(
      1n * 10n ** 18n,
    );
    expect(hostedPurchaseFeeValue(1_200n * 10n ** 18n)).toBe(
      12n * 10n ** 18n,
    );
  });

  it('maxTimeoutSeconds が10分より短ければ署名期限と表示の両方を短縮する', () => {
    const body = mutateAccept((accept) => {
      accept.maxTimeoutSeconds = 90;
    });
    const quote = normalizeHostedPaymentRequired(
      body,
      PRICE_JPYC,
      MERCHANT,
    );

    expect(
      createHostedPurchaseAuthorization(quote, PAYER, 1_900_000_000),
    ).toMatchObject({
      validAfter: '0',
      validBefore: '1900000090',
    });
    expect(
      buildHostedPurchaseSignPreview(
        quote,
        'Fixture product',
        1_900_000_000,
      ).expiresInMin,
    ).toBe(1);
  });

  it.each([
    {
      label: 'commitVersion 不一致',
      expected: 'commit_version_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        const extra = accept.extra as Record<string, unknown>;
        const openpay = extra.openpay as Record<string, unknown>;
        openpay.commitVersion = `0x${'12'.repeat(32)}`;
      },
    },
    {
      label: 'asset 不一致',
      expected: 'asset_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        accept.asset = '0x4444444444444444444444444444444444444444';
      },
    },
    {
      label: 'Polygon 以外の network',
      expected: 'network_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        accept.network = 'eip155:8217';
      },
    },
    {
      label: 'merchantValue + feeValue と amount 不一致',
      expected: 'amount_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        accept.maxAmountRequired = (PRICE + FEE + 1n).toString();
      },
    },
    {
      label: 'intentSalt 欠落',
      expected: 'intent_salt_required',
      mutate: (accept: Record<string, unknown>) => {
        const extra = accept.extra as Record<string, unknown>;
        const openpay = extra.openpay as Record<string, unknown>;
        delete openpay.intentSalt;
      },
    },
    {
      label: 'card price と merchantValue 不一致',
      expected: 'price_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        const extra = accept.extra as Record<string, unknown>;
        const openpay = extra.openpay as Record<string, unknown>;
        openpay.merchantValue = (PRICE + 10n ** 18n).toString();
      },
    },
    {
      label: '手数料式不一致',
      expected: 'fee_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        const extra = accept.extra as Record<string, unknown>;
        const openpay = extra.openpay as Record<string, unknown>;
        openpay.feeValue = (FEE + 1n).toString();
      },
    },
    {
      label: 'forwarder 不一致',
      expected: 'forwarder_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        const extra = accept.extra as Record<string, unknown>;
        const openpay = extra.openpay as Record<string, unknown>;
        openpay.forwarder =
          '0x5555555555555555555555555555555555555555';
        accept.payTo = openpay.forwarder;
      },
    },
    {
      label: 'merchant 不一致',
      expected: 'merchant_mismatch',
      mutate: (accept: Record<string, unknown>) => {
        const extra = accept.extra as Record<string, unknown>;
        const openpay = extra.openpay as Record<string, unknown>;
        openpay.merchant =
          '0x5555555555555555555555555555555555555555';
      },
    },
  ])('$label は署名前 validation で拒否', ({ mutate, expected }) => {
    expect(
      errorCode(() =>
        normalizeHostedPaymentRequired(
          mutateAccept(mutate),
          PRICE_JPYC,
          MERCHANT,
        ),
      ),
    ).toBe(expected);
  });

  it('accepts が 0件/複数件なら曖昧選択せず拒否する', () => {
    const empty = paymentRequired();
    empty.accepts = [];
    const multiple = paymentRequired();
    multiple.accepts = [
      ...(multiple.accepts as unknown[]),
      ...(multiple.accepts as unknown[]),
    ];

    expect(
      errorCode(() =>
        normalizeHostedPaymentRequired(empty, PRICE_JPYC, MERCHANT),
      ),
    ).toBe('invalid_402');
    expect(
      errorCode(() =>
        normalizeHostedPaymentRequired(
          multiple,
          PRICE_JPYC,
          MERCHANT,
        ),
      ),
    ).toBe('invalid_402');
  });
});
