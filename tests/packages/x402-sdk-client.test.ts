import { inspect } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

type Client = {
  discover: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  findShops: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  quote: (url: string) => Promise<Record<string, unknown>>;
  pay: (
    url: string,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  session: { spentAtomic: bigint; spentJpyc: string };
};

type SdkModule = {
  createOpenPayClient: (options?: Record<string, unknown>) => Client;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const PRIVATE_KEY = `0x${'1'.repeat(64)}` as Hex;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const account = privateKeyToAccount(PRIVATE_KEY);

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function accept() {
  const price = 1n * 10n ** 18n;
  const fee = 1n * 10n ** 18n;
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (price + fee).toString(),
    resource: RESOURCE,
    description: 'demo',
    mimeType: 'application/json',
    payTo: FORWARDER,
    maxTimeoutSeconds: 600,
    asset: TOKEN,
    extra: {
      name: 'JPY Coin',
      version: '1',
      decimals: 18,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder: FORWARDER,
        merchant: MERCHANT,
        merchantValue: price.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: fee.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
}

describe('openpay-x402-sdk client', () => {
  it('findShops sends only q and limit and preserves the route envelope', async () => {
    const routeEnvelope = {
      schemaVersion: '1.0',
      query: { q: 'Blue Cafe', limit: 3 },
      items: [
        {
          handle: 'blue',
          name: 'Blue Cafe',
          mode: 'storefront',
          acceptingNow: null,
        },
      ],
      total: 1,
      generatedAt: '2026-07-14T00:00:00.000Z',
      dataFreshness: { oldestUpdatedAt: null, newestUpdatedAt: null },
      licenseNotice: 'fixture from the shops route contract',
      attribution: ['https://open-pay.jp/@blue'],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(routeEnvelope));
    const sdk = await loadSdk();
    const client = sdk.createOpenPayClient({ fetchImpl, catalogTrust: false });

    const result = await client.findShops({
      q: 'Blue Cafe',
      limit: 3,
      acceptingNow: true,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://open-pay.jp/api/shops/find?q=Blue+Cafe&limit=3',
      { headers: { accept: 'application/json' } },
    );
    expect(result).toEqual({ ok: true, status: 200, body: routeEnvelope });
  });

  it('discover preserves accepts:[] and the complete discovery route envelope', async () => {
    const routeEnvelope = {
      x402Version: 1,
      items: [
        {
          resource: 'https://catalog.example/unavailable',
          description: 'temporarily not payable',
          category: 'api',
          priceJpyc: '1',
          network: 'eip155:80002',
          accepts: [],
          verifiedAt: null,
        },
      ],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(routeEnvelope));
    const sdk = await loadSdk();
    const client = sdk.createOpenPayClient({ fetchImpl });

    const result = await client.discover({ query: 'data', category: 'api' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://open-pay.jp/api/discovery?query=data&category=api',
      { headers: { accept: 'application/json' } },
    );
    expect(result).toEqual({ ok: true, status: 200, body: routeEnvelope });
  });

  it('returns a discriminated failure without rewriting the server body', async () => {
    const body = { ok: false, error: 'invalid_query', detail: 'q' };
    const sdk = await loadSdk();
    const client = sdk.createOpenPayClient({
      fetchImpl: async () => jsonResponse(body, 400),
    });

    await expect(client.findShops()).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'invalid_query',
      body,
    });
  });

  it('returns a fresh frozen session snapshot that cannot mutate internal spend', async () => {
    const sdk = await loadSdk();
    const client = sdk.createOpenPayClient({ catalogTrust: false });
    const first = client.session;
    const second = client.session;

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      first.spentAtomic = 999n;
    }).toThrow(TypeError);
    expect(client.session).toEqual({ spentAtomic: 0n, spentJpyc: '0' });
  });

  it('keeps config and signer secrets out of enumerable and inspected state', async () => {
    const apiKey = 'sdk_steward_api_key_secret';
    const signerSecret = 'sdk_steward_signer_secret';
    const sdk = await loadSdk();
    const client = sdk.createOpenPayClient({
      steward: {
        url: 'https://steward.test',
        tenant: 'tenant-a',
        apiKey,
        agentId: 'agent-1',
        agentAddress: account.address,
        signerId: 'signer-1',
        signerSecret,
      },
      catalogTrust: false,
      fetchImpl: async () => jsonResponse({ ok: true }),
    });
    const serialized = JSON.stringify(client);
    const inspected = inspect(client);

    expect(client).not.toHaveProperty('config');
    expect(client).not.toHaveProperty('signer');
    for (const secret of [PRIVATE_KEY, apiKey, signerSecret]) {
      expect(serialized).not.toContain(secret);
      expect(inspected).not.toContain(secret);
    }
  });

  it('rejects multiple signer selections at startup without echoing secrets', async () => {
    const apiKey = 'sdk_steward_api_key_secret';
    const signerSecret = 'sdk_steward_signer_secret';
    const sdk = await loadSdk();
    let message = '';
    try {
      sdk.createOpenPayClient({
        privateKey: PRIVATE_KEY,
        steward: {
          url: 'https://steward.test',
          tenant: 'tenant-a',
          apiKey,
          agentId: 'agent-1',
          agentAddress: account.address,
          signerId: 'signer-1',
          signerSecret,
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('mutually exclusive');
    expect(message).not.toContain(PRIVATE_KEY);
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(signerSecret);
  });

  it('quotes without a signer but pay reports the missing signer guard', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn(async () => jsonResponse({ accepts: [accept()] }, 402));
    const client = sdk.createOpenPayClient({ catalogTrust: false, fetchImpl });

    await expect(client.quote(RESOURCE)).resolves.toMatchObject({ ok: true });
    await expect(
      client.pay(RESOURCE, { maxTotalJpyc: '2' }),
    ).resolves.toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['buyer_private_key_missing']),
    });
  });

  it('requires maxTotalJpyc through the guard before any paid retry', async () => {
    const sdk = await loadSdk();
    let paidFetches = 0;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).has('X-PAYMENT')) paidFetches += 1;
        return jsonResponse({ accepts: [accept()] }, 402);
      },
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
    });

    const result = await client.pay(RESOURCE, {});

    expect(result.reasons).toContain('max_total_required');
    expect(paidFetches).toBe(0);
  });

  it('redacts Steward credentials and private-key-looking values from error previews', async () => {
    const apiKey = 'sdk_steward_api_key_secret';
    const signerSecret = 'sdk_steward_signer_secret';
    const leakedKey = `0x${'9'.repeat(64)}`;
    const sdk = await loadSdk();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === RESOURCE) {
        return jsonResponse({ accepts: [accept()] }, 402);
      }
      return jsonResponse(
        { ok: false, error: `${apiKey}:${signerSecret}:${leakedKey}` },
        403,
      );
    });
    const client = sdk.createOpenPayClient({
      steward: {
        url: 'https://steward.test',
        tenant: 'tenant-a',
        apiKey,
        agentId: 'agent-1',
        agentAddress: account.address,
        signerId: 'signer-1',
        signerSecret,
      },
      catalogTrust: false,
      fetchImpl,
    });

    let message = '';
    try {
      await client.pay(RESOURCE, { maxTotalJpyc: '2' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('steward sign-typed-data failed (403)');
    expect(message).toContain('[redacted_secret]');
    expect(message).toContain('[redacted_private_key]');
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(signerSecret);
    expect(message).not.toContain(leakedKey);
  });
});
