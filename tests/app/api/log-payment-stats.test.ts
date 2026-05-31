// /api/log/payment/stats の admin endpoint 統合テスト。
// kv を境界 mock、SUT (auth / validation / aggregation / bigint sum / chain
// 別 reduce / token 別 reduce / filter (chainId / since) / window) は実走。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/kv', () => ({
  kvLrange: vi.fn(),
  kvLlen: vi.fn(),
  isKvConfigured: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { GET } from '@/app/api/log/payment/stats/route';
import { kvLrange, kvLlen, isKvConfigured } from '@/lib/kv';

const TOKEN = 'test_admin_token_xyz';
const JPYC = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MERCHANT = '0x1111111111111111111111111111111111111111';

function makeEntry(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    serverTs: '2026-05-23T00:00:00.000Z',
    flow: 'batch',
    result: 'success',
    chainId: 137,
    tokenAddress: JPYC,
    merchant: MERCHANT,
    merchantAmount: '1000000000000000000', // 1 token (18 decimals)
    feeAmount: '10000000000000000', // 0.01 token
    // v3: 分離記録済の印。これが無い旧 log は feeAmount が conflated とみなされ
    // totalFeeWei から除外される (legacy 除外の挙動は専用テストで検証)。
    feeBreakdownVersion: 1,
    ...over,
  });
}

function makeReq(opts: {
  auth?: string;
  chainId?: string;
  since?: string;
  from?: string;
  to?: string;
} = {}) {
  const params = new URLSearchParams();
  if (opts.chainId !== undefined) params.set('chainId', opts.chainId);
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.from !== undefined) params.set('from', opts.from);
  if (opts.to !== undefined) params.set('to', opts.to);
  const qs = params.toString();
  const url = `http://localhost/api/log/payment/stats${qs ? `?${qs}` : ''}`;
  const headers = new Headers();
  if (opts.auth !== undefined) headers.set('authorization', opts.auth);
  return new Request(url, { method: 'GET', headers });
}

beforeEach(() => {
  process.env.PAYMENT_LOG_ADMIN_TOKEN = TOKEN;
  vi.mocked(isKvConfigured).mockReturnValue(true);
  vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
  vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 0 });
});

afterEach(() => {
  delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
  vi.clearAllMocks();
});

describe('stats: 認証 / 設定 guard', () => {
  it('PAYMENT_LOG_ADMIN_TOKEN 未設定 → 503', async () => {
    delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('admin_token_not_configured');
  });

  it('Authorization header 欠落 → 401', async () => {
    const res = await GET(makeReq({}));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('Authorization header 不一致 → 401', async () => {
    const res = await GET(makeReq({ auth: 'Bearer wrong_token' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('Bearer prefix なしの authorization → 401', async () => {
    const res = await GET(makeReq({ auth: TOKEN }));
    expect(res.status).toBe(401);
  });

  it('KV 未設定 → 503', async () => {
    vi.mocked(isKvConfigured).mockReturnValue(false);
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('kv_not_configured');
  });

  it('KV LRANGE 失敗 → 502', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: false,
      reason: 'http_error',
      status: 503,
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('kv_read_failed');
  });
});

describe('stats: query 検証', () => {
  it('invalid chainId (非数値) → 400', async () => {
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, chainId: 'abc' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_chain_id');
  });

  it('invalid chainId (0) → 400', async () => {
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, chainId: '0' }));
    expect(res.status).toBe(400);
  });

  it('invalid chainId (負) → 400', async () => {
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, chainId: '-1' }));
    expect(res.status).toBe(400);
  });

  it('invalid since (非 ISO 文字列) → 400', async () => {
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, since: 'not-a-date' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_since');
  });

  it('invalid window (from が非整数) → 400', async () => {
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, from: '1.5', to: '10' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_window');
  });

  it('invalid window (from が負) → 400', async () => {
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, from: '-5', to: '10' }),
    );
    expect(res.status).toBe(400);
  });

  it('default window (from / to 省略) は from=0, to=4999', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
    await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(kvLrange).toHaveBeenCalledWith(
      'openpay:payments:log',
      0,
      4_999,
    );
  });
});

describe('stats: aggregate — chain / token / count / GMV', () => {
  it('空 KV → byChain: [], total: 0, considered: 0', async () => {
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.byChain).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.filteredCount).toBe(0);
    expect(body.parseErrors).toBe(0);
  });

  it('単一 chain 単一 token success 3 件 → successCount=3、totalMerchantWei = 3 × amount', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ merchantAmount: '1000000000000000000' }), // 1e18
        makeEntry({ merchantAmount: '2000000000000000000' }), // 2e18
        makeEntry({ merchantAmount: '500000000000000000' }), // 0.5e18
      ],
    });
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 3 });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byChain).toHaveLength(1);
    const chain = body.byChain[0];
    expect(chain.chainId).toBe(137);
    expect(chain.chainName).toBe('Polygon');
    expect(chain.successCount).toBe(3);
    expect(chain.revertedCount).toBe(0);
    expect(chain.errorCount).toBe(0);
    // 1e18 + 2e18 + 0.5e18 = 3.5e18
    expect(chain.totalMerchantWei).toBe('3500000000000000000');
    // 0.01 + 0.01 + 0.01 = 0.03e18 (each entry の feeAmount = 1e16)
    expect(chain.totalFeeWei).toBe('30000000000000000');
    expect(chain.byToken).toHaveLength(1);
    expect(chain.byToken[0].tokenAddress).toBe(JPYC.toLowerCase());
    expect(chain.byToken[0].successCount).toBe(3);
  });

  it('multi-chain: Polygon (137) + Kaia (8217) + Base (8453) で chain 別に分離', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ chainId: 137 }),
        makeEntry({ chainId: 137 }),
        makeEntry({ chainId: 8217, tokenAddress: JPYC }),
        makeEntry({ chainId: 8453, tokenAddress: USDC_BASE }),
      ],
    });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byChain).toHaveLength(3);
    // sort: successCount 降順 → Polygon (2) が最初、tie の Kaia (1) と Base (1)
    // は chainId 昇順で Base (8453) → Kaia (8217)... wait Kaia 8217 < Base 8453
    expect(body.byChain[0].chainName).toBe('Polygon');
    expect(body.byChain[0].successCount).toBe(2);
    expect(body.byChain[1].chainName).toBe('Kaia');
    expect(body.byChain[1].chainId).toBe(8217);
    expect(body.byChain[2].chainName).toBe('Base');
    expect(body.byChain[2].chainId).toBe(8453);
  });

  it('Kaia (chainId 8217) の集計が chainName "Kaia" で正しく動く', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({
          chainId: 8217,
          tokenAddress: JPYC,
          merchantAmount: '5000000000000000000', // 5 JPYC
          feeAmount: '50000000000000000', // 0.05 JPYC
        }),
      ],
    });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byChain[0].chainName).toBe('Kaia');
    expect(body.byChain[0].chainId).toBe(8217);
    expect(body.byChain[0].totalMerchantWei).toBe('5000000000000000000');
    expect(body.byChain[0].totalFeeWei).toBe('50000000000000000');
  });

  it('未知 chainId は "chainId:N" 形式で fallback', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [makeEntry({ chainId: 999_999 })],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byChain[0].chainName).toBe('chainId:999999');
  });

  it('reverted / error は count されるが GMV には加算されない', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ result: 'success', merchantAmount: '1000000000000000000' }),
        makeEntry({ result: 'reverted', merchantAmount: '2000000000000000000' }),
        makeEntry({ result: 'error', merchantAmount: '3000000000000000000' }),
      ],
    });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const chain = body.byChain[0];
    expect(chain.successCount).toBe(1);
    expect(chain.revertedCount).toBe(1);
    expect(chain.errorCount).toBe(1);
    // success の 1e18 のみ
    expect(chain.totalMerchantWei).toBe('1000000000000000000');
  });

  it('standard-fee entry は GMV / count に含めず、success の merchantAmount を totalFeeWei に加算する', async () => {
    // standard mode は merchant 送金 (standard-merchant) + 手数料徴収 (standard-fee)
    // の 2 entry で 1 logical sale を構成する。standard-fee の merchantAmount は
    // 手数料金額なので、GMV (totalMerchantWei) に加算してはいけない。
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({
          flow: 'standard-merchant',
          result: 'success',
          merchantAmount: '1000000000000000000000', // 1000 token (sale 価格)
          // standard-merchant payload は feeAmount を持たない
          feeAmount: undefined,
        }),
        makeEntry({
          flow: 'standard-fee',
          result: 'success',
          merchantAmount: '5000000000000000000', // 5 token (= 1000 × 0.5%)
          feeAmount: '5000000000000000000',
          merchant: '0x3333333333333333333333333333333333333333', // feeReceiver
        }),
      ],
    });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const chain = body.byChain[0];
    // count は standard-merchant の 1 件のみ (standard-fee は GMV / count に含めない)
    expect(chain.successCount).toBe(1);
    // GMV = sale 価格 のみ、手数料は含めない
    expect(chain.totalMerchantWei).toBe('1000000000000000000000');
    // 手数料は standard-fee の merchantAmount から計上
    expect(chain.totalFeeWei).toBe('5000000000000000000');
    // aggregatedCount は 2 (両 entry とも isAggregable で fee は special-case 内側で扱う)
    expect(body.aggregatedCount).toBe(2);
  });

  it('standard-fee が reverted / error なら totalFeeWei は加算されない (未徴収)', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({
          flow: 'standard-merchant',
          result: 'success',
          merchantAmount: '1000000000000000000000', // 1000 sale 成功
          feeAmount: undefined,
        }),
        makeEntry({
          flow: 'standard-fee',
          result: 'reverted',
          merchantAmount: '5000000000000000000', // 5 = 手数料、しかし徴収 revert
          feeAmount: '5000000000000000000',
        }),
        makeEntry({
          flow: 'standard-fee',
          result: 'error',
          merchantAmount: '5000000000000000000', // 5 = 手数料、しかし submit 失敗
          feeAmount: '5000000000000000000',
        }),
      ],
    });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const chain = body.byChain[0];
    // count は merchant の 1 success のみ (fee の reverted/error は count しない)
    expect(chain.successCount).toBe(1);
    expect(chain.revertedCount).toBe(0);
    expect(chain.errorCount).toBe(0);
    expect(chain.totalMerchantWei).toBe('1000000000000000000000');
    // fee は徴収失敗なので 0
    expect(chain.totalFeeWei).toBe('0');
  });

  it('batch / direct entry の feeAmount は引き続き totalFeeWei に加算される (regression fence)', async () => {
    // standard mode 対応で fee 集計ロジックが変わったが、既存 batch / direct の
    // feeAmount 集計は壊さない。fee は同 entry の feeAmount から累積、
    // standard-fee からは merchantAmount で累積、両者の和。
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({
          flow: 'batch',
          result: 'success',
          merchantAmount: '1000000000000000000', // 1
          feeAmount: '10000000000000000', // 0.01
        }),
        makeEntry({
          flow: 'direct',
          result: 'success',
          merchantAmount: '2000000000000000000', // 2
          feeAmount: '20000000000000000', // 0.02
        }),
        makeEntry({
          flow: 'standard-merchant',
          result: 'success',
          merchantAmount: '3000000000000000000', // 3
          feeAmount: undefined,
        }),
        makeEntry({
          flow: 'standard-fee',
          result: 'success',
          merchantAmount: '30000000000000000', // 0.03 = standard 手数料
          feeAmount: '30000000000000000',
        }),
      ],
    });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const chain = body.byChain[0];
    // count: batch + direct + standard-merchant = 3 (standard-fee は除外)
    expect(chain.successCount).toBe(3);
    // GMV: 1 + 2 + 3 = 6 (standard-fee の 0.03 は除外)
    expect(chain.totalMerchantWei).toBe('6000000000000000000');
    // fee: 0.01 (batch) + 0.02 (direct) + 0.03 (standard-fee) = 0.06
    expect(chain.totalFeeWei).toBe('60000000000000000');
  });

  it('v3: 旧 log (feeBreakdownVersion 不在) は conflated feeAmount を totalFeeWei から除外し、売上総額/網手数料相当額を集計', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        // legacy (内訳不明): feeAmount は gas 混在の conflated 値 → totalFeeWei から除外。
        // saleAmount 不在のため GMV は merchantAmount (1e18) で代替。
        makeEntry({
          feeAmount: '99000000000000000', // conflated 0.099
          feeBreakdownVersion: undefined,
          saleAmount: undefined,
          networkFeeEquivalent: undefined,
        }),
        // native v3 (分離済): feeAmount=サービス料 (totalFeeWei に計上)、
        // saleAmount=gross (GMV)、networkFeeEquivalent=網手数料相当額。
        makeEntry({
          feeAmount: '10000000000000000', // 0.01 サービス料
          saleAmount: '2000000000000000000', // 2 gross
          networkFeeEquivalent: '5000000000000000', // 0.005 網手数料相当額
        }),
      ],
    });
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 2 });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const chain = body.byChain[0];
    // conflated 0.099 は除外、v3 の 0.01 のみ計上。
    expect(chain.totalFeeWei).toBe('10000000000000000');
    expect(chain.unknownBreakdownCount).toBe(1);
    // GMV (gross): legacy=merchantAmount(1e18) 代替 + v3 saleAmount(2e18) = 3e18。
    expect(chain.totalSaleWei).toBe('3000000000000000000');
    // 網手数料相当額: v3 の 0.005 のみ (legacy は null)。
    expect(chain.totalNetworkFeeWei).toBe('5000000000000000');
  });

  it('Step3: cross-chain success は (bridge+chainId+txHash) で dedup・merchantAmount は settled income 除外・saleAmount/bridgeFeeMax を集計', async () => {
    const cc = {
      flow: 'direct',
      result: 'success',
      chainId: 8453,
      tokenAddress: USDC_BASE,
      merchant: MERCHANT,
      merchantAmount: '1000000', // bridged intent (1 USDC)
      saleAmount: '1000000', // gross
      bridge: 'cctp-v2',
      sourceChainId: 137,
      txHash: '0xmint1',
      bridgeFeeMax: '1000', // ceiling
      feeAmount: '0',
      feeBreakdownVersion: 1,
    };
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      // 同一 mint の重複 (resume で onMerchantMint が複数回発火したケース)。
      value: [makeEntry(cc), makeEntry(cc)],
    });
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 2 });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.crossChainDeduped).toBe(1); // 2 件中 1 件は重複除外
    const chain = body.byChain.find(
      (c: { chainId: number }) => c.chainId === 8453,
    );
    expect(chain.successCount).toBe(1); // dedup 後 1 件
    // cross-chain は bridged intent (実着金未確定) なので settled income に計上しない
    expect(chain.totalMerchantWei).toBe('0');
    // GMV (gross) と bridge fee 上限は計上する
    expect(chain.totalSaleWei).toBe('1000000');
    expect(chain.totalBridgeFeeMaxWei).toBe('1000');
    // byBridge には intent として残る
    const cctp = body.byBridge.find(
      (b: { bridge: string }) => b.bridge === 'cctp-v2',
    );
    expect(cctp.totalMerchantWei).toBe('1000000');
    expect(cctp.totalBridgeFeeMaxWei).toBe('1000');
  });

  it('Phase 1: feeAmount=0 / undefined の batch・direct・standard-merchant で GMV 計上・totalFeeWei=0', async () => {
    // Phase 1 (alpha) では決済手数料 0% なので、新規 entry は全て feeAmount=0
    // (batch / direct は '0'、standard-merchant は undefined) で記録される。
    // この常態で count / GMV (totalMerchantWei) は正常に積み上がり、totalFeeWei は
    // 0 のままであることを fence する (fee 集計が誤って merchantAmount を拾わない)。
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({
          flow: 'batch',
          result: 'success',
          merchantAmount: '1000000000000000000', // 1
          feeAmount: '0',
        }),
        makeEntry({
          flow: 'direct',
          result: 'success',
          merchantAmount: '2000000000000000000', // 2
          feeAmount: '0',
        }),
        makeEntry({
          flow: 'standard-merchant',
          result: 'success',
          merchantAmount: '3000000000000000000', // 3
          feeAmount: undefined,
        }),
      ],
    });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const chain = body.byChain[0];
    // 3 件すべて 1 logical sale として count (fee tx が無いので standard-fee entry も無し)
    expect(chain.successCount).toBe(3);
    // GMV = 1 + 2 + 3 = 6
    expect(chain.totalMerchantWei).toBe('6000000000000000000');
    // 決済手数料 0% なので totalFeeWei は厳密に 0
    expect(chain.totalFeeWei).toBe('0');
  });

  it('巨大 bigint amount (1e30) でも overflow せず正しく加算', async () => {
    // wei は最大 uint256 ~ 1.15e77、JavaScript Number 上限 1.79e308 だが
    // 精度は 2^53 (~9e15) で失われる。BigInt 加算で精度保つことを verify。
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ merchantAmount: '1000000000000000000000000000000' }), // 1e30
        makeEntry({ merchantAmount: '2000000000000000000000000000000' }), // 2e30
      ],
    });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byChain[0].totalMerchantWei).toBe(
      '3000000000000000000000000000000',
    );
  });

  it('token 別内訳: 同 chain で JPYC + USDC 混在を byToken で分離', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        // 全部 Polygon mainnet (137) 想定
        makeEntry({ tokenAddress: JPYC }),
        makeEntry({ tokenAddress: JPYC }),
        makeEntry({
          tokenAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC Polygon
        }),
      ],
    });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byChain).toHaveLength(1);
    expect(body.byChain[0].byToken).toHaveLength(2);
    // sort: successCount 降順 → JPYC (2) が先
    expect(body.byChain[0].byToken[0].tokenAddress).toBe(JPYC.toLowerCase());
    expect(body.byChain[0].byToken[0].successCount).toBe(2);
    expect(body.byChain[0].byToken[1].successCount).toBe(1);
  });

  it('token address の大文字小文字は同一視 (lower-case 正規化)', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ tokenAddress: JPYC.toUpperCase() }),
        makeEntry({ tokenAddress: JPYC.toLowerCase() }),
      ],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byChain[0].byToken).toHaveLength(1);
    expect(body.byChain[0].byToken[0].successCount).toBe(2);
  });
});

describe('stats: filter (chainId / since)', () => {
  it('chainId=8217 filter で Kaia のみ集計', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ chainId: 137 }),
        makeEntry({ chainId: 8217 }),
        makeEntry({ chainId: 8217 }),
        makeEntry({ chainId: 8453 }),
      ],
    });
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, chainId: '8217' }),
    );
    const body = await res.json();
    expect(body.byChain).toHaveLength(1);
    expect(body.byChain[0].chainId).toBe(8217);
    expect(body.byChain[0].successCount).toBe(2);
    expect(body.filteredCount).toBe(2);
  });

  it('since filter で時間 cut-off 動作', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ serverTs: '2026-05-22T12:00:00.000Z' }), // before cut-off
        makeEntry({ serverTs: '2026-05-23T12:00:00.000Z' }), // after
        makeEntry({ serverTs: '2026-05-24T00:00:00.000Z' }), // after
      ],
    });
    const res = await GET(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        since: '2026-05-23T00:00:00.000Z',
      }),
    );
    const body = await res.json();
    expect(body.filteredCount).toBe(2);
    expect(body.byChain[0].successCount).toBe(2);
  });

  it('chainId + since 両方を組合せ', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({
          chainId: 8217,
          serverTs: '2026-05-22T00:00:00.000Z',
        }), // chain match, before cut-off
        makeEntry({
          chainId: 8217,
          serverTs: '2026-05-23T12:00:00.000Z',
        }), // both match
        makeEntry({
          chainId: 137,
          serverTs: '2026-05-23T12:00:00.000Z',
        }), // wrong chain
      ],
    });
    const res = await GET(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        chainId: '8217',
        since: '2026-05-23T00:00:00.000Z',
      }),
    );
    const body = await res.json();
    expect(body.filteredCount).toBe(1);
    expect(body.byChain[0].chainId).toBe(8217);
  });

  it('serverTs が無い entry は since filter ON で除外される', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ serverTs: '2026-05-23T12:00:00.000Z' }),
        // serverTs を消す
        JSON.stringify({
          flow: 'batch',
          result: 'success',
          chainId: 137,
          tokenAddress: JPYC,
          merchant: MERCHANT,
          merchantAmount: '1000000000000000000',
        }),
      ],
    });
    const res = await GET(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        since: '2026-05-20T00:00:00.000Z',
      }),
    );
    const body = await res.json();
    expect(body.filteredCount).toBe(1);
  });
});

describe('stats: 不正 / 部分破損 entry のハンドリング', () => {
  it('JSON parse 失敗は parseErrors にカウント、集計には含めない', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry(),
        'not_a_json{',
        makeEntry({ chainId: 8217 }),
      ],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.parseErrors).toBe(1);
    expect(body.filteredCount).toBe(2);
    expect(body.fetched).toBe(3);
  });

  it('aggregable 不可 entry (chainId 欠落) は silently skip', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry(),
        JSON.stringify({
          result: 'success',
          tokenAddress: JPYC,
          merchantAmount: '1e18',
          // chainId 無し
        }),
      ],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byChain).toHaveLength(1); // chainId 有る方だけ
    expect(body.byChain[0].successCount).toBe(1);
  });

  it('merchantAmount が非 10 進数文字列 → 0 として加算 (集計安全)', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ merchantAmount: 'NaN' }),
        makeEntry({ merchantAmount: '0x123' }),
        makeEntry({ merchantAmount: '1000000000000000000' }), // 正常
      ],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    // 3 件 success として count、GMV は正常 1 件分
    expect(body.byChain[0].successCount).toBe(3);
    expect(body.byChain[0].totalMerchantWei).toBe('1000000000000000000');
  });

  it('result が想定外文字列 → entry skip', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ result: 'success' }),
        makeEntry({ result: 'unknown_status' }),
        makeEntry({ result: 'pending' }),
      ],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byChain[0].successCount).toBe(1);
    // filter は通る (chainId/since OK)、aggregate で 2 件 skip (Codex audit
    // で `considered` → `filteredCount` + `aggregatedCount` + `invalidEntries`
    // に分離)
    expect(body.filteredCount).toBe(3);
    expect(body.aggregatedCount).toBe(1);
    expect(body.invalidEntries).toBe(2);
  });
});

describe('stats: window pagination + cap', () => {
  it('from/to で kvLrange の引数が直接渡される', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
    await GET(makeReq({ auth: `Bearer ${TOKEN}`, from: '100', to: '200' }));
    expect(kvLrange).toHaveBeenCalledWith(
      'openpay:payments:log',
      100,
      200,
    );
  });

  it('to=-1 (KV 末尾) は window cap で拒否 (Codex audit: DoS 回避)', async () => {
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, from: '0', to: '-1' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_window');
    expect(kvLrange).not.toHaveBeenCalled();
  });

  it('window > 5000 entry は拒否 (Codex audit: DoS 回避)', async () => {
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, from: '0', to: '5000' }),
    );
    // to - from + 1 = 5001 > MAX_WINDOW 5000 → 400
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_window');
    expect(body.maxWindow).toBe(5000);
  });

  it('window == 5000 entry (上限ぴったり) は通る', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, from: '0', to: '4999' }),
    );
    expect(res.status).toBe(200);
    expect(kvLrange).toHaveBeenCalledWith('openpay:payments:log', 0, 4999);
  });

  it('to < from は拒否 (常識 guard)', async () => {
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, from: '100', to: '50' }),
    );
    expect(res.status).toBe(400);
  });

  it('response meta は data source 不確実性を明示 (Codex audit)', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.meta).toBeDefined();
    expect(body.meta.dataSource).toBe('client-reported, unverified');
    expect(body.meta.verifiedAgainstChain).toBe(false);
    expect(body.meta.maxWindow).toBe(5000);
  });
});

describe('stats: bridge 別集計 (phase 2 cross-chain receive)', () => {
  it('bridge 未設定 entry は "direct" として集計', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [makeEntry({ chainId: 137 })],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    expect(body.byBridge).toEqual([
      expect.objectContaining({
        bridge: 'direct',
        successCount: 1,
        totalMerchantWei: '1000000000000000000',
      }),
    ]);
  });

  it('gateway / cctp-v2 / direct の混在を bridge 別に分離集計', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ chainId: 137 }),
        makeEntry({ chainId: 137, bridge: 'gateway' }),
        makeEntry({ chainId: 137, bridge: 'gateway' }),
        makeEntry({ chainId: 137, bridge: 'cctp-v2' }),
      ],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const byBridge = body.byBridge as Array<{
      bridge: string;
      successCount: number;
      totalMerchantWei: string;
    }>;
    const direct = byBridge.find((b) => b.bridge === 'direct');
    const gateway = byBridge.find((b) => b.bridge === 'gateway');
    const cctp = byBridge.find((b) => b.bridge === 'cctp-v2');
    expect(direct?.successCount).toBe(1);
    expect(gateway?.successCount).toBe(2);
    expect(cctp?.successCount).toBe(1);
    expect(gateway?.totalMerchantWei).toBe('2000000000000000000');
  });

  it('未知 bridge 値は "unknown" key に集約 (future-proof)', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [makeEntry({ bridge: 'future-bridge-v3' })],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const unknown = body.byBridge.find(
      (b: { bridge: string }) => b.bridge === 'unknown',
    );
    expect(unknown?.successCount).toBe(1);
  });

  it('chain ごとに byBridge breakdown が出る', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ chainId: 137 }),
        makeEntry({ chainId: 137, bridge: 'gateway' }),
        makeEntry({ chainId: 8453, bridge: 'cctp-v2' }),
      ],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const polygon = body.byChain.find((c: { chainId: number }) => c.chainId === 137);
    const base = body.byChain.find((c: { chainId: number }) => c.chainId === 8453);
    expect(polygon.byBridge).toEqual([
      expect.objectContaining({ bridge: 'direct', successCount: 1 }),
      expect.objectContaining({ bridge: 'gateway', successCount: 1 }),
    ]);
    expect(base.byBridge).toEqual([
      expect.objectContaining({ bridge: 'cctp-v2', successCount: 1 }),
    ]);
  });

  it('bridge は固定順序 direct → gateway → cctp-v2 → unknown', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ bridge: 'unknown' }),
        makeEntry({ bridge: 'cctp-v2' }),
        makeEntry({ bridge: 'gateway' }),
        makeEntry(),
      ],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const order = body.byBridge.map((b: { bridge: string }) => b.bridge);
    expect(order).toEqual(['direct', 'gateway', 'cctp-v2', 'unknown']);
  });

  it('reverted / error は GMV に計上せず count のみ', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: [
        makeEntry({ bridge: 'gateway' }),
        makeEntry({ bridge: 'gateway', result: 'reverted' }),
        makeEntry({ bridge: 'gateway', result: 'error' }),
      ],
    });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    const body = await res.json();
    const gateway = body.byBridge.find(
      (b: { bridge: string }) => b.bridge === 'gateway',
    );
    expect(gateway.successCount).toBe(1);
    expect(gateway.revertedCount).toBe(1);
    expect(gateway.errorCount).toBe(1);
    // success 1 件分のみ GMV 計上
    expect(gateway.totalMerchantWei).toBe('1000000000000000000');
  });
});

describe('stats: byProvider 集計 (Phase1 Circle Paymaster)', () => {
  it('provider 別 count + circle net を verified / reported に分けて集計', async () => {
    const entries = [
      // circle: client-reported net 9000
      makeEntry({
        chainId: 421614,
        tokenAddress: USDC_BASE,
        provider: 'circle',
        circlePaymasterNetUsdc: '9000',
        circleVerification: 'client-reported',
      }),
      // circle: verified net 8000
      makeEntry({
        chainId: 421614,
        tokenAddress: USDC_BASE,
        provider: 'circle',
        circlePaymasterNetUsdc: '8000',
        circleVerification: 'verified',
      }),
      // pimlico success
      makeEntry({ provider: 'pimlico' }),
      // provider 無し (standard/legacy) → unknown
      makeEntry({}),
    ];
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: entries });
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: entries.length });

    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const byProvider = body.byProvider as Array<{
      provider: string;
      successCount: number;
      circleNetUsdcVerified: string;
      circleNetUsdcReported: string;
    }>;
    const circle = byProvider.find((p) => p.provider === 'circle')!;
    expect(circle.successCount).toBe(2);
    expect(circle.circleNetUsdcReported).toBe('9000');
    expect(circle.circleNetUsdcVerified).toBe('8000');
    const pimlico = byProvider.find((p) => p.provider === 'pimlico')!;
    expect(pimlico.successCount).toBe(1);
    expect(pimlico.circleNetUsdcReported).toBe('0');
    expect(byProvider.find((p) => p.provider === 'unknown')?.successCount).toBe(1);
  });
})
