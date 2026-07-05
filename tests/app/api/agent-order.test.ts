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

const routeMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  settle: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('@/app/api/facilitator/verify/route', () => ({ POST: routeMocks.verify }));
vi.mock('@/app/api/facilitator/settle/route', () => ({ POST: routeMocks.settle }));
vi.mock('@/app/api/order/notify/route', () => ({ POST: routeMocks.notify }));

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

async function load(
  flags: { facilitator?: string; relay?: string; agent?: string } = {},
): Promise<{ menu: MenuRoute; pay: PayRoute }> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', flags.facilitator ?? '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', flags.relay ?? '1');
  vi.stubEnv('ENABLE_AGENT_ORDER', flags.agent ?? '1');
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
  vi.resetModules();
  const menu = (await import('@/app/api/agent-order/menu/route')) as MenuRoute;
  const pay = (await import('@/app/api/agent-order/pay/route')) as PayRoute;
  return { menu, pay };
}

function menuReq(query: string): Request {
  return new Request(`https://open-pay.jp/api/agent-order/menu?${query}`);
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
      signature: `0x${'11'.repeat(65)}`,
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
  routeMocks.verify.mockReset();
  routeMocks.settle.mockReset();
  routeMocks.notify.mockReset();
});

afterEach(() => {
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
      const { menu, pay } = await load(flags);
      expect((await menu.GET(menuReq('h=shop'))).status).toBe(404);
      expect((await pay.GET(payReq(`h=shop&cart=${CART}`))).status).toBe(404);
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
      items: Array<{ id: string; name: string; price: string; hasOptions: boolean }>;
    };
    expect(body).toMatchObject({
      handle: 'shop',
      shopName: '居酒屋テスト',
      mode: 'storefront',
      chain: 'polygon',
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
