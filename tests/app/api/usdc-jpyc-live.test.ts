// /api/paid/usdc/jpyc/{supply,balance,transfers} (vanilla x402・USDC/Base) の route 検証。
// RPC 層 (lib/jpyc/live) は mock し、route の責務だけをフェンスする:
//   - query 不正は支払い要求より先に 400 (署名だけさせない)
//   - dual-stack 402 + Bazaar 宣言 (queryParams と enum = JPYC_CHAINS)
//   - 支払い OK → content → settle。全チェーン RPC 失敗は 503 で settle しない (買い手保護)
//   - 応答 envelope に notice (助言でない旨) が必ず載る

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const liveMocks = vi.hoisted(() => ({
  readSupply: vi.fn(),
  readBalance: vi.fn(),
  readTransfers: vi.fn(),
}));

vi.mock('@/lib/jpyc/live', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpyc/live')>('@/lib/jpyc/live');
  return {
    ...actual,
    readSupply: liveMocks.readSupply,
    readBalance: liveMocks.readBalance,
    readTransfers: liveMocks.readTransfers,
  };
});

import { JPYC_CHAINS } from '@/lib/chains';

const SELLER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const FACILITATOR = 'https://facilitator.payai.network';
const ORIGIN = 'https://open-pay.jp';
const ADDR = '0x9A76ea8Fc0b9f34D34b91d453F2940932C9a7FE0';

type Route = { GET: (req: Request) => Promise<Response> };
const fetchMock = vi.fn();

async function load(name: 'supply' | 'balance' | 'transfers'): Promise<Route> {
  vi.stubEnv('X402_NETWORK', 'base');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.stubEnv('X402_FACILITATOR_URL', FACILITATOR);
  vi.stubEnv('X402_TEST_MODE', '');
  vi.resetModules();
  return (await import(`@/app/api/paid/usdc/jpyc/${name}/route`)) as unknown as Route;
}

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers });
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function v1Payment(value: string) {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: `0x${'11'.repeat(65)}`,
      authorization: {
        from: ADDR,
        to: SELLER,
        value,
        validAfter: '0',
        validBefore: '99999999999',
        nonce: `0x${'22'.repeat(32)}`,
      },
    },
  };
}

function facilitatorOk(): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/verify')) {
      return new Response(JSON.stringify({ isValid: true, payer: ADDR }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'base', payer: ADDR }),
      { status: 200 },
    );
  });
}

const okSupplyRow = {
  chain: JPYC_CHAINS[0],
  chainId: 1,
  contract: SELLER,
  status: 'ok' as const,
  blockNumber: '1',
  totalSupply: '1',
  totalSupplyFormatted: '0.000000000000000001',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  liveMocks.readSupply.mockReset();
  liveMocks.readBalance.mockReset();
  liveMocks.readTransfers.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('query 検証は支払い要求より先 (400・facilitator 不呼出)', () => {
  it('supply: 未知の chain / 未知のキー', async () => {
    const route = await load('supply');
    expect((await route.GET(req('/api/paid/usdc/jpyc/supply?chain=solana'))).status).toBe(400);
    expect((await route.GET(req('/api/paid/usdc/jpyc/supply?foo=1'))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('balance: address 不正は 400・**欠落は 402** (CDP クローラは引数なしで 402 を検査する)', async () => {
    const route = await load('balance');
    expect((await route.GET(req('/api/paid/usdc/jpyc/balance?address=0x12'))).status).toBe(400);
    const bare = await route.GET(req('/api/paid/usdc/jpyc/balance'));
    expect(bare.status).toBe(402);
    expect(bare.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
  });

  it('transfers: limit 0 / address 不正は 400・chain 欠落は 402', async () => {
    const route = await load('transfers');
    expect((await route.GET(req('/api/paid/usdc/jpyc/transfers?chain=polygon&limit=0'))).status).toBe(400);
    expect((await route.GET(req('/api/paid/usdc/jpyc/transfers?chain=polygon&address=zz'))).status).toBe(400);
    expect((await route.GET(req('/api/paid/usdc/jpyc/transfers'))).status).toBe(402);
  });

  it('支払い付きでも必須引数が無ければ 400 で settle しない (verify のみ・課金なし)', async () => {
    facilitatorOk();
    const balance = await load('balance');
    const res = await balance.GET(req('/api/paid/usdc/jpyc/balance', { 'x-payment': b64(v1Payment('2000')) }));
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/verify$/);
    expect(liveMocks.readBalance).not.toHaveBeenCalled();

    fetchMock.mockClear();
    const transfers = await load('transfers');
    const res2 = await transfers.GET(req('/api/paid/usdc/jpyc/transfers', { 'x-payment': b64(v1Payment('5000')) }));
    expect(res2.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(liveMocks.readTransfers).not.toHaveBeenCalled();
  });
});

describe('402 dual-stack と Bazaar 宣言', () => {
  it('supply: v1 body は base/USDC $0.002、v2 ヘッダに queryParams.chain と enum=JPYC_CHAINS', async () => {
    const route = await load('supply');
    const res = await route.GET(req('/api/paid/usdc/jpyc/supply'));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: { network: string; maxAmountRequired: string; resource: string }[] };
    expect(body.accepts[0].network).toBe('base');
    expect(body.accepts[0].maxAmountRequired).toBe('2000');
    expect(body.accepts[0].resource).toBe(`${ORIGIN}/api/paid/usdc/jpyc/supply`);

    const v2 = JSON.parse(Buffer.from(res.headers.get('PAYMENT-REQUIRED')!, 'base64').toString()) as {
      accepts: { amount: string; network: string }[];
      extensions: {
        bazaar: {
          info: { input: { queryParams: Record<string, string> }; output: { type: string } };
          schema: { properties: { input: { properties: { queryParams: { properties: { chain: { enum: string[] } } } } } } };
        };
      };
    };
    expect(v2.accepts[0].amount).toBe('2000');
    expect(v2.accepts[0].network).toBe('eip155:8453');
    // 検索・カード表示用メタ (CDP 拡張) が 402 の resource に載る
    const resource = (v2 as unknown as { resource: { serviceName: string; tags: string[]; iconUrl: string } }).resource;
    expect(resource.serviceName).toBe('JPYC Supply by Chain');
    expect(resource.tags).toContain('japanese-yen');
    expect(resource.iconUrl).toBe('https://open-pay.jp/icon-512.png');
    expect(v2.extensions.bazaar.info.input.queryParams).toEqual({ chain: 'polygon' });
    expect(v2.extensions.bazaar.info.output.type).toBe('json');
    expect(v2.extensions.bazaar.schema.properties.input.properties.queryParams.properties.chain.enum).toEqual([
      ...JPYC_CHAINS,
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('transfers: $0.005・chain は required', async () => {
    const route = await load('transfers');
    const res = await route.GET(req('/api/paid/usdc/jpyc/transfers?chain=polygon'));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: { maxAmountRequired: string }[] };
    expect(body.accepts[0].maxAmountRequired).toBe('5000');
    const v2 = JSON.parse(Buffer.from(res.headers.get('PAYMENT-REQUIRED')!, 'base64').toString()) as {
      extensions: { bazaar: { schema: { properties: { input: { properties: { queryParams: { required: string[] } } } } } } };
    };
    expect(v2.extensions.bazaar.schema.properties.input.properties.queryParams.required).toEqual(['chain']);
  });
});

describe('支払い後の content と買い手保護', () => {
  it('supply: verify → content → settle、envelope に notice と items', async () => {
    facilitatorOk();
    liveMocks.readSupply.mockResolvedValue([okSupplyRow]);
    const route = await load('supply');
    const res = await route.GET(
      req('/api/paid/usdc/jpyc/supply?chain=polygon', { 'x-payment': b64(v1Payment('2000')) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schemaVersion: string;
      notice: string;
      termsUrl: string;
      items: unknown[];
      token: { symbol: string };
    };
    expect(body.schemaVersion).toBe('2.0');
    expect(body.token.symbol).toBe('JPYC');
    expect(body.items).toHaveLength(1);
    // notice は短いコード + 規約 URL (全文は OpenAPI/Schema の description・反復購入のトークン節約)
    expect(body.notice).toBe('onchain-facts-only');
    expect(body.termsUrl).toBe('https://open-pay.jp/en/terms');
    expect(liveMocks.readSupply).toHaveBeenCalledWith(['polygon']);
    expect(fetchMock).toHaveBeenCalledTimes(2); // verify + settle
    expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('balance: address と chain 省略 (=全チェーン) を lib に渡す', async () => {
    facilitatorOk();
    liveMocks.readBalance.mockResolvedValue([{ ...okSupplyRow, balance: '1', balanceFormatted: '1' }]);
    const route = await load('balance');
    const res = await route.GET(
      req(`/api/paid/usdc/jpyc/balance?address=${ADDR}`, { 'x-payment': b64(v1Payment('2000')) }),
    );
    expect(res.status).toBe(200);
    expect(liveMocks.readBalance).toHaveBeenCalledWith(ADDR, [...JPYC_CHAINS]);
    const body = (await res.json()) as { address: string };
    expect(body.address).toBe(ADDR);
  });

  it('全チェーン RPC 失敗 → 503 で settle しない (課金されない)', async () => {
    facilitatorOk();
    liveMocks.readSupply.mockResolvedValue([{ ...okSupplyRow, status: 'unavailable', errorCode: 'rpc_unavailable', retryable: true }]);
    const route = await load('supply');
    const res = await route.GET(req('/api/paid/usdc/jpyc/supply', { 'x-payment': b64(v1Payment('2000')) }));
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1); // verify のみ
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/verify$/);
  });

  it('1 チェーンだけ失敗は 200 (部分成功・その行に error)', async () => {
    facilitatorOk();
    liveMocks.readSupply.mockResolvedValue([okSupplyRow, { ...okSupplyRow, chain: 'kaia', status: 'unavailable', errorCode: 'rpc_unavailable', retryable: true }]);
    const route = await load('supply');
    const res = await route.GET(req('/api/paid/usdc/jpyc/supply', { 'x-payment': b64(v1Payment('2000')) }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('transfers: status=error は 503・ok は status を剥がして envelope に展開', async () => {
    facilitatorOk();
    const route = await load('transfers');
    liveMocks.readTransfers.mockResolvedValueOnce({ chain: 'polygon', chainId: 137, contract: SELLER, status: 'unavailable', errorCode: 'rpc_unavailable', retryable: true });
    expect(
      (await route.GET(req('/api/paid/usdc/jpyc/transfers?chain=polygon', { 'x-payment': b64(v1Payment('5000')) }))).status,
    ).toBe(503);
    liveMocks.readTransfers.mockResolvedValueOnce({
      chain: 'polygon', chainId: 137, contract: SELLER, status: 'ok', fromBlock: '1', toBlock: '2', items: [],
    });
    const res = await route.GET(
      req(`/api/paid/usdc/jpyc/transfers?chain=polygon&limit=5&address=${ADDR}`, { 'x-payment': b64(v1Payment('5000')) }),
    );
    expect(res.status).toBe(200);
    expect(liveMocks.readTransfers).toHaveBeenLastCalledWith('polygon', { limit: 5, address: ADDR });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBeUndefined();
    expect(body.items).toEqual([]);
    expect(body.toBlock).toBe('2');
  });
});
