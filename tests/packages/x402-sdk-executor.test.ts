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
const PRIVATE_KEY = `0x${'1'.repeat(64)}` as Hex;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x4444444444444444444444444444444444444444');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const ATTACKER = getAddress('0x9999999999999999999999999999999999999999');
const account = privateKeyToAccount(PRIVATE_KEY);

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

function accept(
  resource = RESOURCE,
  overrides: { forwarder?: string; asset?: string } = {},
) {
  const merchantValue = 5n * JPYC;
  const feeValue = 2n * JPYC;
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
        merchant: MERCHANT,
        merchantValue: merchantValue.toString(),
        feeReceiver: FEE_RECEIVER,
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

describe('openpay-x402-sdk executor', () => {
  it('runs challenge → guard → verifiable signature → unlock → record', async () => {
    const sdk = await loadSdk();
    let verified = false;
    const receipt = { success: true, transaction: '0xabc' };
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
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

  it('does not record a non-2xx unlock and still runs the next queued payment', async () => {
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
      catalogTrust: false,
      fetchImpl,
    });

    const first = await client.pay(RESOURCE, { maxTotalJpyc: '7' });
    const second = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(client.session.spentJpyc).toBe('7');
  });
});

describe('openpay-x402-sdk catalog trust', () => {
  it('uses exact URL listings and rejects a mismatched live accept', async () => {
    const sdk = await loadSdk();
    const listed = accept(THIRD_PARTY_RESOURCE);
    const live = accept(THIRD_PARTY_RESOURCE, { forwarder: ATTACKER });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://catalog.test/api/discovery') {
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
      discoveryUrl: 'https://catalog.test/api/discovery',
      fetchImpl,
    });

    const result = await client.quote(THIRD_PARTY_RESOURCE);

    expect(result.reasons).toContain('catalog_accept_mismatch');
    expect(result.reasons).not.toContain('host_not_allowed');
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
      discoveryUrl: 'https://catalog.test/api/discovery',
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
        discoveryUrl: 'https://catalog.test/api/discovery',
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
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
