// MCP の agent-order ツール (order_menu / order_quote) テスト。fetch を注入し、URL 正規順の組立・
// menu 取得・quote の x402Quote 委譲を検証する (payment.test の fetch 注入流儀を踏襲)。

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'viem';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';
import { encodeAgentCart } from '@/lib/agentOrder';

const JPYC = 10n ** 18n;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x4444444444444444444444444444444444444444');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');

type ToolRuntime = {
  orderMenu: (args: unknown) => Promise<Record<string, unknown>>;
  orderQuote: (args: unknown) => Promise<Record<string, unknown>>;
  tools: Array<{ name: string }>;
};

async function loadTools(): Promise<{
  createToolRuntime: (opts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  }) => ToolRuntime;
}> {
  return (await import(
    pathToFileURL(
      resolve(process.cwd(), 'packages/x402-mcp/src/tools.mjs'),
    ).href
  )) as never;
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function payAccept(url: string) {
  const merchantValue = 1600n * JPYC;
  const feeValue = 16n * JPYC;
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (merchantValue + feeValue).toString(),
    resource: url,
    description: 'shop',
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

const MENU_BODY = {
  handle: 'shop',
  shopName: '居酒屋テスト',
  mode: 'storefront',
  chain: 'polygon',
  items: [
    { id: 'karaage', name: '唐揚げ', price: '500', hasOptions: false },
    { id: 'beer', name: 'ビール', price: '600', hasOptions: false },
  ],
};

const ENV = {
  DISCOVERY_URL: 'https://open-pay.jp/api/discovery',
  ALLOWED_HOSTS: 'open-pay.jp',
  MAX_PER_CALL_JPYC: '100000',
  MAX_SESSION_JPYC: '100000',
  CATALOG_TRUST: 'false',
};

describe('MCP agent-order tools', () => {
  it('order_menu / order_quote を登録している', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV });
    const names = runtime.tools.map((t) => t.name);
    expect(names).toContain('order_menu');
    expect(names).toContain('order_quote');
  });

  it('order_menu は @handle を正規化して menu を取得する', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return response(200, MENU_BODY);
    }) as unknown as typeof fetch;
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV, fetchImpl });
    const out = await runtime.orderMenu({ handle: '@Shop' });
    expect(calls[0]).toBe('https://open-pay.jp/api/agent-order/menu?h=shop');
    expect(out).toMatchObject({ ok: true, handle: 'shop', chain: 'polygon' });
  });

  it('order_quote は正規順 (h,cart,table,pickupAt) の pay URL を組み x402Quote に委譲する', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return response(402, {
        x402Version: 1,
        accepts: [payAccept(url)],
        error: 'payment_required',
      });
    }) as unknown as typeof fetch;
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV, fetchImpl });
    const out = await runtime.orderQuote({
      handle: 'shop',
      items: [
        { id: 'karaage', qty: 2 },
        { id: 'beer', qty: 1 },
      ],
      table: 'A5',
      pickupAt: '1700000000000',
    });

    const params = new URLSearchParams();
    params.set('h', 'shop');
    params.set('cart', encodeAgentCart([
      { id: 'karaage', qty: 2 },
      { id: 'beer', qty: 1 },
    ]));
    params.set('table', 'A5');
    params.set('pickupAt', '1700000000000');
    const expectedUrl = `https://open-pay.jp/api/agent-order/pay?${params.toString()}`;

    expect(calls[0]).toBe(expectedUrl);
    // x402Quote 由来の shape: url + 内訳 + ok/reasons。
    expect(out).toMatchObject({
      url: expectedUrl,
      ok: true,
      totalJpyc: '1616',
      priceJpyc: '1600',
      feeJpyc: '16',
    });
  });

  it('order_quote は items 空を拒否する', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV });
    await expect(runtime.orderQuote({ handle: 'shop', items: [] })).rejects.toThrow();
  });

  it('order_quote: items[].options が cart param まで脱落せず届く (0.5.0 実バグの回帰)', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return response(402, {
        x402Version: 1,
        accepts: [payAccept(url)],
        error: 'payment_required',
      });
    }) as unknown as typeof fetch;
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV, fetchImpl });
    await runtime.orderQuote({
      handle: 'shop',
      items: [{ id: 'oj', qty: 1, options: { size: 'm', top: ['nori', 'egg'] } }],
    });
    const payUrl = calls.find((u) => u.includes('/api/agent-order/pay'));
    expect(payUrl).toBeDefined();
    const cartParam = new URL(payUrl as string).searchParams.get('cart') as string;
    // server の encodeAgentCart と byte 一致 (= decodeAgentCart が options ごと読める)
    expect(cartParam).toBe(
      encodeAgentCart([{ id: 'oj', qty: 1, options: { size: 'm', top: ['nori', 'egg'] } }]),
    );
  });

  it('order_quote: 不正な options (配列/非文字列値) は throw', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV, fetchImpl: (async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch });
    await expect(
      runtime.orderQuote({ handle: 'shop', items: [{ id: 'oj', qty: 1, options: [] }] }),
    ).rejects.toThrow(/options/);
    await expect(
      runtime.orderQuote({
        handle: 'shop',
        items: [{ id: 'oj', qty: 1, options: { size: 5 } }],
      }),
    ).rejects.toThrow(/options/);
  });
});
