import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

const JPYC = 10n ** 18n;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const BUYER_PRIVATE_KEY = `0x${'1'.repeat(64)}`;

type ToolRuntime = {
  findShops: (args: unknown) => Promise<Record<string, unknown>>;
  searchShops: (args: unknown) => Promise<Record<string, unknown>>;
};

async function loadTools(): Promise<{
  createToolRuntime: (options: {
    profile?: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    nowSec?: () => number;
  }) => ToolRuntime;
}> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'packages/x402-mcp/src/tools.mjs')).href
  )) as never;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function shopSearchAccept(url: string) {
  const merchantValue = 2n * JPYC;
  const feeValue = 1n * JPYC;
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (merchantValue + feeValue).toString(),
    resource: url,
    description: 'Search opt-in OpenPay shops',
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
        merchantValue: merchantValue.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: feeValue.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
}

const ENV = {
  DISCOVERY_URL: 'https://open-pay.jp/api/discovery',
  ALLOWED_HOSTS: 'open-pay.jp',
  MAX_PER_CALL_JPYC: '10',
  MAX_SESSION_JPYC: '100',
  CATALOG_TRUST: 'false',
};

describe('MCP Shops convenience tools', () => {
  it('find_shops は order profile・鍵なしで無料 find を呼び、注文への次手を返す', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          schemaVersion: '1.0',
          query: { q: 'Blue Cafe', limit: 5 },
          items: [
            {
              handle: 'blue',
              name: 'Blue Cafe',
              mode: 'storefront',
              acceptingNow: true,
            },
          ],
          total: 1,
        },
        200,
      ),
    );
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({
      profile: 'order',
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const out = await runtime.findShops({ q: 'Blue Cafe', limit: 5 });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://open-pay.jp/api/shops/find?q=Blue+Cafe&limit=5',
      { headers: { accept: 'application/json' } },
    );
    expect(out).toMatchObject({ ok: true, total: 1 });
    expect(out.nextStep).toContain('order_menu(handle)');
    expect(out.nextStep).toContain('createOrderLink');
  });

  it('search_shops は query を組み、既存 x402_pay の guard→署名→解錠を通す', async () => {
    const expectedUrl =
      'https://open-pay.jp/api/paid/jpyc-shops/search?q=Blue+Cafe&mode=storefront&dineIn=true&acceptingNow=false&limit=10&offset=2';
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(expectedUrl);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if ('X-PAYMENT' in headers) {
          return jsonResponse({ items: [{ handle: 'blue' }], total: 1 }, 200);
        }
        return jsonResponse({ accepts: [shopSearchAccept(expectedUrl)] }, 402);
      },
    );
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({
      env: { ...ENV, BUYER_PRIVATE_KEY },
      fetchImpl,
      nowSec: () => 1_000_000_000,
    });

    const out = await runtime.searchShops({
      q: 'Blue Cafe',
      mode: 'storefront',
      dineIn: true,
      acceptingNow: false,
      limit: 10,
      offset: 2,
      maxTotalJpyc: '3',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({
      status: 200,
      body: { items: [{ handle: 'blue' }], total: 1 },
    });
  });

  it('search_shops は maxTotalJpyc 不足を既存 guard で拒否し、解錠 fetch しない', async () => {
    const expectedUrl = 'https://open-pay.jp/api/paid/jpyc-shops/search';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ accepts: [shopSearchAccept(expectedUrl)] }, 402),
    );
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({
      env: { ...ENV, BUYER_PRIVATE_KEY },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const out = await runtime.searchShops({ maxTotalJpyc: '2.99' });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(out).toMatchObject({
      ok: false,
      reasons: ['total_exceeds_max_total'],
      totalJpyc: '3',
    });
  });
});
