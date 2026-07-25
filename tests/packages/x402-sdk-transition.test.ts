import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

type Runtime = {
  quote: (url: string) => Promise<Record<string, unknown>>;
  pay: (
    url: string,
    options: { maxTotalJpyc: string },
  ) => Promise<Record<string, unknown>>;
};

type McpModule = {
  createToolRuntime: (options: Record<string, unknown>) => {
    x402Quote: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    x402Pay: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

type SdkModule = {
  createOpenPayClient: (options: Record<string, unknown>) => Runtime;
};

const MCP_ENTRY = resolve(process.cwd(), 'packages/x402-mcp/src/tools.mjs');
const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const LISTED_RESOURCE = 'https://catalog.example/api/data';
const QUERY_RESOURCE = `${LISTED_RESOURCE}?q=hello`;
const DISCOVERY_URL = 'https://open-pay.jp/api/discovery';
const STEWARD_URL = 'https://steward.test';
const PRIVATE_KEY = `0x${'1'.repeat(64)}` as Hex;
const account = privateKeyToAccount(PRIVATE_KEY);
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const ATTACKER = getAddress('0x9999999999999999999999999999999999999999');

async function loadMcp(): Promise<McpModule> {
  return (await import(pathToFileURL(MCP_ENTRY).href)) as McpModule;
}

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

function paymentAccept(resource = RESOURCE, forwarder: Address = FORWARDER) {
  const price = 1n * 10n ** 18n;
  const fee = 1n * 10n ** 18n;
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (price + fee).toString(),
    resource,
    description: 'demo',
    mimeType: 'application/json',
    payTo: forwarder,
    maxTimeoutSeconds: 600,
    asset: TOKEN,
    extra: {
      name: 'JPY Coin',
      version: '1',
      decimals: 18,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder,
        merchant: MERCHANT,
        merchantValue: price.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: fee.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function runtimeFor(
  implementation: 'MCP' | 'SDK',
  fetchImpl: typeof fetch,
  signerMode: 'local' | 'steward' | 'none' = 'local',
): Promise<Runtime> {
  if (implementation === 'MCP') {
    const mcp = await loadMcp();
    const env = {
      ALLOWED_HOSTS: 'open-pay.jp',
      MAX_PER_CALL_JPYC: '10',
      MAX_SESSION_JPYC: '100',
      DISCOVERY_URL,
      ...(signerMode === 'local' ? { BUYER_PRIVATE_KEY: PRIVATE_KEY } : {}),
      ...(signerMode === 'steward'
        ? {
            SIGNER_MODE: 'steward',
            STEWARD_URL,
            STEWARD_TENANT: 'tenant-a',
            STEWARD_API_KEY: 'api-key',
            STEWARD_AGENT_ID: 'agent-1',
            STEWARD_AGENT_ADDRESS: account.address,
            STEWARD_SIGNER_ID: 'signer-1',
            STEWARD_SIGNER_SECRET: 'signer-secret',
          }
        : {}),
    };
    const runtime = mcp.createToolRuntime({ env, fetchImpl });
    return {
      quote: (url) => runtime.x402Quote({ url }),
      pay: (url, options) => runtime.x402Pay({ url, ...options }),
    };
  }

  const sdk = await loadSdk();
  return sdk.createOpenPayClient({
    allowedHosts: 'open-pay.jp',
    maxPerCallJpyc: '10',
    maxSessionJpyc: '100',
    discoveryUrl: DISCOVERY_URL,
    fetchImpl,
    ...(signerMode === 'local' ? { privateKey: PRIVATE_KEY } : {}),
    ...(signerMode === 'steward'
      ? {
          steward: {
            url: STEWARD_URL,
            tenant: 'tenant-a',
            apiKey: 'api-key',
            agentId: 'agent-1',
            agentAddress: account.address,
            signerId: 'signer-1',
            signerSecret: 'signer-secret',
          },
        }
      : {}),
  });
}

function stewardTypedData(body: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  value: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}) {
  return {
    domain: body.domain,
    types: body.types,
    primaryType: body.primaryType,
    message: {
      ...body.value,
      value: BigInt(body.value.value),
      validAfter: BigInt(body.value.validAfter),
      validBefore: BigInt(body.value.validBefore),
    },
  };
}

describe.each(['MCP', 'SDK'] as const)(
  '%s transition fence for extracted catalog and executor behavior',
  (implementation) => {
    it('rejects a catalog bait-and-switch and reuses the five-minute cache', async () => {
      let discoveryFetches = 0;
      const listed = paymentAccept(LISTED_RESOURCE);
      const live = paymentAccept(LISTED_RESOURCE, ATTACKER);
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === DISCOVERY_URL) {
          discoveryFetches += 1;
          return jsonResponse(
            { items: [{ resource: LISTED_RESOURCE, accepts: [listed] }] },
            200,
          );
        }
        return jsonResponse({ accepts: [live] }, 402);
      });
      const runtime = await runtimeFor(
        implementation,
        fetchImpl as unknown as typeof fetch,
        'none',
      );

      const first = await runtime.quote(LISTED_RESOURCE);
      const second = await runtime.quote(LISTED_RESOURCE);

      expect(first.reasons).toContain('catalog_accept_mismatch');
      expect(second.reasons).toContain('catalog_accept_mismatch');
      expect(discoveryFetches).toBe(1);
    });

    it('rejects a query variant of a query-free listing before target I/O', async () => {
      const listed = paymentAccept(LISTED_RESOURCE);
      const live = paymentAccept(QUERY_RESOURCE);
      const fetchImpl = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url === DISCOVERY_URL) {
            return jsonResponse(
              { items: [{ resource: LISTED_RESOURCE, accepts: [listed] }] },
              200,
            );
          }
          if (url === QUERY_RESOURCE) {
            return new Headers(init?.headers).has('X-PAYMENT')
              ? jsonResponse({ unlocked: true }, 200)
              : jsonResponse({ accepts: [live] }, 402);
          }
          throw new Error(`unexpected URL: ${url}`);
        },
      );
      const runtime = await runtimeFor(
        implementation,
        fetchImpl as unknown as typeof fetch,
      );

      const result = await runtime.pay(QUERY_RESOURCE, { maxTotalJpyc: '2' });

      // 0.2.x admitted this variant. Exact catalog admission is the safe
      // behavior because the query may select an unreviewed GET side effect.
      expect(result.reasons).toContain('host_not_allowed');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('rejects a query-variant money switch before the target fetch', async () => {
      let paidFetches = 0;
      const listed = paymentAccept(LISTED_RESOURCE);
      const live = paymentAccept(QUERY_RESOURCE, ATTACKER);
      const fetchImpl = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === DISCOVERY_URL) {
            return jsonResponse(
              { items: [{ resource: LISTED_RESOURCE, accepts: [listed] }] },
              200,
            );
          }
          if (new Headers(init?.headers).has('X-PAYMENT')) paidFetches += 1;
          return jsonResponse({ accepts: [live] }, 402);
        },
      );
      const runtime = await runtimeFor(
        implementation,
        fetchImpl as unknown as typeof fetch,
      );

      const result = await runtime.pay(QUERY_RESOURCE, { maxTotalJpyc: '2' });

      expect(result.reasons).toContain('host_not_allowed');
      expect(result.reasons).not.toContain('catalog_accept_mismatch');
      expect(paidFetches).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('continues the serialized queue after a signing failure', async () => {
      let stewardCalls = 0;
      const fetchImpl = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url === RESOURCE) {
            return new Headers(init?.headers).has('X-PAYMENT')
              ? jsonResponse({ unlocked: true }, 200)
              : jsonResponse({ accepts: [paymentAccept()] }, 402);
          }
          if (url === `${STEWARD_URL}/vault/agent-1/sign-typed-data`) {
            stewardCalls += 1;
            if (stewardCalls === 1) {
              return jsonResponse({ ok: false, error: 'temporary' }, 503);
            }
            const body = JSON.parse(String(init?.body)) as Parameters<
              typeof stewardTypedData
            >[0];
            const signature = await account.signTypedData(stewardTypedData(body));
            return jsonResponse({ ok: true, data: { signature } }, 200);
          }
          throw new Error(`unexpected URL: ${url}`);
        },
      );
      const runtime = await runtimeFor(
        implementation,
        fetchImpl as unknown as typeof fetch,
        'steward',
      );

      const first = runtime.pay(RESOURCE, { maxTotalJpyc: '2' });
      const second = runtime.pay(RESOURCE, { maxTotalJpyc: '2' });

      await expect(first).rejects.toThrow('steward sign-typed-data failed (503)');
      await expect(second).resolves.toMatchObject({ status: 200 });
      expect(stewardCalls).toBe(2);
    });

    it('does not record a non-2xx result or block the next payment', async () => {
      let unlocks = 0;
      const fetchImpl = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === DISCOVERY_URL) {
            return jsonResponse({ items: [] }, 200);
          }
          if (!new Headers(init?.headers).has('X-PAYMENT')) {
            return jsonResponse({ accepts: [paymentAccept()] }, 402);
          }
          unlocks += 1;
          return unlocks === 1
            ? jsonResponse({ error: 'temporary' }, 503)
            : jsonResponse({ unlocked: true }, 200);
        },
      );
      const runtime = await runtimeFor(
        implementation,
        fetchImpl as unknown as typeof fetch,
      );

      const first = await runtime.pay(RESOURCE, { maxTotalJpyc: '2' });
      const second = await runtime.pay(RESOURCE, { maxTotalJpyc: '2' });

      expect(first.status).toBe(503);
      expect(second.status).toBe(200);
    });
  },
);
