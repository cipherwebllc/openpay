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
      '/api/paid/jpyc/services',
      '/api/paid/stablecoin-payments',
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
    // JPYC ライブ API は operationId (動詞始まり・不変) と x-agent-usage (購入ルール) を持ち、
    // summary に決済レール (USDC/Base/価格) を混ぜない (x-payment-info の担当)。
    const agentReady: [string, string][] = [
      ['/api/paid/usdc/jpyc/supply', 'getJpycSupply'],
      ['/api/paid/usdc/jpyc/balance', 'getJpycBalance'],
      ['/api/paid/usdc/jpyc/transfers', 'listRecentJpycTransfers'],
    ];
    for (const [path, opId] of agentReady) {
      const op = body.paths[path]?.get as Record<string, unknown> | undefined;
      expect(op?.operationId, path).toBe(opId);
      const usage = op?.['x-agent-usage'] as { callWhen: string[]; repeatWhen: string[]; avoidWhen: string[] };
      expect(usage.callWhen.length, path).toBeGreaterThan(0);
      expect(usage.repeatWhen.length, path).toBeGreaterThan(0);
      expect(usage.avoidWhen.length, path).toBeGreaterThan(0);
      expect(String(op?.summary)).not.toMatch(/USDC|Base|\$/);
    }
    const priced: [string, string][] = [
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

  it('E7: JPYC ライブ API の chain enum は lib/chains.ts の JPYC_CHAINS と完全一致する (SoT からの導出)', async () => {
    const body = await doc();
    const { JPYC_CHAINS } = await import('@/lib/chains');
    for (const path of [
      '/api/paid/usdc/jpyc/supply',
      '/api/paid/usdc/jpyc/balance',
      '/api/paid/usdc/jpyc/transfers',
    ]) {
      const params = body.paths[path]?.get?.parameters as
        | Array<{ name: string; schema?: { enum?: string[] } }>
        | undefined;
      const chainParam = params?.find((p) => p.name === 'chain');
      expect(chainParam?.schema?.enum, path).toEqual([...JPYC_CHAINS]);
    }
  });

  // E6: 掲載条件は route の 404 条件と一致させる。
  //   - JPYC レール 2 本: guardPaidDirectoryApi = directory **かつ** facilitator
  //   - USDC レール 2 本 + 無料 teaser 2 本: 各 route の directory チェックのみ
  // ずれると、実際には 404 する有料エンドポイントをインデクサに広告してしまう。
  const JPYC_RAIL_MONITOR_PATHS = ['/api/paid/jpyc/services', '/api/paid/stablecoin-payments'];
  const DIRECTORY_ONLY_MONITOR_PATHS = [
    '/api/paid/usdc/jpyc/services',
    '/api/paid/usdc/stablecoin-payments',
    '/api/jpyc/services/teaser',
    '/api/stablecoin-payments/teaser',
  ];

  /** 文書自体が消える構成 (directory も facilitator も OFF) では null を返す。 */
  async function monitorDoc(directory: boolean, facilitator: boolean): Promise<Doc | null> {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', directory ? '1' : '');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', facilitator ? '1' : '');
    // 全機能 OFF は 404 になるため、文書自体は常に存在させる (shops は Monitor と無関係)。
    vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', '1');
    vi.stubEnv('ENABLE_AGENT_ORDER', '1');
    vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
    vi.resetModules();
    const mod = (await import('@/app/openapi.json/route')) as { GET: () => Promise<Response> };
    const res = await mod.GET();
    // shops は facilitator にも依存する (lib/shops/flags.ts) ため、両 OFF は文書ごと 404。
    if (!directory && !facilitator) {
      expect(res.status).toBe(404);
      return null;
    }
    expect(res.status, `directory=${directory} facilitator=${facilitator}`).toBe(200);
    return (await res.json()) as Doc;
  }

  it('E6: Monitor 6 本の掲載は directory × facilitator の 2×2 で route の 404 条件と一致する', async () => {
    for (const [directory, facilitator, jpycRail] of [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ] as const) {
      const body = await monitorDoc(directory, facilitator);
      const label = `directory=${directory} facilitator=${facilitator}`;
      if (body === null) continue; // 文書ごと 404 = 6 本とも広告されない

      for (const path of JPYC_RAIL_MONITOR_PATHS) {
        if (jpycRail) expect(body.paths[path], `${label}: ${path}`).toBeDefined();
        else expect(body.paths[path], `${label}: ${path}`).toBeUndefined();
      }
      for (const path of DIRECTORY_ONLY_MONITOR_PATHS) {
        if (directory) expect(body.paths[path], `${label}: ${path}`).toBeDefined();
        else expect(body.paths[path], `${label}: ${path}`).toBeUndefined();
      }
      // 常設面 (JPYC ライブデータ・stores) はどちらの flag にも依存しない。
      expect(body.paths['/api/paid/usdc/jpyc/supply'], label).toBeDefined();
      expect(body.paths['/api/paid/usdc/stores'], label).toBeDefined();
    }
  });

  it('E16: x-price-jpyc は literal ではなくカタログ価格 (SoT) と一致する', async () => {
    const body = await doc();
    const { DIRECTORY_LIST_RESOURCE, DIRECTORY_SEARCH_RESOURCE, DIRECTORY_DETAIL_PRICE_JPYC } =
      await import('@/lib/directory/paidResources');
    const { JPYC_SHOPS_SEARCH_RESOURCE } = await import('@/lib/shops/paidResources');
    const expectedPriceByPath: Record<string, string> = {
      '/api/paid/japan-web3-directory': DIRECTORY_LIST_RESOURCE.priceJpyc,
      '/api/paid/japan-web3-directory/search': DIRECTORY_SEARCH_RESOURCE.priceJpyc,
      '/api/paid/japan-web3-directory/{slug}': DIRECTORY_DETAIL_PRICE_JPYC,
      '/api/paid/jpyc-shops/search': JPYC_SHOPS_SEARCH_RESOURCE.priceJpyc,
    };
    let checked = 0;
    for (const [path, methods] of Object.entries(body.paths)) {
      const price = methods.get?.['x-price-jpyc'];
      if (price === undefined) continue;
      expect(expectedPriceByPath, `${path} に期待値が未登録 (テストの網羅漏れ)`).toHaveProperty(path);
      expect(price, path).toBe(Number(expectedPriceByPath[path]));
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(Object.keys(expectedPriceByPath).length);
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
