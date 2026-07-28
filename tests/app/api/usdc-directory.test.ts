// /api/paid/usdc/japan-web3-directory (vanilla x402・USDC/Base 直接販売) の検証。
//
// gate (lib/x402/vanillaGate) は x402-next を使わない自前実装なので、facilitator への
// fetch を mock して**支払いフロー全体**をフェンスする:
//   - dual-stack 402 (v1 JSON body + v2 PAYMENT-REQUIRED ヘッダ・x402scan の v1 拒否対策)
//   - verify → content → settle の順序と、content 5xx で settle しない買い手保護
//   - v2 payment の accepted 照合は CAIP-2、facilitator への body は v1 命名 'base'
//     (payai は CAIP-2 body を 500 で落とす実測に基づく)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verificationMocks = vi.hoisted(() => ({
  snapshot: {} as Record<
    string,
    { checkedAt: string; ok: boolean; sourceUrl: string }
  > | null,
}));

vi.mock('@/lib/directory/verification', () => ({
  readDirectoryVerificationSnapshot: async () => verificationMocks.snapshot,
}));

const SELLER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FACILITATOR = 'https://facilitator.payai.network';
const RESOURCE = 'https://open-pay.jp/api/paid/usdc/japan-web3-directory';

type Route = { GET: (req: Request) => Promise<Response> };

const fetchMock = vi.fn();

async function load(
  flags: { directory?: string; testMode?: string } = {},
): Promise<Route> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', flags.directory ?? '1');
  vi.stubEnv('X402_NETWORK', 'base');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.stubEnv('X402_FACILITATOR_URL', FACILITATOR);
  vi.stubEnv('X402_TEST_MODE', flags.testMode ?? '');
  vi.resetModules();
  return (await import(
    '@/app/api/paid/usdc/japan-web3-directory/route'
  )) as unknown as Route;
}

function req(headers: Record<string, string> = {}): Request {
  return new Request(RESOURCE, { headers });
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

const V1_PAYLOAD = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: `0x${'11'.repeat(65)}`,
    authorization: {
      from: '0x0000000000000000000000000000000000000001',
      to: SELLER,
      value: '20000',
      validAfter: '0',
      validBefore: '99999999999',
      nonce: `0x${'22'.repeat(32)}`,
    },
  },
};

function facilitatorOk(): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/verify')) {
      return new Response(
        JSON.stringify({ isValid: true, payer: '0x0000000000000000000000000000000000000001' }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        transaction: `0x${'ab'.repeat(32)}`,
        network: 'base',
        payer: '0x0000000000000000000000000000000000000001',
      }),
      { status: 200 },
    );
  });
}

beforeEach(() => {
  verificationMocks.snapshot = {};
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /api/paid/usdc/japan-web3-directory', () => {
  it('flag OFF → 404 (支払い要求より先に閉じる)', async () => {
    const route = await load({ directory: '' });
    expect((await route.GET(req())).status).toBe(404);
  });

  it('支払いなし → dual-stack 402: v1 body は base/USDC 単一 payTo、v2 ヘッダは CAIP-2', async () => {
    const route = await load();
    const res = await route.GET(req());
    expect(res.status).toBe(402);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as {
      x402Version: number;
      accepts: {
        network: string;
        asset: string;
        payTo: string;
        maxAmountRequired: string;
        resource: string;
        extra?: Record<string, unknown>;
      }[];
    };
    const accept = body.accepts[0];
    expect(accept.network).toBe('base');
    expect(accept.asset.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(accept.payTo).toBe(SELLER);
    expect(accept.maxAmountRequired).toBe('20000'); // $0.02・手数料上乗せなし
    expect(accept.resource).toBe(RESOURCE);
    expect(accept.extra?.openpay).toBeUndefined(); // vanilla = forwarder-split でない

    // v2 面 (x402scan はこちらを読む)
    const prHeader = res.headers.get('PAYMENT-REQUIRED');
    expect(prHeader).toBeTruthy();
    const v2 = JSON.parse(Buffer.from(prHeader!, 'base64').toString()) as {
      x402Version: number;
      resource: { url: string };
      accepts: { network: string; amount: string; asset: string }[];
    };
    expect(v2.x402Version).toBe(2);
    expect(v2.resource.url).toBe(RESOURCE);
    expect(v2.accepts[0].network).toBe('eip155:8453');
    expect(v2.accepts[0].amount).toBe('20000');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v1 payment: verify → content → settle の順で 200 + 決済応答ヘッダ両形式', async () => {
    facilitatorOk();
    const route = await load();
    const res = await route.GET(req({ 'x-payment': b64(V1_PAYLOAD) }));
    expect(res.status).toBe(200);

    // facilitator 呼び出し: verify → settle の 2 回・v1 命名 'base' の body
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`${FACILITATOR}/verify`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${FACILITATOR}/settle`);
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { paymentPayload: { network: string }; paymentRequirements: { network: string; payTo: string } };
    expect(sent.paymentPayload.network).toBe('base');
    expect(sent.paymentRequirements.network).toBe('base');
    expect(sent.paymentRequirements.payTo).toBe(SELLER);

    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.length).toBe(body.total);
    expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeTruthy();
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('v2 payment: accepted は CAIP-2 で照合し facilitator へは v1 命名で送る', async () => {
    facilitatorOk();
    const route = await load();
    // まず 402 から v2 accepts を取得し、クライアントが echo する形を作る
    const challenge = await route.GET(req());
    const pr = JSON.parse(
      Buffer.from(challenge.headers.get('PAYMENT-REQUIRED')!, 'base64').toString(),
    ) as { accepts: Record<string, unknown>[] };
    const v2Payment = {
      x402Version: 2,
      accepted: pr.accepts[0],
      payload: V1_PAYLOAD.payload,
    };
    const res = await route.GET(req({ 'PAYMENT-SIGNATURE': b64(v2Payment) }));
    expect(res.status).toBe(200);
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { paymentPayload: { network: string } };
    expect(sent.paymentPayload.network).toBe('base'); // CAIP-2 のまま送ると payai は 500
  });

  it('verify 不合格 → 402 + 理由。settle は呼ばれない', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ isValid: false, invalidReason: 'invalid_exact_evm_signature' }),
        { status: 200 },
      ),
    );
    const route = await load();
    const res = await route.GET(req({ 'x-payment': b64(V1_PAYLOAD) }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_exact_evm_signature');
    expect(fetchMock).toHaveBeenCalledTimes(1); // verify のみ
  });

  it('snapshot 不能 → 503。settle は呼ばれない (課金前に停止)', async () => {
    facilitatorOk();
    verificationMocks.snapshot = null;
    const route = await load();
    const res = await route.GET(req({ 'x-payment': b64(V1_PAYLOAD) }));
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1); // verify のみ・settle なし
    expect(fetchMock.mock.calls[0][0]).toBe(`${FACILITATOR}/verify`);
  });

  it('settle 失敗 → 402 (コンテンツは配らない)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/verify')) {
        return new Response(JSON.stringify({ isValid: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ success: false, errorReason: 'insufficient_funds' }),
        { status: 200 },
      );
    });
    const route = await load();
    const res = await route.GET(req({ 'x-payment': b64(V1_PAYLOAD) }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; items?: unknown };
    expect(body.error).toBe('insufficient_funds');
    expect(body.items).toBeUndefined();
  });

  it('facilitator 不通 → 503 (壊れた 402 を配らない・content へ進まない)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const route = await load();
    const res = await route.GET(req({ 'x-payment': b64(V1_PAYLOAD) }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('payment_facility_unavailable');
  });

  it('test mode → facilitator を呼ばず全件封筒', async () => {
    const route = await load({ testMode: 'true' });
    const res = await route.GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('usdPriceToAtomic (金額境界)', () => {
  it('厳密変換と設定ミス拒否', async () => {
    const { usdPriceToAtomic } = await import('@/lib/x402/vanillaGate');
    expect(usdPriceToAtomic('$0.02')).toBe('20000');
    expect(usdPriceToAtomic('$0.000001')).toBe('1'); // 最小単位
    expect(usdPriceToAtomic('$1')).toBe('1000000');
    expect(usdPriceToAtomic('0.5')).toBe('500000'); // $ なしも許容
    expect(usdPriceToAtomic('$100.25')).toBe('100250000');
    expect(() => usdPriceToAtomic('$0.0000001')).toThrow(); // 6 桁超
    expect(() => usdPriceToAtomic('')).toThrow();
    expect(() => usdPriceToAtomic('¥100')).toThrow();
    expect(() => usdPriceToAtomic('$1e3')).toThrow();
  });
});
