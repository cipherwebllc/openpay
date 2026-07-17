import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

// MCP 0.12.0 の MAX_DAILY_JPYC 配線テスト: env 設定時のみ spendStore が consult され、
// 上限到達で支払い前 (X-PAYMENT 再訪前) に拒否されること。日次計算の本体 (境界/保存/
// fail-closed) は SDK 側テストが担う — ここは配線の on/off だけを固定する。

const MCP_ENTRY = resolve(process.cwd(), 'packages/x402-mcp/src/tools.mjs');
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const PRIVATE_KEY = `0x${'1'.repeat(64)}` as Hex;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x4444444444444444444444444444444444444444');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');

type McpModule = {
  createToolRuntime: (options: Record<string, unknown>) => {
    x402Pay: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

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

function challengeFetch() {
  let paidFetches = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).has('X-PAYMENT')) paidFetches += 1;
    return jsonResponse({ accepts: [paymentAccept(String(input))] }, 402);
  });
  return { fetchImpl, paidFetches: () => paidFetches };
}

const BASE_ENV = {
  ALLOWED_HOSTS: 'open-pay.jp',
  MAX_PER_CALL_JPYC: '10',
  MAX_SESSION_JPYC: '100',
  BUYER_PRIVATE_KEY: PRIVATE_KEY,
};

async function loadMcp(): Promise<McpModule> {
  return (await import(pathToFileURL(MCP_ENTRY).href)) as McpModule;
}

describe('openpay-x402-mcp MAX_DAILY_JPYC wiring', () => {
  it('rejects at the daily cap before any paid retry and consults the injected store', async () => {
    const mcp = await loadMcp();
    const { fetchImpl, paidFetches } = challengeFetch();
    const spendStore = {
      load: vi.fn(async () => (2n * 10n ** 18n).toString()), // 既に 2 JPYC 消費 = 上限
      save: vi.fn(async () => {}),
    };
    const runtime = mcp.createToolRuntime({
      env: { ...BASE_ENV, MAX_DAILY_JPYC: '2' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spendStore,
    });

    const result = await runtime.x402Pay({ url: RESOURCE, maxTotalJpyc: '2' });

    expect(result.reasons).toContain('daily_limit_exceeded');
    expect(spendStore.load).toHaveBeenCalledTimes(1);
    expect(paidFetches()).toBe(0);
    expect(spendStore.save).not.toHaveBeenCalled();
  });

  it('never consults the store when MAX_DAILY_JPYC is unset (previous behavior)', async () => {
    const mcp = await loadMcp();
    const { fetchImpl } = challengeFetch();
    const spendStore = {
      load: vi.fn(async () => '0'),
      save: vi.fn(async () => {}),
    };
    const runtime = mcp.createToolRuntime({
      env: { ...BASE_ENV },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spendStore,
    });

    await runtime.x402Pay({ url: RESOURCE, maxTotalJpyc: '3' });

    expect(spendStore.load).not.toHaveBeenCalled();
    expect(spendStore.save).not.toHaveBeenCalled();
  });
});
