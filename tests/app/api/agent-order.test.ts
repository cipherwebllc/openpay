// agent-order menu / pay route テスト。handleStore.resolveHandle と facilitator verify/settle +
// 受注リレー notify の各 POST を mock し、flag / 検証 / 402 accepts / settle→notify 合成呼び出し /
// notify 失敗の隔離 (200 + orderRegistered:false) を検証する。
// mock 流儀: kv/session mock は facilitator-discovery、verify/settle mock は paid-first-party に倣う。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getAddress } from 'viem';
import { encodeAgentCart } from '@/lib/agentOrder';
import type { HandleRecord } from '@/lib/handle';

const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
const PAYER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');
const TX_HASH = `0x${'ab'.repeat(32)}`;
const AMOY = 80002;

const store = vi.hoisted(() => ({
  record: null as HandleRecord | null,
  ok: true,
}));
vi.mock('@/lib/handleStore', () => ({
  resolveHandle: async () =>
    store.ok
      ? { ok: true as const, record: store.record }
      : { ok: false as const },
}));

const shopLiveMocks = vi.hoisted(() => ({
  configured: false,
  kvGet: vi.fn(),
}));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => shopLiveMocks.configured,
  kvGet: shopLiveMocks.kvGet,
  kvEval: vi.fn(),
}));

const routeMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  settle: vi.fn(),
  notify: vi.fn(),
  status: vi.fn(),
  statusAllowed: vi.fn(),
}));
vi.mock('@/app/api/facilitator/verify/route', () => ({ POST: routeMocks.verify }));
vi.mock('@/app/api/facilitator/settle/route', () => ({ POST: routeMocks.settle }));
vi.mock('@/app/api/order/notify/route', () => ({ POST: routeMocks.notify }));
vi.mock('@/lib/x402/facilitatorStatus', () => ({
  resolveFacilitatorPaymentStatus: routeMocks.status,
}));
vi.mock('@/lib/x402/facilitatorStatusRateLimit', () => ({
  checkFacilitatorStatusRateLimit: routeMocks.statusAllowed,
}));

const redeliveryMocks = vi.hoisted(() => ({
  identity: vi.fn(),
  lookup: vi.fn(),
  claim: vi.fn(),
  promote: vi.fn(),
  release: vi.fn(),
  preBroadcast: vi.fn(),
  record: null as Record<string, unknown> | null,
}));
vi.mock('@/lib/x402/paymentRedelivery', () => ({
  paymentRedeliveryIdentity: redeliveryMocks.identity,
  lookupPaymentRedelivery: redeliveryMocks.lookup,
  claimPaymentRedelivery: redeliveryMocks.claim,
  promotePaymentRedelivery: redeliveryMocks.promote,
  releasePaymentRedelivery: redeliveryMocks.release,
  isFacilitatorPreBroadcastRejection: redeliveryMocks.preBroadcast,
}));

const PAYMENT_IDENTITY = {
  keyIdentity: `x402:redelivery:${'a'.repeat(64)}`,
  credential: 'b'.repeat(64),
};

function bindingMatches(
  record: Record<string, unknown>,
  binding: { scope: string; resource: string },
): boolean {
  return (
    record.scope === binding.scope &&
    record.resource === binding.resource &&
    record.credential === PAYMENT_IDENTITY.credential
  );
}

function record(overrides: Partial<HandleRecord> = {}): HandleRecord {
  return {
    owner: SELLER,
    config: {
      to: SELLER,
      name: '居酒屋テスト',
      methods: [{ token: 'jpyc', chain: 'polygon' }],
    },
    storefront: {
      chain: 'polygon',
      mode: 'storefront',
      feePayer: 'merchant',
      menu: [
        { id: 'karaage', name: '唐揚げ', price: '500' },
        { id: 'beer', name: 'ビール', price: '600' },
      ],
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as HandleRecord;
}

// 500*2 + 600*1 = 1600 JPYC
const CART = encodeAgentCart([
  { id: 'karaage', qty: 2 },
  { id: 'beer', qty: 1 },
]);
const JPYC = 10n ** 18n;

type MenuRoute = { GET: (req: Request) => Promise<Response> };
type PayRoute = { GET: (req: Request) => Promise<Response> };
type SummaryRoute = { GET: (req: Request) => Promise<Response> };

async function load(
  flags: {
    facilitator?: string;
    relay?: string;
    agent?: string;
    shopLive?: string;
    preorderTime?: string;
    kairosForwarder?: string;
  } = {},
): Promise<{ menu: MenuRoute; pay: PayRoute; summary: SummaryRoute }> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', flags.facilitator ?? '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', flags.relay ?? '1');
  vi.stubEnv('ENABLE_AGENT_ORDER', flags.agent ?? '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOP_LIVE', flags.shopLive ?? '');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_PREORDER_TIME', flags.preorderTime ?? '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv(
    'NEXT_PUBLIC_JPYC_FORWARDER_KAIROS',
    flags.kairosForwarder ?? '',
  );
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
  vi.resetModules();
  const menu = (await import('@/app/api/agent-order/menu/route')) as MenuRoute;
  const pay = (await import('@/app/api/agent-order/pay/route')) as PayRoute;
  const summary = (await import(
    '@/app/api/agent-order/summary/route'
  )) as SummaryRoute;
  return { menu, pay, summary };
}

function menuReq(query: string): Request {
  return new Request(`https://open-pay.jp/api/agent-order/menu?${query}`);
}

function summaryReq(query: string): Request {
  return new Request(`https://open-pay.jp/api/agent-order/summary?${query}`);
}

function payReq(query: string, headers?: Record<string, string>): Request {
  return new Request(`https://open-pay.jp/api/agent-order/pay?${query}`, {
    headers,
  });
}

function paymentHeader(): string {
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:80002',
    payload: {
      signature: `0x${'01'.repeat(32)}${'02'.repeat(32)}1b`,
      authorization: {
        from: PAYER,
        validAfter: '0',
        validBefore: '9999999999',
        intentSalt: `0x${'22'.repeat(32)}`,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

beforeEach(() => {
  store.record = record();
  store.ok = true;
  shopLiveMocks.configured = false;
  shopLiveMocks.kvGet.mockReset();
  shopLiveMocks.kvGet.mockResolvedValue({ ok: true, value: null });
  routeMocks.verify.mockReset();
  routeMocks.settle.mockReset();
  routeMocks.notify.mockReset();
  routeMocks.status.mockReset();
  routeMocks.statusAllowed.mockReset();
  routeMocks.status.mockResolvedValue({
    ok: true,
    chainId: AMOY,
    payer: PAYER,
    state: 'unused',
  });
  routeMocks.statusAllowed.mockResolvedValue(true);

  redeliveryMocks.record = null;
  redeliveryMocks.identity.mockReset();
  redeliveryMocks.lookup.mockReset();
  redeliveryMocks.claim.mockReset();
  redeliveryMocks.promote.mockReset();
  redeliveryMocks.release.mockReset();
  redeliveryMocks.preBroadcast.mockReset();
  redeliveryMocks.identity.mockReturnValue(PAYMENT_IDENTITY);
  redeliveryMocks.preBroadcast.mockImplementation(
    (status: number, body: Record<string, unknown>) =>
      status >= 400 &&
      (body.errorReason === 'rate_limited' ||
        body.error === 'ip_rate_limited'),
  );
  redeliveryMocks.lookup.mockImplementation(
    async (
      _identity: unknown,
      binding: { scope: string; resource: string },
    ) => {
      const existing = redeliveryMocks.record;
      if (existing === null) return { kind: 'missing' };
      return bindingMatches(existing, binding)
        ? { kind: 'match', record: existing }
        : { kind: 'conflict' };
    },
  );
  redeliveryMocks.claim.mockImplementation(
    async (input: {
      binding: { scope: string; resource: string };
      facilitatorBody: Record<string, unknown>;
      context: Record<string, unknown>;
    }) => {
      const existing = redeliveryMocks.record;
      if (existing !== null) {
        return bindingMatches(existing, input.binding)
          ? { kind: 'match', record: existing }
          : { kind: 'conflict' };
      }
      const pending = {
        version: 1,
        state: 'pending',
        scope: input.binding.scope,
        resource: input.binding.resource,
        credential: PAYMENT_IDENTITY.credential,
        ownerToken: 'c'.repeat(64),
        facilitatorBody: input.facilitatorBody,
        context: input.context,
      };
      redeliveryMocks.record = pending;
      return { kind: 'claimed', record: pending };
    },
  );
  redeliveryMocks.promote.mockImplementation(
    async (input: {
      binding: { scope: string; resource: string };
      settlement: Record<string, unknown>;
    }) => {
      const existing = redeliveryMocks.record;
      if (existing === null) return { kind: 'missing' };
      if (!bindingMatches(existing, input.binding)) {
        return { kind: 'conflict' };
      }
      if (existing.state === 'settled') {
        return { kind: 'already-settled', record: existing };
      }
      const settled = {
        ...existing,
        state: 'settled',
        settlement: input.settlement,
      };
      redeliveryMocks.record = settled;
      return { kind: 'promoted', record: settled };
    },
  );
  redeliveryMocks.release.mockImplementation(
    async (input: {
      binding: { scope: string; resource: string };
      ownerToken: string;
    }) => {
      const existing = redeliveryMocks.record;
      if (
        existing === null ||
        !bindingMatches(existing, input.binding) ||
        existing.ownerToken !== input.ownerToken
      ) {
        return { kind: 'not-owner' };
      }
      redeliveryMocks.record = null;
      return { kind: 'released' };
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('agent-order flag gating', () => {
  it('いずれかの flag OFF なら menu / pay とも 404', async () => {
    for (const flags of [
      { facilitator: '' },
      { relay: '' },
      { agent: '' },
    ]) {
      const { menu, pay, summary } = await load(flags);
      expect((await menu.GET(menuReq('h=shop'))).status).toBe(404);
      expect((await pay.GET(payReq(`h=shop&cart=${CART}`))).status).toBe(404);
      expect(
        (await summary.GET(summaryReq(`h=shop&cart=${CART}`))).status,
      ).toBe(404);
    }
  });
});

describe('agent-order menu route', () => {
  it('公開メニューを返す (shopName/mode/chain/items)', async () => {
    const { menu } = await load();
    const res = await menu.GET(menuReq('h=shop'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      handle: string;
      shopName: string;
      mode: string;
      chain: string;
      paymentSupported: boolean;
      items: Array<{ id: string; name: string; price: string; hasOptions: boolean }>;
    };
    expect(body).toMatchObject({
      handle: 'shop',
      shopName: '居酒屋テスト',
      mode: 'storefront',
      chain: 'polygon',
      paymentSupported: true,
    });
    expect(body.items).toEqual([
      { id: 'karaage', name: '唐揚げ', price: '500', hasOptions: false },
      { id: 'beer', name: 'ビール', price: '600', hasOptions: false },
    ]);
  });

  it('storefront 無しは 404', async () => {
    store.record = record({ storefront: undefined });
    const { menu } = await load();
    expect((await menu.GET(menuReq('h=shop'))).status).toBe(404);
  });

  it('facilitator 対応外チェーンは paymentSupported=false として事前開示する', async () => {
    store.record = record({
      storefront: {
        chain: 'kaia',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [{ id: 'karaage', name: '唐揚げ', price: '500' }],
      },
    } as Partial<HandleRecord>);
    const { menu } = await load({ kairosForwarder: FORWARDER });
    const res = await menu.GET(menuReq('h=shop'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      chain: 'kaia',
      paymentSupported: false,
    });
  });
});

describe('agent-order summary route (人払い store-borne)', () => {
  it('store-borne 内訳を返す (customerPays=小計・fee=1%・feeBearer=merchant)', async () => {
    const { summary } = await load();
    const res = await summary.GET(summaryReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      handle: string;
      shopName: string;
      chain: string;
      currency: string;
      items: Array<{
        name: string;
        qty: number;
        unitPriceJpyc: string;
        lineJpyc: string;
      }>;
      subtotalJpyc: string;
      feeJpyc: string;
      feeBearer: string;
      customerPaysJpyc: string;
    };
    expect(body).toMatchObject({
      handle: 'shop',
      shopName: '居酒屋テスト',
      chain: 'polygon',
      currency: 'JPYC',
      // 小計 1600 / fee = 1600*1% = 16 (フロア無し) / 客は小計ちょうど (store-borne)。
      subtotalJpyc: '1600',
      feeJpyc: '16',
      feeBearer: 'merchant',
      customerPaysJpyc: '1600',
    });
    expect(body.items).toEqual([
      { name: '唐揚げ', qty: 2, unitPriceJpyc: '500', lineJpyc: '1000' },
      { name: 'ビール', qty: 1, unitPriceJpyc: '600', lineJpyc: '600' },
    ]);
  });

  it('手数料は mobileOrderFee (1%・フロア無し) — x402 の floor (2 JPYC) は効かない', async () => {
    // 100 JPYC の注文: mobileOrderFee 1% = 1 JPYC (フロア無し)。x402FeeValue を誤用すると
    // max(2,1)=2 になる。summary が人払い checkout の実額 (フロア無し) に一致する証明。
    store.record = record({
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [{ id: 'tea', name: 'お茶', price: '100' }],
      },
    } as Partial<HandleRecord>);
    const cart = encodeAgentCart([{ id: 'tea', qty: 1 }]);
    const { summary } = await load();
    const res = await summary.GET(summaryReq(`h=shop&cart=${cart}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feeJpyc: string;
      customerPaysJpyc: string;
      feeBearer: string;
    };
    expect(body.feeJpyc).toBe('1'); // 1% フロア無し (x402FeeValue の 2 ではない)
    expect(body.customerPaysJpyc).toBe('100'); // store-borne = 小計ちょうど
    expect(body.feeBearer).toBe('merchant');
  });

  it('cart 不正は 422', async () => {
    const { summary } = await load();
    const res = await summary.GET(summaryReq('h=shop&cart=%21%21%21bad'));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('invalid_cart');
  });

  it('storefront 無しは 404', async () => {
    store.record = record({ storefront: undefined });
    const { summary } = await load();
    const res = await summary.GET(summaryReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no_storefront');
  });
});

describe('agent-order pay route', () => {
  it('cart 不正は 422', async () => {
    const { pay } = await load();
    const res = await pay.GET(payReq('h=shop&cart=%21%21%21bad'));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('invalid_cart');
  });

  it('payment ヘッダ無し → 402 + accepts (payTo=config.to / amount=合計 / resource 正規)', async () => {
    const { pay } = await load();
    const res = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: Array<{
        resource: string;
        payTo: string;
        maxAmountRequired: string;
        extra: { openpay: { merchant: string; merchantValue: string; feeValue: string } };
      }>;
    };
    const pr = body.accepts[0];
    // 権威 seller = config.to (payTo は on-chain forwarder)。
    expect(pr.extra.openpay.merchant).toBe(SELLER);
    expect(pr.payTo).toBe(FORWARDER);
    // merchantValue=1600 / fee=max(2, 1600*1%)=16 / total=1616
    expect(pr.extra.openpay.merchantValue).toBe((1600n * JPYC).toString());
    expect(pr.extra.openpay.feeValue).toBe((16n * JPYC).toString());
    expect(pr.maxAmountRequired).toBe((1616n * JPYC).toString());
    // resource は正規順 (h, cart) の自 URL (canonical origin)。
    const params = new URLSearchParams();
    params.set('h', 'shop');
    params.set('cart', CART);
    expect(pr.resource).toBe(
      `https://open-pay.jp/api/agent-order/pay?${params.toString()}`,
    );
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('acceptingOrders=false は shop-live flag OFF でも plain 409 で停止', async () => {
    store.record = record({
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [
          { id: 'karaage', name: '唐揚げ', price: '500' },
          { id: 'beer', name: 'ビール', price: '600' },
        ],
        acceptingOrders: false,
      },
    } as Partial<HandleRecord>);
    const { pay } = await load({ shopLive: '' });
    const res = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'store_not_accepting' });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(shopLiveMocks.kvGet).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('shop-live ON で paused は plain 409 store_not_accepting', async () => {
    shopLiveMocks.configured = true;
    shopLiveMocks.kvGet.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ soldOut: [], paused: true, updatedAt: 1 }),
    });
    const { pay } = await load({ shopLive: '1' });
    const res = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'store_not_accepting' });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('shop-live ON で cart に soldOut 商品を含むと全注文を plain 409 で拒否', async () => {
    shopLiveMocks.configured = true;
    shopLiveMocks.kvGet.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ soldOut: ['beer'], paused: false, updatedAt: 1 }),
    });
    const { pay } = await load({ shopLive: '1' });
    const res = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'item_sold_out' });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('preorder-time ON で lastOrder 超過なら mode によらず plain 409', async () => {
    store.record = record({
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [
          { id: 'karaage', name: '唐揚げ', price: '500' },
          { id: 'beer', name: 'ビール', price: '600' },
        ],
        lastOrder: '00:00',
      },
    } as Partial<HandleRecord>);
    const { pay } = await load({ preorderTime: '1' });
    const res = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'store_not_accepting' });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('preorder-time ON で lead 後の受取スロットが 0 件なら challenge 前に 409', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T03:00:00.000Z')); // Asia/Tokyo 12:00
    store.record = record({
      storefront: {
        chain: 'polygon',
        mode: 'preorder',
        feePayer: 'merchant',
        menu: [
          { id: 'karaage', name: '唐揚げ', price: '500' },
          { id: 'beer', name: 'ビール', price: '600' },
        ],
        minLeadMinutes: 90,
        lastOrder: '13:00',
      },
    } as Partial<HandleRecord>);
    const { pay } = await load({ preorderTime: '1' });
    const res = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'store_not_accepting' });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('preorder-time ON で開店前なら支払いヘッダがあっても plain 409 で settle しない', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T03:00:00.000Z')); // Asia/Tokyo 12:00
    store.record = record({
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [
          { id: 'karaage', name: '唐揚げ', price: '500' },
          { id: 'beer', name: 'ビール', price: '600' },
        ],
        openFrom: '13:00',
      },
    } as Partial<HandleRecord>);
    const { pay } = await load({ preorderTime: '1' });
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'store_not_accepting' });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
    expect(routeMocks.notify).not.toHaveBeenCalled();
  });

  it('受付中・在庫あり・openFrom 後かつ lastOrder 前なら各 flag ON でも従来の 402 challenge', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T03:00:00.000Z')); // Asia/Tokyo 12:00
    store.record = record({
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [
          { id: 'karaage', name: '唐揚げ', price: '500' },
          { id: 'beer', name: 'ビール', price: '600' },
        ],
        openFrom: '11:00',
        lastOrder: '23:00',
      },
    } as Partial<HandleRecord>);
    shopLiveMocks.configured = true;
    shopLiveMocks.kvGet.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ soldOut: [], paused: false, updatedAt: 1 }),
    });
    const { pay } = await load({ shopLive: '1', preorderTime: '1' });
    const res = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('payment_required');
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('shop-live KV 障害は EMPTY へ fail-open し、静的 acceptingOrders は維持', async () => {
    shopLiveMocks.configured = true;
    shopLiveMocks.kvGet.mockResolvedValue({ ok: false, reason: 'network_error' });
    const { pay } = await load({ shopLive: '1' });

    const openRes = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(openRes.status).toBe(402);
    expect((await openRes.json()).error).toBe('payment_required');

    store.record = record({
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [
          { id: 'karaage', name: '唐揚げ', price: '500' },
          { id: 'beer', name: 'ビール', price: '600' },
        ],
        acceptingOrders: false,
      },
    } as Partial<HandleRecord>);
    const closedRes = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(closedRes.status).toBe(409);
    expect(await closedRes.json()).toEqual({ error: 'store_not_accepting' });
    expect(shopLiveMocks.kvGet).toHaveBeenCalledTimes(1);
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('unsupported_chain (forwarder 未設定) は 422', async () => {
    const { pay } = await load();
    // Avalanche は本テスト env で forwarder 未設定 → storefront.chain を差し替える。
    store.record = record({
      storefront: {
        chain: 'kaia', // kairos forwarder 未 stub → configuredJpycForwarderFor=null
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [{ id: 'karaage', name: '唐揚げ', price: '500' }],
      },
    } as Partial<HandleRecord>);
    const res = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('unsupported_chain');
  });

  it('deployment/forwarder があっても facilitator 対応外なら challenge 前に 422', async () => {
    store.record = record({
      storefront: {
        chain: 'kaia',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [{ id: 'karaage', name: '唐揚げ', price: '500' }],
      },
    } as Partial<HandleRecord>);
    const { pay } = await load({ kairosForwarder: FORWARDER });
    const res = await pay.GET(payReq(`h=shop&cart=${CART}`));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'unsupported_chain' });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('X-PAYMENT → verify/settle 後に notify を合成 Request で内部呼び出しし 200', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({ success: true, transaction: TX_HASH, payer: PAYER }),
    );
    routeMocks.notify.mockResolvedValue(
      NextResponse.json({ ok: true, orderId: `agent-${TX_HASH.slice(0, 18)}` }),
    );
    const { pay } = await load();
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}&table=A5`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      orderId: string;
      txHash: string;
      amountJpyc: string;
      orderRegistered: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.orderRegistered).toBe(true);
    expect(body.txHash).toBe(TX_HASH);
    expect(body.amountJpyc).toBe('1600');
    expect(body.orderId).toBe(`agent-${TX_HASH.slice(0, 18)}`);

    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);
    expect(routeMocks.notify).toHaveBeenCalledTimes(1);

    const notifyReq = routeMocks.notify.mock.calls[0][0] as Request;
    expect(new URL(notifyReq.url).pathname).toBe('/api/order/notify');
    expect(new URL(notifyReq.url).searchParams.get('h')).toBe('shop');
    const notifyBody = (await notifyReq.json()) as {
      token: string;
      txHash: string;
      chainId: number;
      merchant: string;
      items: Array<{ name: string; qty: number; price: string }>;
      description?: string;
      from: string;
    };
    expect(notifyBody).toMatchObject({
      token: 'jpyc',
      txHash: TX_HASH,
      chainId: AMOY,
      merchant: SELLER,
      description: 'A5',
      from: PAYER,
    });
    // 明細は **サーバー検証済み** (menu 由来の name/price)。
    expect(notifyBody.items).toEqual([
      { name: '唐揚げ', qty: 2, price: '500' },
      { name: 'ビール', qty: 1, price: '600' },
    ]);

    // X-PAYMENT-RESPONSE ヘッダに settle 応答が載る。
    const paymentResponse = JSON.parse(
      Buffer.from(res.headers.get('x-payment-response') ?? '', 'base64').toString('utf8'),
    );
    expect(paymentResponse).toMatchObject({ success: true, transaction: TX_HASH });
  });

  it('broadcast 前 rate limit は所有 claim を解放し、authorization 期限内の再試行を塞がない', async () => {
    routeMocks.verify.mockImplementation(
      async () => NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle
      .mockResolvedValueOnce(
        NextResponse.json(
          {
            success: false,
            errorReason: 'rate_limited',
            payer: PAYER,
          },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        NextResponse.json({
          success: true,
          transaction: TX_HASH,
          payer: PAYER,
        }),
      );
    routeMocks.notify.mockResolvedValue(NextResponse.json({ ok: true }));
    const { pay } = await load();
    const request = () =>
      pay.GET(
        payReq(`h=shop&cart=${CART}`, {
          'X-PAYMENT': paymentHeader(),
        }),
      );

    const limited = await request();
    expect(limited.status).toBe(429);
    expect((await limited.json()).errorReason).toBe('rate_limited');
    expect(redeliveryMocks.release).toHaveBeenCalledWith({
      identity: PAYMENT_IDENTITY,
      binding: expect.objectContaining({ scope: 'agent-order' }),
      ownerToken: 'c'.repeat(64),
    });
    expect(redeliveryMocks.record).toBeNull();

    const retried = await request();
    expect(retried.status).toBe(200);
    expect(routeMocks.verify).toHaveBeenCalledTimes(2);
    expect(routeMocks.settle).toHaveBeenCalledTimes(2);
    expect(routeMocks.notify).toHaveBeenCalledOnce();
  });

  it('notify 失敗は決済成功を巻き込まない (200 + orderRegistered:false)', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({ success: true, transaction: TX_HASH, payer: PAYER }),
    );
    routeMocks.notify.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'kv_error' }, { status: 503 }),
    );
    const { pay } = await load();
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; orderRegistered: boolean; txHash: string };
    expect(body.ok).toBe(true);
    expect(body.orderRegistered).toBe(false);
    expect(body.txHash).toBe(TX_HASH);
  });

  it('notify が throw しても決済成功は守られる (200 + orderRegistered:false)', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({ success: true, transaction: TX_HASH, payer: PAYER }),
    );
    routeMocks.notify.mockRejectedValue(new Error('boom'));
    const { pay } = await load();
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).orderRegistered).toBe(false);
  });

  it('settle pending → 同一 payment/resource の retry で二重 settle せず受注を回復する', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'indeterminate',
    });
    routeMocks.notify.mockResolvedValue(
      NextResponse.json({ ok: true, orderId: `agent-${TX_HASH.slice(0, 18)}` }),
    );

    const { pay } = await load();
    const first = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(first.status).toBe(202);
    expect(routeMocks.verify).toHaveBeenCalledOnce();
    expect(routeMocks.settle).toHaveBeenCalledOnce();
    expect(routeMocks.notify).not.toHaveBeenCalled();

    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'settled',
      txHash: TX_HASH,
    });
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      txHash: TX_HASH,
      orderRegistered: true,
    });
    expect(routeMocks.verify).toHaveBeenCalledOnce();
    expect(routeMocks.settle).toHaveBeenCalledOnce();
    expect(routeMocks.status).toHaveBeenCalledTimes(2);
    expect(routeMocks.notify).toHaveBeenCalledOnce();
    const paymentResponse = JSON.parse(
      Buffer.from(
        res.headers.get('x-payment-response') ?? '',
        'base64',
      ).toString('utf8'),
    );
    expect(paymentResponse).toEqual({
      success: true,
      transaction: TX_HASH,
      network: 'eip155:80002',
      payer: PAYER,
    });
  });

  it('settle pending が indeterminate の間は既存 202 を保ち受注しない', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    const pendingBody = {
      success: false,
      errorReason: 'pending',
      transaction: TX_HASH,
      payer: PAYER,
    };
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(pendingBody, { status: 202 }),
    );
    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'indeterminate',
    });

    const { pay } = await load();
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(pendingBody);
    expect(routeMocks.notify).not.toHaveBeenCalled();
  });

  it('初回 pending record があれば署名期限後の retry も verify を再実行せず回復する', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'indeterminate',
    });
    const { pay } = await load();
    const first = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(first.status).toBe(202);

    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: false, invalidReason: 'expired' }),
    );
    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'settled',
      txHash: TX_HASH,
    });
    routeMocks.notify.mockResolvedValue(
      NextResponse.json({ ok: true, orderId: `agent-${TX_HASH.slice(0, 18)}` }),
    );

    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      txHash: TX_HASH,
      orderRegistered: true,
    });
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
    expect(routeMocks.notify).toHaveBeenCalledOnce();
  });

  it('同じ署名を同額の別 cart/table/pickupAt へ再提示しても受注へ付け替えない', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'indeterminate',
    });
    const { pay } = await load();
    const pickupAt = '1800000000000';
    const originalQuery =
      `h=shop&cart=${CART}&table=A5&pickupAt=${pickupAt}`;
    expect(
      (
        await pay.GET(
          payReq(originalQuery, { 'X-PAYMENT': paymentHeader() }),
        )
      ).status,
    ).toBe(202);

    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    routeMocks.status.mockClear();
    const sameAmountCart = encodeAgentCart([
      { id: 'beer', qty: 1 },
      { id: 'karaage', qty: 2 },
    ]);
    for (const query of [
      `h=shop&cart=${sameAmountCart}&table=A5&pickupAt=${pickupAt}`,
      `h=shop&cart=${CART}&table=B6&pickupAt=${pickupAt}`,
      `h=shop&cart=${CART}&table=A5&pickupAt=1800000060000`,
    ]) {
      const res = await pay.GET(
        payReq(query, { 'X-PAYMENT': paymentHeader() }),
      );
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe('payment_invalid');
    }
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
    expect(routeMocks.status).not.toHaveBeenCalled();
    expect(routeMocks.notify).not.toHaveBeenCalled();
  });

  it('pending 後に menu/price/live が変わっても初回 snapshot の注文だけを回復する', async () => {
    shopLiveMocks.configured = true;
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'indeterminate',
    });
    routeMocks.notify.mockResolvedValue(NextResponse.json({ ok: true }));
    const { pay } = await load({ shopLive: '1' });
    const request = () =>
      payReq(`h=shop&cart=${CART}&table=A5`, {
        'X-PAYMENT': paymentHeader(),
      });
    expect((await pay.GET(request())).status).toBe(202);

    store.record = record({
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        acceptingOrders: false,
        menu: [
          { id: 'karaage', name: '値上げ後', price: '9999' },
          { id: 'beer', name: '販売終了', price: '9999' },
        ],
      },
    } as Partial<HandleRecord>);
    shopLiveMocks.kvGet.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ soldOut: ['beer'], paused: true, updatedAt: 2 }),
    });
    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'settled',
      txHash: TX_HASH,
    });

    const recovered = await pay.GET(request());
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ amountJpyc: '1600' });
    expect(shopLiveMocks.kvGet).toHaveBeenCalledOnce();
    const notifyReq = routeMocks.notify.mock.calls[0][0] as Request;
    const notifyBody = (await notifyReq.json()) as {
      items: Array<{ name: string; qty: number; price: string }>;
      description?: string;
    };
    expect(notifyBody.items).toEqual([
      { name: '唐揚げ', qty: 2, price: '500' },
      { name: 'ビール', qty: 1, price: '600' },
    ]);
    expect(notifyBody.description).toBe('A5');
    expect(routeMocks.verify).toHaveBeenCalledOnce();
    expect(routeMocks.settle).toHaveBeenCalledOnce();
  });

  it('matching record の context が壊れていれば status/notify 前に拒否する', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        { success: false, errorReason: 'pending', payer: PAYER },
        { status: 202 },
      ),
    );
    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'indeterminate',
    });
    const { pay } = await load();
    const request = () =>
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() });
    expect((await pay.GET(request())).status).toBe(202);

    const existing = redeliveryMocks.record!;
    const context = existing.context as Record<string, unknown>;
    const items = context.items as Array<Record<string, unknown>>;
    redeliveryMocks.record = {
      ...existing,
      context: {
        ...context,
        items: [{ ...items[0], price: '0' }, items[1]],
      },
    };
    routeMocks.status.mockClear();
    const rejected = await pay.GET(request());
    expect(rejected.status).toBe(402);
    expect((await rejected.json()).error).toBe('payment_invalid');
    expect(routeMocks.status).not.toHaveBeenCalled();
    expect(routeMocks.notify).not.toHaveBeenCalled();
  });

  it('内部 status recovery も共有 limiter 超過時は二重 settle せず pending を保つ', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    routeMocks.statusAllowed.mockResolvedValue(false);
    const { pay } = await load();
    const request = () =>
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() });

    expect((await pay.GET(request())).status).toBe(202);
    expect((await pay.GET(request())).status).toBe(202);
    expect(routeMocks.statusAllowed).toHaveBeenCalledTimes(2);
    expect(routeMocks.status).not.toHaveBeenCalled();
    expect(routeMocks.verify).toHaveBeenCalledOnce();
    expect(routeMocks.settle).toHaveBeenCalledOnce();
    expect(routeMocks.notify).not.toHaveBeenCalled();
  });

  it('redelivery KV unavailable は新規の従来 verify/settle 成功を止めない', async () => {
    redeliveryMocks.lookup.mockResolvedValue({ kind: 'unavailable' });
    redeliveryMocks.claim.mockResolvedValue({ kind: 'unavailable' });
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    routeMocks.notify.mockResolvedValue(NextResponse.json({ ok: true }));
    const { pay } = await load();
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(res.status).toBe(200);
    expect(routeMocks.verify).toHaveBeenCalledOnce();
    expect(routeMocks.settle).toHaveBeenCalledOnce();
    expect(routeMocks.status).not.toHaveBeenCalled();
  });

  it('canonical payment identity を作れない payload は verify 前に拒否する', async () => {
    redeliveryMocks.identity.mockReturnValue(null);
    const { pay } = await load();
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('invalid_payment_payload');
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('settle 成功後でも promotion CAS の明示 conflict では別注文を notify しない', async () => {
    redeliveryMocks.promote.mockResolvedValue({ kind: 'conflict' });
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { pay } = await load();
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('payment_invalid');
    expect(routeMocks.notify).not.toHaveBeenCalled();
  });

  it('settled でも txHash 不明なら空 hash で受注せず既存エラーを保つ', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: false, invalidReason: 'expired' }),
    );
    routeMocks.status.mockResolvedValue({
      ok: true,
      chainId: AMOY,
      payer: PAYER,
      state: 'settled',
      txHash: null,
    });

    const { pay } = await load();
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );

    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('expired');
    expect(routeMocks.settle).not.toHaveBeenCalled();
    expect(routeMocks.notify).not.toHaveBeenCalled();
  });

  it('verify が invalid → 402 で settle しない', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: false, invalidReason: 'signature_mismatch' }),
    );
    const { pay } = await load();
    const res = await pay.GET(
      payReq(`h=shop&cart=${CART}`, { 'X-PAYMENT': paymentHeader() }),
    );
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('signature_mismatch');
    expect(routeMocks.settle).not.toHaveBeenCalled();
    expect(routeMocks.notify).not.toHaveBeenCalled();
  });
});
