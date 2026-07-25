// MCP の agent-order ツール (order_menu / order_quote) テスト。fetch を注入し、URL 正規順の組立・
// menu 取得・quote の x402Quote 委譲を検証する (payment.test の fetch 注入流儀を踏襲)。

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'viem';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';
import { encodeAgentCart, decodeAgentCart, type AgentCartItem } from '@/lib/agentOrder';

const JPYC = 10n ** 18n;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');

type ToolRuntime = {
  orderMenu: (args: unknown) => Promise<Record<string, unknown>>;
  orderQuote: (args: unknown) => Promise<Record<string, unknown>>;
  orderSummary: (args: unknown) => Promise<Record<string, unknown>>;
  createOrderLink: (args: unknown) => Promise<Record<string, unknown>>;
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

// 人払い (order_summary) の store-borne 内訳: 客は小計ちょうど・店が ~1% を吸収 (feeBearer='merchant')。
// x402 の買い手上乗せ (order_quote: totalJpyc 1616) と別物であることを示す (customerPaysJpyc=1600)。
const SUMMARY_BODY = {
  handle: 'shop',
  shopName: '居酒屋テスト',
  chain: 'polygon',
  currency: 'JPYC',
  items: [
    { name: '唐揚げ', qty: 2, unitPriceJpyc: '500', lineJpyc: '1000' },
    { name: 'ビール', qty: 1, unitPriceJpyc: '600', lineJpyc: '600' },
  ],
  subtotalJpyc: '1600',
  feeJpyc: '16',
  feeBearer: 'merchant',
  customerPaysJpyc: '1600',
};

const ENV = {
  DISCOVERY_URL: 'https://open-pay.jp/api/discovery',
  ALLOWED_HOSTS: 'open-pay.jp',
  MAX_PER_CALL_JPYC: '100000',
  MAX_SESSION_JPYC: '100000',
  CATALOG_TRUST: 'false',
};

describe('MCP agent-order tools', () => {
  it('order_menu / order_quote / order_summary を登録している', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV });
    const names = runtime.tools.map((t) => t.name);
    expect(names).toContain('order_menu');
    expect(names).toContain('order_quote');
    expect(names).toContain('order_summary');
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

// order_summary: 人払い (createOrderLink) の実額を読む読み取り専用ツール。summary エンドポイントを
// 叩き store-borne 内訳を返す (x402 の買い手上乗せ order_quote とは別物 = 混同解消の核心)。
describe('MCP order_summary', () => {
  it('正規順 (h,cart,table,pickupAt) の summary URL を組み store-borne 内訳を返す', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return response(200, SUMMARY_BODY);
    }) as unknown as typeof fetch;
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV, fetchImpl });
    const out = await runtime.orderSummary({
      handle: '@Shop',
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
    expect(calls[0]).toBe(
      `https://open-pay.jp/api/agent-order/summary?${params.toString()}`,
    );
    // store-borne: 客は小計ちょうど (1600) / 店が手数料 (16) を吸収 / 買い手上乗せの 1616 ではない。
    expect(out).toMatchObject({
      ok: true,
      customerPaysJpyc: '1600',
      subtotalJpyc: '1600',
      feeJpyc: '16',
      feeBearer: 'merchant',
    });
  });

  it('items 空を拒否する (createOrderLink と同じ normalizeCartItems)', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV });
    await expect(runtime.orderSummary({ handle: 'shop', items: [] })).rejects.toThrow();
  });

  it('summary 取得失敗 (非 200) は ok:false に倒す', async () => {
    const fetchImpl = (async () => response(404, { error: 'no_storefront' })) as unknown as typeof fetch;
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV, fetchImpl });
    const out = await runtime.orderSummary({ handle: 'shop', items: [{ id: 'karaage', qty: 1 }] });
    expect(out).toMatchObject({ ok: false, status: 404 });
  });
});

// createOrderLink: 人間が開く事前充填リンク (@handle?cart=)。鍵不要・fetch なし。
describe('MCP createOrderLink', () => {
  // fetch は絶対に呼ばれない (署名も送金もしない・URL 組立のみ)。呼ばれたら失敗させる。
  const noFetch = (async () => {
    throw new Error('createOrderLink must not fetch');
  }) as unknown as typeof fetch;

  it('createOrderLink を登録している', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV });
    expect(runtime.tools.map((t) => t.name)).toContain('createOrderLink');
  });

  it('鍵なし env でも動く (wallet-optional) — /@handle?cart= リンクを返す', async () => {
    const { createToolRuntime } = await loadTools();
    // BUYER_PRIVATE_KEY / STEWARD_* を一切持たない env。
    const runtime = createToolRuntime({ env: ENV, fetchImpl: noFetch });
    const out = await runtime.createOrderLink({
      handle: '@Shop',
      items: [
        { id: 'karaage', qty: 2 },
        { id: 'beer', qty: 1 },
      ],
      table: 'A5',
      pickupAt: '1700000000000',
    });
    expect(out).toMatchObject({ ok: true, handle: 'shop', itemCount: 2 });
    const url = new URL(out.url as string);
    // 受取先/価格を URL に載せない — path は @handle・query は cart/table/pickupAt のみ。
    expect(url.origin).toBe('https://open-pay.jp');
    expect(url.pathname).toBe('/@shop'); // handle 正規化 (@ 除去・小文字化)
    // cart は server の encodeAgentCart と byte 一致 (= @handle ページの decodeAgentCart が読める)。
    expect(url.searchParams.get('cart')).toBe(
      encodeAgentCart([
        { id: 'karaage', qty: 2 },
        { id: 'beer', qty: 1 },
      ]),
    );
    expect(url.searchParams.get('table')).toBe('A5');
    expect(url.searchParams.get('pickupAt')).toBe('1700000000000');
    // 決済トークン (?s=) は絶対に生成しない (C1: receiver スプーフィング回避)。
    expect(url.searchParams.get('s')).toBeNull();
    expect(url.pathname).not.toContain('/order');
  });

  it('table/pickupAt 未指定なら cart だけの最小リンク', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV, fetchImpl: noFetch });
    const out = await runtime.createOrderLink({ handle: 'shop', items: [{ id: 'karaage', qty: 1 }] });
    const url = new URL(out.url as string);
    expect([...url.searchParams.keys()]).toEqual(['cart']);
  });

  it('options 付きカートも options ごと cart に載る (脱落しない)', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV, fetchImpl: noFetch });
    const cart: AgentCartItem[] = [{ id: 'oj', qty: 1, options: { size: 'm', top: ['nori', 'egg'] } }];
    const out = await runtime.createOrderLink({ handle: 'shop', items: cart });
    const cartParam = new URL(out.url as string).searchParams.get('cart') as string;
    expect(cartParam).toBe(encodeAgentCart(cart));
  });

  it('空 items / 不正 options は throw (order_quote と同じ normalizeCartItems)', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ env: ENV, fetchImpl: noFetch });
    await expect(runtime.createOrderLink({ handle: 'shop', items: [] })).rejects.toThrow();
    await expect(runtime.createOrderLink({ handle: 'shop' })).rejects.toThrow();
    await expect(
      runtime.createOrderLink({ handle: 'shop', items: [{ id: 'oj', qty: 1, options: { size: 5 } }] }),
    ).rejects.toThrow(/options/);
  });
});

// フォーマット互換フェンス (drift 防止): MCP の cart 直列化 (encodeCart・createOrderLink 経由) と
// server の lib/agentOrder.encodeAgentCart / decodeAgentCart が **同一フォーマット** であることを
// 複数のカート形で保証する。ここが割れると事前充填・agent-order の cart が読めなくなる。
describe('MCP ⇄ server cart フォーマット互換フェンス', () => {
  const CARTS: AgentCartItem[][] = [
    [{ id: 'a', qty: 1 }],
    [
      { id: 'karaage', qty: 2 },
      { id: 'beer', qty: 1 },
    ],
    [{ id: 'oj', qty: 3, options: { size: 'm' } }],
    [{ id: 'oj', qty: 1, options: { size: 'l', top: ['nori', 'egg'] } }],
    [
      { id: 'x', qty: 1, options: { g: ['c1', 'c2'] } },
      { id: 'y', qty: 5 },
    ],
    [{ id: '日本語id', qty: 1, options: { サイズ: '大' } }], // 非 ASCII (UTF-8 経路)
  ];

  it('MCP createOrderLink の cart param が server encodeAgentCart と byte 一致し、decodeAgentCart で往復する', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({
      env: ENV,
      fetchImpl: (async () => {
        throw new Error('must not fetch');
      }) as unknown as typeof fetch,
    });
    for (const cart of CARTS) {
      const out = await runtime.createOrderLink({ handle: 'shop', items: cart });
      const cartParam = new URL(out.url as string).searchParams.get('cart') as string;
      // 1) MCP 直列化 === server 直列化 (byte 一致)。
      expect(cartParam).toBe(encodeAgentCart(cart));
      // 2) server の untrusted decode が MCP 出力を検証付きで往復できる (フォーマット契約の両端)。
      expect(decodeAgentCart(cartParam)).toEqual(cart);
    }
  });
});
