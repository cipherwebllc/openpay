import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAddress, verifyTypedData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

type Client = {
  pay: (
    url: string,
    options: { maxTotalJpyc: string },
  ) => Promise<Record<string, unknown>>;
  quote: (url: string) => Promise<Record<string, unknown>>;
  session: { spentAtomic: bigint; spentJpyc: string };
};

type SdkModule = {
  buildTypedDataFromPaymentRequirements: (
    accept: Record<string, unknown>,
    authorization: Record<string, unknown>,
  ) => { typedData: Parameters<typeof verifyTypedData>[0] };
  createOpenPayClient: (options?: Record<string, unknown>) => Client;
  createCatalogCache: () => { listings: Map<string, unknown> | null; cachedAt: number };
  resolveCatalogListings: (options: Record<string, unknown>) => Promise<Map<string, unknown> | null>;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const JPYC = 10n ** 18n;
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const THIRD_PARTY_RESOURCE = 'https://catalog.example/api/data';
const CATALOG_URL = 'https://catalog.test/api/discovery';
const PRIVATE_KEY = `0x${'1'.repeat(64)}` as Hex;
const RECEIPT_PRIVATE_KEY = `0x${'2'.repeat(64)}` as Hex;
const RECEIPT_TX = `0x${'a'.repeat(64)}` as Hex;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const ATTACKER = getAddress('0x9999999999999999999999999999999999999999');
const account = privateKeyToAccount(PRIVATE_KEY);
const receiptAccount = privateKeyToAccount(RECEIPT_PRIVATE_KEY);
const RECEIPT_TYPES = {
  Receipt: [
    { name: 'txHash', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'payTo', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'fee', type: 'uint256' },
    { name: 'asset', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

function accept(
  resource = RESOURCE,
  overrides: {
    forwarder?: string;
    asset?: string;
    merchant?: string;
    merchantValue?: bigint;
    feeReceiver?: string;
    feeValue?: bigint;
  } = {},
) {
  const merchantValue = overrides.merchantValue ?? 5n * JPYC;
  const feeValue = overrides.feeValue ?? 2n * JPYC;
  const forwarder = overrides.forwarder ?? FORWARDER;
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (merchantValue + feeValue).toString(),
    resource,
    description: 'demo',
    mimeType: 'application/json',
    payTo: forwarder,
    maxTimeoutSeconds: 600,
    asset: overrides.asset ?? TOKEN,
    extra: {
      name: 'JPY Coin',
      version: '1',
      decimals: 18,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder,
        merchant: overrides.merchant ?? MERCHANT,
        merchantValue: merchantValue.toString(),
        feeReceiver: overrides.feeReceiver ?? FEE_RECEIVER,
        feeValue: feeValue.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function requestHeaders(init?: RequestInit) {
  return new Headers(init?.headers);
}

async function quoteCatalogVariant(
  requestUrl: string,
  {
    listedResource = THIRD_PARTY_RESOURCE,
    listedAccept = accept(listedResource),
    liveAccept = accept(requestUrl),
  }: {
    listedResource?: string;
    listedAccept?: ReturnType<typeof accept>;
    liveAccept?: ReturnType<typeof accept>;
  } = {},
) {
  const sdk = await loadSdk();
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === CATALOG_URL) {
      return jsonResponse(
        { items: [{ resource: listedResource, accepts: [listedAccept] }] },
        200,
      );
    }
    return jsonResponse({ accepts: [liveAccept] }, 402);
  });
  const client = sdk.createOpenPayClient({
    discoveryUrl: CATALOG_URL,
    fetchImpl,
  });
  return client.quote(requestUrl);
}

describe('openpay-x402-sdk executor', () => {
  it('runs challenge → guard → verifiable signature → unlock → record', async () => {
    const sdk = await loadSdk();
    let verified = false;
    let receipt: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input) ===
          'https://open-pay.jp/api/facilitator/supported'
        ) {
          return jsonResponse(
            { receiptSigner: receiptAccount.address },
            200,
          );
        }
        const payment = requestHeaders(init).get('X-PAYMENT');
        if (!payment) return jsonResponse({ accepts: [accept()] }, 402);

        const payload = JSON.parse(Buffer.from(payment, 'base64').toString('utf8')) as {
          payload: { signature: Hex; authorization: Record<string, unknown> };
        };
        const { typedData } = sdk.buildTypedDataFromPaymentRequirements(
          accept(),
          payload.payload.authorization,
        );
        verified = await verifyTypedData({
          ...typedData,
          address: account.address,
          signature: payload.payload.signature,
        });
        const nonce = typedData.message.nonce as Hex;
        const receiptMessage = {
          txHash: RECEIPT_TX,
          payer: account.address,
          payTo: MERCHANT,
          amount: 5n * JPYC,
          fee: 2n * JPYC,
          asset: TOKEN,
          chainId: 80002n,
          timestamp: 1_000_000_001n,
          nonce,
        };
        const signedReceipt = {
          txHash: RECEIPT_TX,
          payer: account.address,
          payTo: MERCHANT,
          amount: (5n * JPYC).toString(),
          fee: (2n * JPYC).toString(),
          asset: TOKEN,
          chainId: 80002,
          timestamp: 1_000_000_001,
          nonce,
          signature: await receiptAccount.signTypedData({
            domain: {
              name: 'OpenPay x402 Facilitator',
              version: '1',
            },
            types: RECEIPT_TYPES,
            primaryType: 'Receipt',
            message: receiptMessage,
          }),
        };
        receipt = {
          success: true,
          transaction: RECEIPT_TX,
          network: 'eip155:80002',
          payer: account.address,
          receipt: signedReceipt,
        };
        return jsonResponse(
          { unlocked: true },
          200,
          {
            'x-payment-response': Buffer.from(JSON.stringify(receipt)).toString(
              'base64',
            ),
          },
        );
      },
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
      nowSec: () => 1_000_000_000,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(verified).toBe(true);
    expect(result).toEqual({
      status: 200,
      body: { unlocked: true },
      receipt,
      settlement: 'verified',
    });
    expect(client.session).toEqual({
      spentAtomic: 7n * JPYC,
      spentJpyc: '7',
    });
  });

  it('does not send a payment fetch when a guard rejects the challenge', async () => {
    let paidFetches = 0;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (requestHeaders(init).has('X-PAYMENT')) paidFetches += 1;
        return jsonResponse({ accepts: [accept()] }, 402);
      },
    );
    const sdk = await loadSdk();
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '6' });

    expect(result.reasons).toContain('total_exceeds_max_total');
    expect(paidFetches).toBe(0);
  });

  it('does not sign or expose X-PAYMENT for an unreviewed forwarder destination', async () => {
    const sdk = await loadSdk();
    let paidFetches = 0;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (requestHeaders(init).has('X-PAYMENT')) paidFetches += 1;
        return jsonResponse(
          { accepts: [accept(RESOURCE, { forwarder: ATTACKER })] },
          402,
        );
      },
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result.reasons).toContain('invalid_openpay_forwarder');
    expect(paidFetches).toBe(0);
  });

  it('serializes concurrent payments and rejects the second at the session cap', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        requestHeaders(init).has('X-PAYMENT')
          ? jsonResponse({ unlocked: true }, 200)
          : jsonResponse({ accepts: [accept()] }, 402),
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxSessionJpyc: '10',
      catalogTrust: false,
      fetchImpl,
    });

    const results = await Promise.all([
      client.pay(RESOURCE, { maxTotalJpyc: '7' }),
      client.pay(RESOURCE, { maxTotalJpyc: '7' }),
    ]);

    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(
      results.find((result) => Array.isArray(result.reasons))?.reasons,
    ).toContain('session_limit_exceeded');
    expect(client.session.spentJpyc).toBe('7');
  });

  it('allows the next queued payment after an earlier signing failure', async () => {
    const sdk = await loadSdk();
    let signCalls = 0;
    const signer = {
      address: account.address,
      async signTypedData(typedData: Parameters<typeof account.signTypedData>[0]) {
        signCalls += 1;
        if (signCalls === 1) throw new Error('first signature failed');
        return account.signTypedData(typedData);
      },
    };
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        requestHeaders(init).has('X-PAYMENT')
          ? jsonResponse({ unlocked: true }, 200)
          : jsonResponse({ accepts: [accept()] }, 402),
    );
    const client = sdk.createOpenPayClient({
      signer,
      catalogTrust: false,
      fetchImpl,
    });

    const first = client.pay(RESOURCE, { maxTotalJpyc: '7' });
    const second = client.pay(RESOURCE, { maxTotalJpyc: '7' });

    await expect(first).rejects.toThrow('first signature failed');
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(client.session.spentJpyc).toBe('7');
  });

  it('does not record a non-2xx unlock but keeps its authorization reserved', async () => {
    const sdk = await loadSdk();
    let unlocks = 0;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!requestHeaders(init).has('X-PAYMENT')) {
          return jsonResponse({ accepts: [accept()] }, 402);
        }
        unlocks += 1;
        return unlocks === 1
          ? jsonResponse({ error: 'temporary' }, 503)
          : jsonResponse({ unlocked: true }, 200);
      },
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxSessionJpyc: '10',
      catalogTrust: false,
      fetchImpl,
    });

    const first = await client.pay(RESOURCE, { maxTotalJpyc: '7' });
    const second = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(first.status).toBe(503);
    // A hostile seller can settle before returning 503. Treating that signature as
    // free would let retries mint fresh nonces beyond the cumulative buyer cap.
    expect(second.reasons).toContain('session_limit_exceeded');
    expect(unlocks).toBe(1);
    expect(client.session.spentJpyc).toBe('0');
  });

  it('keeps a timed-out paid request reserved and refuses a fresh nonce', async () => {
    const sdk = await loadSdk();
    let paidFetches = 0;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!requestHeaders(init).has('X-PAYMENT')) {
          return jsonResponse({ accepts: [accept()] }, 402);
        }
        paidFetches += 1;
        throw new DOMException('timed out', 'TimeoutError');
      },
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxSessionJpyc: '10',
      catalogTrust: false,
      fetchImpl,
    });

    await expect(
      client.pay(RESOURCE, { maxTotalJpyc: '7' }),
    ).rejects.toThrow('timed out');
    const retry = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(retry.reasons).toContain('session_limit_exceeded');
    expect(paidFetches).toBe(1);
  });

  it('does not let a malformed seller receipt erase a successful body', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        requestHeaders(init).has('X-PAYMENT')
          ? jsonResponse(
              { unlocked: true },
              200,
              { 'x-payment-response': 'not-json-base64' },
            )
          : jsonResponse({ accepts: [accept()] }, 402),
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result).toEqual({
      status: 200,
      body: { unlocked: true },
      receipt: null,
      // 売り手が受領証ヘッダを名乗ったが検証できなかった = 「受領証なし」ではない。
      settlement: 'unverified',
    });
    expect(client.session.spentJpyc).toBe('7');
  });

  it('records a bodyless 204 unlock without constructing an invalid response body', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        requestHeaders(init).has('X-PAYMENT')
          ? new Response(null, { status: 204 })
          : jsonResponse({ accepts: [accept()] }, 402),
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result).toEqual({
      status: 204,
      body: null,
      receipt: null,
      settlement: 'receipt_unavailable',
    });
    expect(client.session.spentJpyc).toBe('7');
  });

  // B9: `status: 200` は「売り手が本文を返した」以上を意味しない。LLM がそれを「支払い済み」と
  // 読むのを塞ぐため、settlement を決済結果の明示フィールドとして返す。
  describe('settlement truth', () => {
    it('reports receipt_unavailable when the facilitator signer cannot be resolved', async () => {
      const sdk = await loadSdk();
      const fetchImpl = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (
            String(input) === 'https://open-pay.jp/api/facilitator/supported'
          ) {
            return jsonResponse({ error: 'unavailable' }, 503);
          }
          if (!requestHeaders(init).has('X-PAYMENT')) {
            return jsonResponse({ accepts: [accept()] }, 402);
          }
          return jsonResponse({ unlocked: true }, 200, {
            'x-payment-response': Buffer.from(
              JSON.stringify({ success: true }),
            ).toString('base64'),
          });
        },
      );
      const client = sdk.createOpenPayClient({
        privateKey: PRIVATE_KEY,
        catalogTrust: false,
        fetchImpl,
      });

      const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

      expect(result).toMatchObject({
        status: 200,
        receipt: null,
        settlement: 'receipt_unavailable',
      });
    });

    it('reports unverified for a receipt signed by the wrong signer', async () => {
      const sdk = await loadSdk();
      const impostor = privateKeyToAccount(`0x${'3'.repeat(64)}` as Hex);
      const fetchImpl = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (
            String(input) === 'https://open-pay.jp/api/facilitator/supported'
          ) {
            return jsonResponse({ receiptSigner: receiptAccount.address }, 200);
          }
          const payment = requestHeaders(init).get('X-PAYMENT');
          if (!payment) return jsonResponse({ accepts: [accept()] }, 402);
          const payload = JSON.parse(
            Buffer.from(payment, 'base64').toString('utf8'),
          ) as { payload: { authorization: Record<string, unknown> } };
          const { typedData } = sdk.buildTypedDataFromPaymentRequirements(
            accept(),
            payload.payload.authorization,
          );
          const nonce = typedData.message.nonce as Hex;
          const message = {
            txHash: RECEIPT_TX,
            payer: account.address,
            payTo: MERCHANT,
            amount: 5n * JPYC,
            fee: 2n * JPYC,
            asset: TOKEN,
            chainId: 80002n,
            timestamp: 1_000_000_001n,
            nonce,
          };
          const forged = {
            success: true,
            transaction: RECEIPT_TX,
            network: 'eip155:80002',
            payer: account.address,
            receipt: {
              ...message,
              amount: (5n * JPYC).toString(),
              fee: (2n * JPYC).toString(),
              chainId: 80002,
              timestamp: 1_000_000_001,
              // 施設者ではない鍵の署名 = 受領証を名乗るが証明になっていない。
              signature: await impostor.signTypedData({
                domain: { name: 'OpenPay x402 Facilitator', version: '1' },
                types: RECEIPT_TYPES,
                primaryType: 'Receipt',
                message,
              }),
            },
          };
          return jsonResponse({ unlocked: true }, 200, {
            'x-payment-response': Buffer.from(JSON.stringify(forged)).toString(
              'base64',
            ),
          });
        },
      );
      const client = sdk.createOpenPayClient({
        privateKey: PRIVATE_KEY,
        catalogTrust: false,
        fetchImpl,
        nowSec: () => 1_000_000_000,
      });

      const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

      expect(result).toMatchObject({
        status: 200,
        receipt: null,
        settlement: 'unverified',
      });
    });
  });
});

describe('openpay-x402-sdk catalog trust', () => {
  it('rejects a query variant of a query-free listing before target I/O', async () => {
    const sdk = await loadSdk();
    const requestUrl = `${THIRD_PARTY_RESOURCE}?q=hello`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === CATALOG_URL) {
        return jsonResponse(
          {
            items: [
              {
                resource: THIRD_PARTY_RESOURCE,
                accepts: [accept(THIRD_PARTY_RESOURCE)],
              },
            ],
          },
          200,
        );
      }
      throw new Error('unlisted target must not be fetched');
    });
    const client = sdk.createOpenPayClient({
      discoveryUrl: CATALOG_URL,
      fetchImpl,
    });

    const result = await client.quote(requestUrl);

    // 0.2.x allowed query variants, but exact pre-I/O admission is required to
    // keep an unreviewed GET action outside the catalog trust boundary.
    expect(result.reasons).toContain('host_not_allowed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      CATALOG_URL,
      expect.any(Object),
    );
  });

  it.each([
    ['feeValue', { feeValue: 3n * JPYC }],
    ['merchant', { merchant: ATTACKER }],
    ['forwarder', { forwarder: ATTACKER }],
  ] as const)(
    'rejects exact-listing %s tampering as catalog_accept_mismatch',
    async (_field, overrides) => {
      const requestUrl = `${THIRD_PARTY_RESOURCE}?q=hello`;

      const result = await quoteCatalogVariant(requestUrl, {
        listedResource: requestUrl,
        listedAccept: accept(requestUrl),
        liveAccept: accept(requestUrl, overrides),
      });

      expect(result.reasons).toContain('catalog_accept_mismatch');
      expect(result.reasons).not.toContain('host_not_allowed');
    },
  );

  it.each([
    `${THIRD_PARTY_RESOURCE}2?q=hello`,
    `${THIRD_PARTY_RESOURCE}/x?q=hello`,
  ])('does not extend catalog trust to path prefix %s', async (requestUrl) => {
    const result = await quoteCatalogVariant(requestUrl);

    expect(result.reasons).toContain('host_not_allowed');
  });

  it('keeps query-bearing catalog entries exact-only', async () => {
    const listedResource = `${THIRD_PARTY_RESOURCE}?plan=basic`;
    const requestUrl = `${THIRD_PARTY_RESOURCE}?plan=premium`;

    const result = await quoteCatalogVariant(requestUrl, { listedResource });

    expect(result.reasons).toContain('host_not_allowed');
  });

  it('does not extend a catalog URL to a trailing empty query', async () => {
    const requestUrl = `${THIRD_PARTY_RESOURCE}?`;
    const result = await quoteCatalogVariant(requestUrl);

    expect(result.reasons).toContain('host_not_allowed');
  });

  it('does not extend a catalog URL to a fragment variant', async () => {
    const result = await quoteCatalogVariant(
      `${THIRD_PARTY_RESOURCE}#details`,
    );

    expect(result.reasons).toContain('host_not_allowed');
  });

  it('still requires live accept.resource to equal the complete requested URL', async () => {
    const requestUrl = `${THIRD_PARTY_RESOURCE}?q=hello`;

    const result = await quoteCatalogVariant(requestUrl, {
      listedResource: requestUrl,
      listedAccept: accept(requestUrl),
      liveAccept: accept(THIRD_PARTY_RESOURCE),
    });

    expect(result.reasons).toContain('resource_mismatch');
    expect(result.reasons).not.toContain('host_not_allowed');
    expect(result.reasons).not.toContain('catalog_accept_mismatch');
  });

  // Vercel/Next 系は request.url の時点で %20 を + に正規化する (原文復元不可) ため、
  // resource 照合は「デコード後の (key,value) 列一致」で同義エンコーディングを同一視する。
  it.each([
    [
      'live resource uses + for the buyer %20',
      `${THIRD_PARTY_RESOURCE}?q=What%20is%20it%3F`,
      `${THIRD_PARTY_RESOURCE}?q=What+is+it%3F`,
    ],
    [
      'live resource uses %20 for the buyer +',
      `${THIRD_PARTY_RESOURCE}?q=a+b`,
      `${THIRD_PARTY_RESOURCE}?q=a%20b`,
    ],
  ])('accepts equivalent query encodings (%s)', async (_label, requestUrl, liveResource) => {
    const result = await quoteCatalogVariant(requestUrl, {
      listedResource: requestUrl,
      listedAccept: accept(liveResource),
      liveAccept: accept(liveResource),
    });

    expect(result).toMatchObject({ ok: true, reasons: [] });
  });

  it.each([
    ['literal plus is not a space', `${THIRD_PARTY_RESOURCE}?q=a%2Bb`, `${THIRD_PARTY_RESOURCE}?q=a+b`],
    ['double encoding differs', `${THIRD_PARTY_RESOURCE}?q=a%2520b`, `${THIRD_PARTY_RESOURCE}?q=a%20b`],
    ['different value', `${THIRD_PARTY_RESOURCE}?q=hello`, `${THIRD_PARTY_RESOURCE}?q=world`],
    ['extra param', `${THIRD_PARTY_RESOURCE}?q=hello`, `${THIRD_PARTY_RESOURCE}?q=hello&x=1`],
    ['reordered params', `${THIRD_PARTY_RESOURCE}?a=1&b=2`, `${THIRD_PARTY_RESOURCE}?b=2&a=1`],
  ])('rejects non-equivalent queries (%s)', async (_label, requestUrl, liveResource) => {
    const result = await quoteCatalogVariant(requestUrl, {
      listedResource: requestUrl,
      listedAccept: accept(requestUrl),
      liveAccept: accept(liveResource),
    });

    expect(result.reasons).toContain('resource_mismatch');
  });

  it.each([
    ['uppercase host and default port', 'https://CATALOG.EXAMPLE:443/api/data?q=hello'],
    ['dot segment', 'https://catalog.example/api/x/../data?q=hello'],
    ['backslash path separator', 'https://catalog.example\\api\\data?q=hello'],
  ])('uses WHATWG normalization for %s', async (_label, requestUrl) => {
    const listedResource = `${THIRD_PARTY_RESOURCE}?q=hello`;
    const result = await quoteCatalogVariant(requestUrl, {
      listedResource,
      listedAccept: accept(listedResource),
    });

    expect(result).toMatchObject({ ok: true, reasons: [] });
  });

  it('normalizes an IDN host to the same punycode catalog origin', async () => {
    const listedResource = 'https://xn--bcher-kva.example/api/data?q=hello';
    const requestUrl = 'https://bücher.example/api/data?q=hello';

    const result = await quoteCatalogVariant(requestUrl, { listedResource });

    expect(result).toMatchObject({ ok: true, reasons: [] });
  });

  it.each([
    ['trailing slash', `${THIRD_PARTY_RESOURCE}/?q=hello`],
    ['non-default port', 'https://catalog.example:444/api/data?q=hello'],
    ['percent-encoded slash', 'https://catalog.example/api%2Fdata?q=hello'],
    ['percent-encoded unreserved path byte', 'https://catalog.example/api/%64ata?q=hello'],
    ['percent-encoded dot traversal', 'https://catalog.example/api/%2e%2e/data?q=hello'],
  ])('does not broaden trust across %s', async (_label, requestUrl) => {
    const result = await quoteCatalogVariant(requestUrl);

    expect(result.reasons).toContain('host_not_allowed');
  });

  it('rejects userinfo before either catalog or target network I/O', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn();
    const client = sdk.createOpenPayClient({ fetchImpl });

    const result = await client.quote(
      'https://user:pass@catalog.example/api/data',
    );

    expect(result.reasons).toContain('invalid_url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.1:3900/agents',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/internal',
  ])('blocks private target %s before fetch even when its host is allowed', async (url) => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn();
    const client = sdk.createOpenPayClient({
      allowedHosts: new URL(url).hostname,
      catalogTrust: false,
      fetchImpl,
    });

    const quote = await client.quote(url);
    const payment = await client.pay(url, { maxTotalJpyc: '1' });

    expect(quote.reasons).toContain('invalid_url');
    expect(payment.reasons).toContain('invalid_url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'javascript:https://catalog.example/api/data?q=hello',
    'ftp://catalog.example/api/data?q=hello',
  ])('rejects unsupported request scheme %s', async (requestUrl) => {
    const result = await quoteCatalogVariant(requestUrl);

    expect(result.reasons).toContain('invalid_url');
  });

  it('requires HTTPS even for the default allowlisted host', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn();
    const client = sdk.createOpenPayClient({
      catalogTrust: false,
      fetchImpl,
    });

    const result = await client.pay(
      'http://open-pay.jp/api/paid/demo',
      { maxTotalJpyc: '7' },
    );

    expect(result.reasons).toContain('unsupported_scheme');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves exact catalog and explicit open-pay.jp host behavior', async () => {
    const exact = await quoteCatalogVariant(THIRD_PARTY_RESOURCE);
    const allowed = await quoteCatalogVariant(RESOURCE);

    expect(exact).toMatchObject({ ok: true, reasons: [] });
    expect(allowed).toMatchObject({ ok: true, reasons: [] });
  });

  it('uses exact URL listings and rejects a mismatched live accept', async () => {
    const sdk = await loadSdk();
    const listed = accept(THIRD_PARTY_RESOURCE);
    const live = accept(THIRD_PARTY_RESOURCE, { forwarder: ATTACKER });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CATALOG_URL) {
        return jsonResponse(
          { items: [{ resource: THIRD_PARTY_RESOURCE, accepts: [listed] }] },
          200,
        );
      }
      if (url === THIRD_PARTY_RESOURCE) {
        return jsonResponse({ accepts: [live] }, 402);
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = sdk.createOpenPayClient({
      discoveryUrl: CATALOG_URL,
      fetchImpl,
    });

    const result = await client.quote(THIRD_PARTY_RESOURCE);

    expect(result.reasons).toContain('catalog_accept_mismatch');
    expect(result.reasons).not.toContain('host_not_allowed');
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      CATALOG_URL,
      THIRD_PARTY_RESOURCE,
    ]);
  });

  it('fails closed to the explicit host allowlist when discovery fails', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === THIRD_PARTY_RESOURCE) {
        return jsonResponse({ accepts: [accept(THIRD_PARTY_RESOURCE)] }, 402);
      }
      throw new Error('catalog unavailable');
    });
    const client = sdk.createOpenPayClient({
      discoveryUrl: CATALOG_URL,
      fetchImpl,
    });

    const result = await client.quote(THIRD_PARTY_RESOURCE);

    expect(result.reasons).toContain('host_not_allowed');
  });

  it('caches a catalog for five minutes and refreshes at the boundary', async () => {
    const sdk = await loadSdk();
    let now = 1_000;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          items: [
            {
              resource: THIRD_PARTY_RESOURCE,
              accepts: [accept(THIRD_PARTY_RESOURCE)],
            },
          ],
        },
        200,
      ),
    );
    const cache = sdk.createCatalogCache();
    const options = {
      config: {
        catalogTrust: true,
        discoveryUrl: CATALOG_URL,
      },
      fetchImpl,
      now: () => now,
      cache,
    };

    const first = await sdk.resolveCatalogListings(options);
    now += 5 * 60_000 - 1;
    const cached = await sdk.resolveCatalogListings(options);
    now += 1;
    await sdk.resolveCatalogListings(options);

    expect(first?.get(THIRD_PARTY_RESOURCE)).toEqual(
      accept(THIRD_PARTY_RESOURCE),
    );
    expect(cached).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not fetch or trust the catalog when catalogTrust is false', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === THIRD_PARTY_RESOURCE) {
        return jsonResponse({ accepts: [accept(THIRD_PARTY_RESOURCE)] }, 402);
      }
      throw new Error('catalog must not be fetched');
    });
    const client = sdk.createOpenPayClient({
      catalogTrust: false,
      fetchImpl,
    });

    const result = await client.quote(THIRD_PARTY_RESOURCE);

    expect(result.reasons).toContain('host_not_allowed');
    // Host/catalog admission is a network boundary, not merely a post-fetch payment guard.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
