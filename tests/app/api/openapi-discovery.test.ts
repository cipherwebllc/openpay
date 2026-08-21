// origin 直下の /openapi.json が x402 インデクサに発見される条件を固定するフェンス。
//
// x402scan / @agentcash/discovery は `${origin}/openapi.json` **だけ**を discovery
// ドキュメントとして読み、各 operation の `x-payment-info` の有無で「有料エンドポイント」
// (authMode='paid') を判定する。旧 /.well-known/x402 は legacy 扱いで既にパースされない。
// つまり **パスを /api 配下に戻す・x-payment-info を落とす** のどちらでも掲載が静かに消える
// が、typecheck も既存テストも通ってしまうため、ここで機械的に固定する。

import { afterEach, describe, expect, it, vi } from 'vitest';

const SELLER = '0x00000000000000000000000000000000000000A1';

type Doc = {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

async function load(): Promise<{ root: () => Promise<Response>; api: () => Promise<Response> }> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '1');
  // 5 本すべて (demo/stores/directory 一覧・検索/shops 検索) を網羅するため全 flag ON。
  vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', '1');
  vi.stubEnv('ENABLE_AGENT_ORDER', '1');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  // hello (vanilla demo) の掲載価格を決定的にする
  vi.stubEnv('X402_PRICE', '$0.01');
  vi.resetModules();
  const root = (await import('@/app/openapi.json/route')) as { GET: () => Promise<Response> };
  const api = (await import('@/app/api/openapi.json/route')) as { GET: () => Promise<Response> };
  return { root: root.GET, api: api.GET };
}

async function doc(): Promise<Doc> {
  const { root } = await load();
  const res = await root();
  expect(res.status).toBe(200);
  return (await res.json()) as Doc;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /openapi.json (x402 インデクサ向け discovery)', () => {
  it('origin 直下で配信され servers が canonical origin を指す', async () => {
    const body = await doc();
    expect(body.openapi).toBe('3.1.0');
    expect(body.servers[0]?.url).toBe('https://open-pay.jp');
  });

  it('/api/openapi.json と同一文書 (docsUrl の互換を壊さない)', async () => {
    const { root, api } = await load();
    expect(await (await root()).json()).toEqual(await (await api()).json());
  });

  it('カタログ掲載中の有料リソースは全て x-payment-info を持つ', async () => {
    // ⚠️ import は doc() の後に行う。doc() が flag を stub して resetModules するため、
    //    先に import するとカタログが flag OFF 版 (2 件) で固まり、ループが素通りする。
    const body = await doc();
    const { FIRST_PARTY_RESOURCES } = await import('@/lib/x402/firstParty');
    // flag の stub 漏れでカタログが縮んだまま「全件 OK」になるのを防ぐ。
    expect(FIRST_PARTY_RESOURCES.map((r) => r.path)).toEqual([
      '/api/paid/demo',
      '/api/paid/stores',
      '/api/paid/japan-web3-directory',
      '/api/paid/japan-web3-directory/search',
      '/api/paid/jpyc-shops/search',
    ]);
    for (const resource of FIRST_PARTY_RESOURCES) {
      const op = body.paths[resource.path]?.get;
      expect(op, `${resource.path} が openapi.json に無い`).toBeDefined();
      expect(
        op?.['x-payment-info'],
        `${resource.path} に x-payment-info が無い (= 有料として登録されない)`,
      ).toBeDefined();
    }
  });

  it('x-payment-info の金額は 402 チャレンジの総額 (資源価格 + 買い手上乗せ手数料) と一致', async () => {
    const body = await doc();
    const { FIRST_PARTY_RESOURCES, firstPartyAmount } = await import('@/lib/x402/firstParty');
    const { x402FeeBreakdown } = await import('@/lib/x402/fee');
    for (const resource of FIRST_PARTY_RESOURCES) {
      const info = body.paths[resource.path]?.get?.['x-payment-info'] as {
        price: { currency: string; mode: string; amount: string };
        protocols: { x402?: Record<string, unknown> }[];
      };
      const { total } = x402FeeBreakdown(firstPartyAmount(resource));
      expect(info.price.currency).toBe('JPY');
      expect(info.price.mode).toBe('fixed');
      expect(BigInt(Math.round(Number(info.price.amount) * 1e6)) * 10n ** 12n).toBe(total);
      expect(info.protocols[0]?.x402).toBeDefined();
    }
  });

  it('USDC 版 Directory (vanilla x402) は USD 建て x-payment-info を持つ', async () => {
    const body = await doc();
    const op = body.paths['/api/paid/usdc/japan-web3-directory']?.get;
    expect(op).toBeDefined();
    const info = op?.['x-payment-info'] as {
      price: { currency: string; mode: string; amount: string };
      protocols: { x402?: { network?: string; asset?: string } }[];
    };
    expect(info.price).toEqual({ currency: 'USD', mode: 'fixed', amount: '0.02' });
    expect(info.protocols[0]?.x402?.network).toBe('eip155:8453');
    expect(info.protocols[0]?.x402?.asset).toBe('USDC');
    // route 実装と同じ価格か (SoT = USDC_DIRECTORY_LIST)
    const { USDC_DIRECTORY_LIST } = await import('@/lib/directory/usdcResource');
    expect(`$${info.price.amount}`).toBe(USDC_DIRECTORY_LIST.price);
  });

  it('vanilla USDC 追加分 (search / stores / hello) も USD 建て x-payment-info を持つ', async () => {
    const body = await doc();
    const expected: [string, string][] = [
      ['/api/paid/usdc/japan-web3-directory/search', '0.02'],
      ['/api/paid/usdc/stores', '0.04'],
      ['/api/paid/usdc/jpyc/supply', '0.002'],
      ['/api/paid/usdc/jpyc/balance', '0.002'],
      ['/api/paid/usdc/jpyc/transfers', '0.005'],
      ['/api/paid/hello', '0.01'], // X402_PRICE stub に一致
    ];
    for (const [path, amount] of expected) {
      const op = body.paths[path]?.get;
      expect(op, `${path} が openapi.json に無い`).toBeDefined();
      const info = op?.['x-payment-info'] as {
        price: { currency: string; amount: string };
        protocols: { x402?: { network?: string } }[];
      };
      expect(info.price.currency).toBe('USD');
      expect(info.price.amount).toBe(amount);
      expect(info.protocols[0]?.x402?.network).toBe('eip155:8453');
    }
  });

  it('slug テンプレート path は有料登録しない (probe が必ず 404 になるため)', async () => {
    const body = await doc();
    const templated = body.paths['/api/paid/japan-web3-directory/{slug}']?.get;
    expect(templated).toBeDefined();
    expect(templated?.['x-payment-info']).toBeUndefined();
  });

  it('全機能 OFF は 404 (完全 inert)', async () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', '');
    vi.resetModules();
    const mod = (await import('@/app/openapi.json/route')) as { GET: () => Promise<Response> };
    expect((await mod.GET()).status).toBe(404);
  });
});
