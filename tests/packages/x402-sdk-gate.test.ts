import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

type PaymentResponse = { paymentResponseHeader: string };
type VerifiedPayment = {
  settle: () => Promise<Response | PaymentResponse>;
};
type Gate = {
  handle: (request: Request) => Promise<Response | PaymentResponse>;
  verify: (request: Request) => Promise<Response | VerifiedPayment>;
};
type SdkModule = {
  createJpycGate: (options: {
    resourceUrl: string;
    openpayOrigin?: string;
    fetchImpl?: typeof globalThis.fetch;
    now?: () => number;
    maxUpstreamSeconds?: number;
    settlementGraceSeconds?: number;
  }) => Gate;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const OPENPAY_ORIGIN = 'https://openpay.test';
const RESOURCE = 'https://seller.test/api/paid/report';
const REQUEST_URL = `${RESOURCE}?locale=ja&topic=%E6%B1%BA%E6%B8%88`;

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function catalogAccept(resource = RESOURCE) {
  return {
    scheme: 'exact',
    network: 'eip155:137',
    maxAmountRequired: '1250000000000000000',
    resource,
    description: 'paid report',
    mimeType: 'application/json',
    payTo: '0x4444444444444444444444444444444444444444',
    maxTimeoutSeconds: 600,
    asset: '0x1111111111111111111111111111111111111111',
    extra: {
      name: 'JPY Coin',
      version: '1',
      decimals: 18,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder: '0x4444444444444444444444444444444444444444',
        merchant: '0x2222222222222222222222222222222222222222',
        merchantValue: '1000000000000000000',
        feeReceiver: '0x3333333333333333333333333333333333333333',
        feeValue: '250000000000000000',
        commitVersion: `0x${'a'.repeat(64)}`,
      },
    },
  };
}

function paymentPayload(
  intentSaltByte = '1',
  validBefore = String(Math.floor(Date.now() / 1000) + 600),
) {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:137',
    payload: {
      signature: `0x${'b'.repeat(130)}`,
      authorization: {
        from: '0x5555555555555555555555555555555555555555',
        validAfter: '0',
        validBefore,
        intentSalt: `0x${intentSaltByte.repeat(64)}`,
      },
    },
  };
}

function edgeBase64Encode(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function edgeBase64Decode(value: string) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function createFetchMock({
  accepts = [catalogAccept()],
  verification = { isValid: true },
  settlement = { success: true, transaction: '0xsettled' },
}: {
  accepts?: Array<Record<string, unknown>>;
  verification?: unknown;
  settlement?: unknown;
} = {}) {
  const order: string[] = [];
  const facilitatorBodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${OPENPAY_ORIGIN}/api/discovery`) {
        order.push('discovery');
        return jsonResponse({ items: [{ resource: RESOURCE, accepts }] });
      }
      if (url === `${OPENPAY_ORIGIN}/api/facilitator/verify`) {
        order.push('verify');
        facilitatorBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse(verification);
      }
      if (url === `${OPENPAY_ORIGIN}/api/facilitator/settle`) {
        order.push('settle');
        facilitatorBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse(settlement);
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  );
  return { fetchImpl, facilitatorBodies, order };
}

async function read402(value: Response | object) {
  expect(value).toBeInstanceOf(Response);
  const response = value as Response;
  expect(response.status).toBe(402);
  expect(response.headers.get('content-type')).toBe('application/json');
  return response.json() as Promise<{
    x402Version: number;
    accepts: Array<Record<string, unknown>>;
    error: string;
  }>;
}

describe('openpay-x402-sdk seller gate', () => {
  it('returns a request-specific 402 without changing catalog money fields', async () => {
    const firstAccept = catalogAccept();
    const secondAccept = catalogAccept(`${RESOURCE}#catalog-copy`);
    const { fetchImpl, order } = createFetchMock({
      accepts: [firstAccept, secondAccept],
    });
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: `${OPENPAY_ORIGIN}/`,
      fetchImpl,
    });

    const body = await read402(await gate.handle(new Request(REQUEST_URL)));

    expect(body).toMatchObject({ x402Version: 1, error: 'payment_required' });
    expect(body.accepts.map((accept) => accept.resource)).toEqual([
      REQUEST_URL,
      REQUEST_URL,
    ]);
    expect(body.accepts[0]).toMatchObject({
      network: firstAccept.network,
      asset: firstAccept.asset,
      payTo: firstAccept.payTo,
      maxAmountRequired: firstAccept.maxAmountRequired,
      extra: { openpay: firstAccept.extra.openpay },
    });
    expect(firstAccept.resource).toBe(RESOURCE);
    expect(order).toEqual(['discovery']);
  });

  it('returns invalid_payment_payload for malformed base64', async () => {
    const { fetchImpl, order } = createFetchMock();
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': '%%%not-base64%%%' },
    });

    const body = await read402(await gate.handle(request));

    expect(body.error).toBe('invalid_payment_payload');
    expect(order).toEqual(['discovery']);
  });

  it.each([
    [{ isValid: false, invalidReason: 'signature_invalid' }, 'signature_invalid'],
    [{ isValid: false }, 'payment_invalid'],
  ])(
    'does not settle after verify rejection %#',
    async (verification, expectedError) => {
      const { fetchImpl, order } = createFetchMock({ verification });
      const sdk = await loadSdk();
      const gate = sdk.createJpycGate({
        resourceUrl: RESOURCE,
        openpayOrigin: OPENPAY_ORIGIN,
        fetchImpl,
      });
      const request = new Request(REQUEST_URL, {
        headers: { 'X-PAYMENT': edgeBase64Encode({ payer: '0xbuyer' }) },
      });

      const body = await read402(await gate.handle(request));

      expect(body.error).toBe(expectedError);
      expect(order).toEqual(['discovery', 'verify']);
    },
  );

  it('returns a 402 with the settlement fallback reason', async () => {
    const { fetchImpl, order } = createFetchMock({
      settlement: { success: false },
    });
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode({ payer: '0xbuyer' }) },
    });

    const body = await read402(await gate.handle(request));

    expect(body.error).toBe('settlement_failed');
    expect(order).toEqual(['discovery', 'verify', 'settle']);
  });

  it('round-trips UTF-8 payment and settlement JSON through Edge base64 APIs', async () => {
    const paymentPayload = { memo: '日本語の支払い', emoji: '💴' };
    const settlement = {
      success: true,
      transaction: '0xsettled',
      receipt: '決済済み ✅',
    };
    const { fetchImpl, facilitatorBodies, order } = createFetchMock({
      settlement,
    });
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode(paymentPayload) },
    });

    const result = await gate.handle(request);

    expect(result).not.toBeInstanceOf(Response);
    expect(edgeBase64Decode((result as PaymentResponse).paymentResponseHeader)).toEqual(
      settlement,
    );
    expect(facilitatorBodies).toEqual([
      {
        x402Version: 1,
        paymentPayload,
        paymentRequirements: { ...catalogAccept(), resource: REQUEST_URL },
      },
      {
        x402Version: 1,
        paymentPayload,
        paymentRequirements: { ...catalogAccept(), resource: REQUEST_URL },
      },
    ]);
    expect(order).toEqual(['discovery', 'verify', 'settle']);
  });

  it('keeps verify and settle separate and preserves their fetch order', async () => {
    const settlement = { success: true, transaction: '0xsplit' };
    const { fetchImpl, order } = createFetchMock({ settlement });
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode({ payer: '0xbuyer' }) },
    });

    const verified = await gate.verify(request);

    expect(verified).not.toBeInstanceOf(Response);
    expect(order).toEqual(['discovery', 'verify']);

    const settled = await (verified as VerifiedPayment).settle();

    expect(settled).not.toBeInstanceOf(Response);
    expect(
      edgeBase64Decode((settled as PaymentResponse).paymentResponseHeader),
    ).toEqual(settlement);
    expect(order).toEqual(['discovery', 'verify', 'settle']);
  });

  it('returns no settlement capability when split verification fails', async () => {
    const { fetchImpl, order } = createFetchMock({
      verification: { isValid: false, invalidReason: 'expired' },
    });
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode({ payer: '0xbuyer' }) },
    });

    const verified = await gate.verify(request);
    const body = await read402(verified);

    expect(body.error).toBe('expired');
    expect(verified).not.toHaveProperty('settle');
    expect(order).toEqual(['discovery', 'verify']);
  });

  it('settles on the established wire when facilitator omits its reservation token', async () => {
    const { fetchImpl, facilitatorBodies, order } = createFetchMock({
      verification: { isValid: true },
    });
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode({ payer: '0xbuyer' }) },
    });

    const verified = await gate.verify(request);
    expect(verified).not.toBeInstanceOf(Response);

    const settled = await (verified as VerifiedPayment).settle();

    expect(settled).not.toBeInstanceOf(Response);
    expect(facilitatorBodies[1]).not.toHaveProperty('reservationToken');
    expect(order).toEqual(['discovery', 'verify', 'settle']);
  });

  it('forwards an optional token without changing the established verify body', async () => {
    const { fetchImpl, facilitatorBodies } = createFetchMock({
      verification: {
        isValid: true,
        reservationToken: 'x402r1_resource_payment_bound',
      },
    });
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
      maxUpstreamSeconds: 240,
      settlementGraceSeconds: 45,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode({ payer: '0xbuyer' }) },
    });

    const verified = (await gate.verify(request)) as VerifiedPayment;
    await verified.settle();

    expect(facilitatorBodies).toEqual([
      {
        x402Version: 1,
        paymentPayload: { payer: '0xbuyer' },
        paymentRequirements: { ...catalogAccept(), resource: REQUEST_URL },
      },
      {
        x402Version: 1,
        paymentPayload: { payer: '0xbuyer' },
        paymentRequirements: { ...catalogAccept(), resource: REQUEST_URL },
        reservationToken: 'x402r1_resource_payment_bound',
      },
    ]);
  });

  it.each([
    [{ maxUpstreamSeconds: -1 }, 'maxUpstreamSeconds'],
    [{ maxUpstreamSeconds: 1.5 }, 'maxUpstreamSeconds'],
    [{ settlementGraceSeconds: 0 }, 'settlementGraceSeconds'],
    [
      {
        maxUpstreamSeconds: Number.MAX_SAFE_INTEGER,
        settlementGraceSeconds: 1,
      },
      'reservation validity window',
    ],
  ])('rejects an invalid reservation window %#', async (options, expected) => {
    const sdk = await loadSdk();

    expect(() =>
      sdk.createJpycGate({
        resourceUrl: RESOURCE,
        ...options,
      }),
    ).toThrow(expected);
  });

  it('claims one authorization before facilitator verify across parallel resources', async () => {
    const { fetchImpl, order } = createFetchMock();
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    await gate.handle(new Request(`${RESOURCE}?warm=catalog`));
    const header = edgeBase64Encode(paymentPayload());

    const results = await Promise.all([
      gate.verify(
        new Request(`${RESOURCE}?report=first`, {
          headers: { 'X-PAYMENT': header },
        }),
      ),
      gate.verify(
        new Request(`${RESOURCE}?report=second`, {
          headers: { 'X-PAYMENT': header },
        }),
      ),
    ]);
    const verified = results.find(
      (result): result is VerifiedPayment => !(result instanceof Response),
    );
    const rejected = results.find(
      (result): result is Response => result instanceof Response,
    );

    expect(verified).toBeDefined();
    expect(rejected).toBeDefined();
    expect((await read402(rejected!)).error).toBe('authorization_reserved');
    expect(order).toEqual(['discovery', 'verify']);

    await verified!.settle();
    const replay = await gate.verify(
      new Request(`${RESOURCE}?report=replay`, {
        headers: { 'X-PAYMENT': header },
      }),
    );

    expect((await read402(replay)).error).toBe('authorization_reserved');
    expect(order).toEqual(['discovery', 'verify', 'settle']);
  });

  it('releases a tentative local claim after facilitator rejection', async () => {
    const verification = {
      isValid: false,
      invalidReason: 'temporary_rejection',
    };
    const { fetchImpl, order } = createFetchMock({ verification });
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode(paymentPayload('2')) },
    });

    expect((await read402(await gate.verify(request))).error).toBe(
      'temporary_rejection',
    );
    verification.isValid = true;
    const retried = await gate.verify(request);

    expect(retried).not.toBeInstanceOf(Response);
    expect(order).toEqual(['discovery', 'verify', 'verify']);
  });

  it('rejects an authorization that cannot cover upstream plus settlement time', async () => {
    const { fetchImpl, order } = createFetchMock();
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
      now: () => 1_700_000_000_500,
    });
    const request = new Request(REQUEST_URL, {
      headers: {
        'X-PAYMENT': edgeBase64Encode(
          paymentPayload('3', '1700000090'),
        ),
      },
    });

    const body = await read402(await gate.verify(request));

    expect(body.error).toBe('insufficient_validity_window');
    expect(order).toEqual(['discovery']);
  });

  it('returns a Response when split settlement fails', async () => {
    const { fetchImpl, order } = createFetchMock({
      settlement: { success: false, errorReason: 'facilitator_rejected' },
    });
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode({ payer: '0xbuyer' }) },
    });

    const verified = (await gate.verify(request)) as VerifiedPayment;
    const body = await read402(await verified.settle());

    expect(body.error).toBe('facilitator_rejected');
    expect(order).toEqual(['discovery', 'verify', 'settle']);
  });

  it('throws while the exact resource is absent from the catalog', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        items: [{ resource: `${RESOURCE}/other`, accepts: [catalogAccept()] }],
      }),
    );
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
    });

    await expect(gate.handle(new Request(REQUEST_URL))).rejects.toThrow(
      `resource not found in OpenPay catalog: ${RESOURCE}`,
    );
  });

  it('caches catalog accepts until the five-minute boundary', async () => {
    let currentTime = 10_000;
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [{ resource: RESOURCE, accepts: [catalogAccept()] }] }),
    );
    const sdk = await loadSdk();
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl,
      now: () => currentTime,
    });

    await gate.handle(new Request(REQUEST_URL));
    currentTime += 5 * 60_000 - 1;
    await gate.handle(new Request(`${RESOURCE}?cache=before`));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    currentTime += 1;
    await gate.handle(new Request(`${RESOURCE}?cache=boundary`));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // 決済偽装 (Akamai 2026-07 の実証攻撃) への否定系を明示的に固定する:
  // ゲートは「paid」等の文字列やモデル出力ではなく facilitator の verify/settle 応答
  // でのみ解錠する。リプレイ (使用済み authorization) は verify/settle 層で拒否される。
  it('refuses a replayed authorization at verify and never calls settle', async () => {
    const sdk = await loadSdk();
    const { fetchImpl, order } = createFetchMock({
      verification: { isValid: false, invalidReason: 'authorization_already_used' },
    });
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode({ payer: '0xbuyer' }) },
    });

    const body = await read402(await gate.handle(request));

    expect(body.error).toBe('authorization_already_used');
    expect(order).toEqual(['discovery', 'verify']);
  });

  it('returns no content when settle reports the authorization was already settled', async () => {
    const sdk = await loadSdk();
    const { fetchImpl, order } = createFetchMock({
      settlement: { success: false, errorReason: 'authorization_already_used' },
    });
    const gate = sdk.createJpycGate({
      resourceUrl: RESOURCE,
      openpayOrigin: OPENPAY_ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const request = new Request(REQUEST_URL, {
      headers: { 'X-PAYMENT': edgeBase64Encode({ payer: '0xbuyer' }) },
    });

    const body = await read402(await gate.handle(request));

    expect(body.error).toBe('authorization_already_used');
    expect(order).toEqual(['discovery', 'verify', 'settle']);
  });
});
