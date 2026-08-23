// /api/paid/usdc/jpyc/* の応答 Schema (lib/jpyc/liveSchema.ts) の契約フェンス (2026-08-23 裁定 P1)。
//   - Bazaar/OpenAPI に公開する example が自分の Schema に適合する (ドリフト検出)
//   - route が実際に返す envelope が Schema に適合する (additionalProperties:false なので、応答に
//     キーを足したら Schema を先に直さないとここで落ちる)
//   - partial success (unavailable 行) と、旧形 (status:'error'・生メッセージ) の拒否

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';

const liveMocks = vi.hoisted(() => ({
  readSupply: vi.fn(),
  readBalance: vi.fn(),
  readTransfers: vi.fn(),
}));
vi.mock('@/lib/jpyc/live', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpyc/live')>('@/lib/jpyc/live');
  return { ...actual, readSupply: liveMocks.readSupply, readBalance: liveMocks.readBalance, readTransfers: liveMocks.readTransfers };
});

import {
  JPYC_BALANCE_RESPONSE_SCHEMA,
  JPYC_SUPPLY_RESPONSE_SCHEMA,
  JPYC_TRANSFERS_RESPONSE_SCHEMA,
} from '@/lib/jpyc/liveSchema';
import { USDC_JPYC_BALANCE, USDC_JPYC_SUPPLY, USDC_JPYC_TRANSFERS } from '@/lib/jpyc/liveResources';

// format (date-time / uri) は ajv-formats 無しでは検証できないため外す (依存は ajv のみ・掟 16)。
// 実質的な制約は pattern (数字列・アドレス・tx hash) が担う。
function ajv() {
  return new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
}
const validateSupply = ajv().compile(JPYC_SUPPLY_RESPONSE_SCHEMA);
const validateBalance = ajv().compile(JPYC_BALANCE_RESPONSE_SCHEMA);
const validateTransfers = ajv().compile(JPYC_TRANSFERS_RESPONSE_SCHEMA);

const CONTRACT = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const ADDR = '0x9A76ea8Fc0b9f34D34b91d453F2940932C9a7FE0';
const SELLER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

describe('example は自分の Schema に適合する', () => {
  it('supply / balance / transfers', () => {
    expect(validateSupply(USDC_JPYC_SUPPLY.bazaar.output.example), JSON.stringify(validateSupply.errors)).toBe(true);
    expect(validateBalance(USDC_JPYC_BALANCE.bazaar.output.example), JSON.stringify(validateBalance.errors)).toBe(true);
    expect(validateTransfers(USDC_JPYC_TRANSFERS.bazaar.output.example), JSON.stringify(validateTransfers.errors)).toBe(true);
  });

  it('Bazaar 宣言の output.schema は応答 Schema そのもの', () => {
    expect(USDC_JPYC_SUPPLY.bazaar.output.schema).toBe(JPYC_SUPPLY_RESPONSE_SCHEMA);
    expect(USDC_JPYC_BALANCE.bazaar.output.schema).toBe(JPYC_BALANCE_RESPONSE_SCHEMA);
    expect(USDC_JPYC_TRANSFERS.bazaar.output.schema).toBe(JPYC_TRANSFERS_RESPONSE_SCHEMA);
  });
});

describe('partial success と旧形の拒否', () => {
  const base = {
    schemaVersion: '2.2',
    token: { symbol: 'JPYC', decimals: 18 },
    generatedAt: '2026-08-23T00:00:00.000Z',
    notice: 'onchain-facts-only',
    termsUrl: 'https://open-pay.jp/en/terms',
  };
  const okRow = { chain: 'polygon', chainId: 137, contract: CONTRACT, status: 'ok', blockNumber: '1', totalSupply: '1', totalSupplyFormatted: '0.000000000000000001' };

  it('unavailable 行は errorCode + retryable が必須で、ok 行と混在できる', () => {
    const unavailable = { chain: 'kaia', chainId: 8217, contract: CONTRACT, status: 'unavailable', errorCode: 'rpc_unavailable', retryable: true };
    expect(validateSupply({ ...base, items: [okRow, unavailable] })).toBe(true);
    const { retryable: _r, ...missing } = unavailable;
    expect(validateSupply({ ...base, items: [missing] })).toBe(false);
  });

  it("旧形 status:'error' と生のエラー文字列は拒否される", () => {
    expect(validateSupply({ ...base, items: [{ chain: 'polygon', chainId: 137, contract: CONTRACT, status: 'error', error: 'boom' }] })).toBe(false);
  });

  it('未知のキー・非数字の金額・不正アドレスは拒否される (additionalProperties:false / pattern)', () => {
    expect(validateSupply({ ...base, items: [okRow], extra: 1 })).toBe(false);
    expect(validateSupply({ ...base, items: [{ ...okRow, totalSupply: '1e18' }] })).toBe(false);
    expect(validateSupply({ ...base, items: [{ ...okRow, contract: '0x12' }] })).toBe(false);
    expect(validateSupply({ ...base, items: [{ ...okRow, note: 'x' }] })).toBe(false);
  });
});

describe('route の実応答が Schema に適合する', () => {
  type Route = { GET: (req: Request) => Promise<Response> };
  const fetchMock = vi.fn();

  async function load(name: 'supply' | 'balance' | 'transfers'): Promise<Route> {
    vi.stubEnv('X402_NETWORK', 'base');
    vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
    vi.stubEnv('X402_FACILITATOR_URL', 'https://facilitator.payai.network');
    vi.stubEnv('X402_TEST_MODE', 'true'); // testMode: 支払いなしで content を返す (Schema 検証が目的)
    vi.resetModules();
    return (await import(`@/app/api/paid/usdc/jpyc/${name}/route`)) as unknown as Route;
  }

  beforeEach(() => {
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

  it('supply (ok + unavailable の混在)', async () => {
    liveMocks.readSupply.mockResolvedValue([
      { chain: 'polygon', chainId: 137, contract: CONTRACT, status: 'ok', blockNumber: '92387745', totalSupply: '5000000000000000000', totalSupplyFormatted: '5' },
      { chain: 'kaia', chainId: 8217, contract: CONTRACT, status: 'unavailable', errorCode: 'contract_read_failed', retryable: false },
    ]);
    const route = await load('supply');
    const res = await route.GET(new Request('https://open-pay.jp/api/paid/usdc/jpyc/supply'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateSupply(body), JSON.stringify(validateSupply.errors)).toBe(true);
  });

  it('balance', async () => {
    liveMocks.readBalance.mockResolvedValue([
      { chain: 'polygon', chainId: 137, contract: CONTRACT, status: 'ok', blockNumber: '1', balance: '0', balanceFormatted: '0' },
    ]);
    const route = await load('balance');
    const res = await route.GET(new Request(`https://open-pay.jp/api/paid/usdc/jpyc/balance?address=${ADDR}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateBalance(body), JSON.stringify(validateBalance.errors)).toBe(true);
  });

  it('transfers', async () => {
    liveMocks.readTransfers.mockResolvedValue({
      chain: 'polygon', chainId: 137, contract: CONTRACT, status: 'ok', fromBlock: '1', toBlock: '100',
      mode: 'snapshot', nextCursor: '99:0', hasMore: false, truncated: false,
      items: [{ blockNumber: '99', txHash: `0x${'ab'.repeat(32)}`, logIndex: 0, from: ADDR, to: SELLER, value: '1', valueFormatted: '0.000000000000000001' }],
    });
    const route = await load('transfers');
    const res = await route.GET(new Request('https://open-pay.jp/api/paid/usdc/jpyc/transfers?chain=polygon'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateTransfers(body), JSON.stringify(validateTransfers.errors)).toBe(true);
  });
});
