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
    expect(body.considered).toBe(0);
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
    expect(body.considered).toBe(2);
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
    expect(body.considered).toBe(2);
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
    expect(body.considered).toBe(1);
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
    expect(body.considered).toBe(1);
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
    expect(body.considered).toBe(2);
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
    expect(body.considered).toBe(3); // filter は通る、aggregate で skip
  });
});

describe('stats: window pagination', () => {
  it('from/to で kvLrange の引数が直接渡される', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
    await GET(makeReq({ auth: `Bearer ${TOKEN}`, from: '100', to: '200' }));
    expect(kvLrange).toHaveBeenCalledWith(
      'openpay:payments:log',
      100,
      200,
    );
  });

  it('to=-1 は KV 末尾まで読む', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
    await GET(makeReq({ auth: `Bearer ${TOKEN}`, from: '0', to: '-1' }));
    expect(kvLrange).toHaveBeenCalledWith(
      'openpay:payments:log',
      0,
      -1,
    );
  });
});
