// /api/paid/usdc/japan-web3-directory (vanilla x402・USDC/Base 直接販売) の検証。
//
// x402-next は jsdom で実行できないため mock し (tests/app/api/paid-hello.test.ts と同じ方針)、
// ここでは「route が withX402 に渡す契約」をフェンスする:
//   - flag OFF → 404 (支払い要求より先に閉じる)
//   - withX402 への price/payTo/facilitator URL の配線 (= 402 の accepts を決める入力)
//   - test mode: snapshot あり → 全件封筒 + no-store / snapshot 不能 → 503
//     (x402-next は status>=400 で settle しない = 課金されない)
// 実 402 の wire 形 (Base mainnet USDC・単一 payTo・extra.openpay 無し) は本番で実測検証する。

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

vi.mock('x402-next', () => ({
  withX402: vi.fn(
    () => async () =>
      new Response(JSON.stringify({ x402Version: 1, error: 'payment_required' }), {
        status: 402,
      }),
  ),
}));

import { withX402 } from 'x402-next';

const SELLER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

type Route = { GET: (req: Request) => Promise<Response> };

async function load(
  flags: { directory?: string; testMode?: string } = {},
): Promise<Route> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', flags.directory ?? '1');
  vi.stubEnv('X402_NETWORK', 'base');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.stubEnv('X402_FACILITATOR_URL', 'https://facilitator.payai.network');
  vi.stubEnv('X402_TEST_MODE', flags.testMode ?? '');
  vi.resetModules();
  return (await import(
    '@/app/api/paid/usdc/japan-web3-directory/route'
  )) as unknown as Route;
}

function req(): Request {
  return new Request('https://open-pay.jp/api/paid/usdc/japan-web3-directory');
}

beforeEach(() => {
  verificationMocks.snapshot = {};
  vi.mocked(withX402).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /api/paid/usdc/japan-web3-directory', () => {
  it('flag OFF → 404 (支払い要求より先に閉じる)', async () => {
    const route = await load({ directory: '' });
    const res = await route.GET(req());
    expect(res.status).toBe(404);
  });

  it('withX402 への配線: price $0.02・network base・payTo・外部 facilitator URL', async () => {
    const route = await load();
    const res = await route.GET(req());
    expect(res.status).toBe(402);
    expect(withX402).toHaveBeenCalledTimes(1);
    const [, payTo, routeConfig, facilitator] = vi.mocked(withX402).mock
      .calls[0] as unknown as [
      unknown,
      string,
      { price: string; network: string; config: { description: string } },
      { url: string },
    ];
    expect(payTo).toBe(SELLER);
    // $0.02 固定。JPYC 版と違い手数料上乗せの計算が「存在しない」ことが契約。
    expect(routeConfig.price).toBe('$0.02');
    expect(routeConfig.network).toBe('base');
    expect(routeConfig.config.description).toContain('Japan Web3 Directory');
    expect(facilitator.url).toBe('https://facilitator.payai.network');
  });

  it('test mode: snapshot あり → 全件封筒 + no-store', async () => {
    const route = await load({ testMode: 'true' });
    const res = await route.GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      items: unknown[];
      total: number;
      licenseNotice: string;
    };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.length).toBe(body.total);
    expect(typeof body.licenseNotice).toBe('string');
  });

  it('test mode: snapshot 不能 → 503 (settle 前に止まる = 課金なし)', async () => {
    verificationMocks.snapshot = null;
    const route = await load({ testMode: 'true' });
    const res = await route.GET(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('storage_unavailable');
  });
});
