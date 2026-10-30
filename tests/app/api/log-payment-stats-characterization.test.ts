// /api/log/payment/stats の characterization (第 8 回レビュー F-8・PR-18)。
// 集計を lib/paymentLogStats.ts の純関数に抜き出す前に、現行 route の応答 (status・JSON の形・値・
// key の並び) を丸ごと固定する。既存の tests/app/api/log-payment-stats.test.ts は項目ごとの部分一致
// なので、ここでは本文を JSON 文字列で突き合わせ、分割の前後で応答が 1 byte も変わらないことを確かめる。
// 現行の挙動に問題があっても直さずにそのまま固定する (直すのは別 PR・該当箇所にコメントを書く)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/kv', () => ({
  kvLrange: vi.fn(),
  kvLlen: vi.fn(),
  isKvConfigured: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from '@/app/api/log/payment/stats/route';
import { kvLrange, kvLlen, isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';

const TOKEN = 'characterization_admin_token';
const AUTH = `Bearer ${TOKEN}`;
const KEY = 'openpay:payments:log';
const JPYC = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const line = (o: unknown) => JSON.stringify(o);

// auth = null は Authorization header を付けない (undefined だと既定値の AUTH が入るため null で表す)。
function req(query: Record<string, string> = {}, auth: string | null = AUTH) {
  const qs = new URLSearchParams(query).toString();
  const headers = new Headers();
  if (auth !== null) headers.set('authorization', auth);
  return new Request(`http://localhost/api/log/payment/stats${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers,
  });
}

function mockKv(lines: string[], llen: number | null = lines.length) {
  vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: lines });
  vi.mocked(kvLlen).mockResolvedValue(
    llen === null ? { ok: false, reason: 'http_error', status: 500 } : { ok: true, value: llen },
  );
}

const META = {
  dataSource: 'client-reported, unverified',
  verifiedAgainstChain: false,
  maxWindow: 5000,
};

beforeEach(() => {
  process.env.PAYMENT_LOG_ADMIN_TOKEN = TOKEN;
  vi.mocked(isKvConfigured).mockReturnValue(true);
  mockKv([]);
});

afterEach(() => {
  delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
  vi.clearAllMocks();
});

describe('stats characterization: 混在した log の応答本文を丸ごと固定', () => {
  // chain / token / bridge / provider / standard 2 entry / 旧 log / cross-chain の dedup /
  // 壊れた行 / 型の違う金額を 1 つの window に混ぜる。key の並びまで固定するため本文は文字列で比べる。
  const lines = [
    // L0 Polygon JPYC batch success・分離記録済・pimlico
    line({ serverTs: '2026-05-23T00:00:00.000Z', flow: 'batch', result: 'success', chainId: 137, tokenAddress: JPYC, merchantAmount: '1000', feeAmount: '10', saleAmount: '1010', networkFeeEquivalent: '3', feeBreakdownVersion: 1, provider: 'pimlico' }),
    // L1 同じ token の大文字表記・saleAmount 無し (着金額で代替)・networkFeeEquivalent 無しで circlePaymasterNetUsdc を拾う
    line({ flow: 'direct', result: 'success', chainId: 137, tokenAddress: JPYC.toUpperCase(), merchantAmount: '2000', feeAmount: '20', circlePaymasterNetUsdc: '7', feeBreakdownVersion: 1 }),
    // L2 旧 log (feeBreakdownVersion 無し) → feeAmount を利用手数料から外し unknownBreakdownCount に数える・circle
    line({ flow: 'batch', result: 'success', chainId: 137, tokenAddress: USDC_POLYGON, merchantAmount: '500', feeAmount: '99', provider: 'circle', circlePaymasterNetUsdc: '40' }),
    // L3 reverted (circle) → 件数だけ・circle の申告額は success だけ
    line({ flow: 'batch', result: 'reverted', chainId: 137, tokenAddress: JPYC, merchantAmount: '9999', provider: 'circle', circlePaymasterNetUsdc: '5', feeBreakdownVersion: 1 }),
    // L4 error・想定外の provider → unknown
    line({ flow: 'batch', result: 'error', chainId: 137, tokenAddress: JPYC, merchantAmount: '8888', provider: 'other', feeBreakdownVersion: 1 }),
    // L5 standard-merchant・bridge 'none' は direct
    line({ flow: 'standard-merchant', result: 'success', chainId: 137, tokenAddress: JPYC, merchantAmount: '3000', bridge: 'none', feeBreakdownVersion: 1 }),
    // L6 standard-fee success → merchantAmount を手数料に足すだけ (件数・GMV・provider には入れない)
    line({ flow: 'standard-fee', result: 'success', chainId: 137, tokenAddress: JPYC, merchantAmount: '15', feeAmount: '15', provider: 'pimlico', feeBreakdownVersion: 1 }),
    // L7 standard-fee reverted → 何も足さない (aggregatedCount には入る)
    line({ flow: 'standard-fee', result: 'reverted', chainId: 137, tokenAddress: JPYC, merchantAmount: '15', feeBreakdownVersion: 1 }),
    // L8 Base cctp-v2 success → chain/token の着金額から外し byBridge に intent として残す
    line({ flow: 'direct', result: 'success', chainId: 8453, tokenAddress: USDC_BASE, merchantAmount: '1000000', saleAmount: '1000000', feeAmount: '0', bridge: 'cctp-v2', sourceChainId: 137, txHash: '0xAA', bridgeFeeMax: '1000', feeBreakdownVersion: 1 }),
    // L9 L8 と同じ mint (txHash の大小違い) → dedup (先に来た L8 の値が残る)
    line({ flow: 'direct', result: 'success', chainId: 8453, tokenAddress: USDC_BASE, merchantAmount: '5', feeAmount: '0', bridge: 'cctp-v2', txHash: '0xaa', bridgeFeeMax: '77', feeBreakdownVersion: 1 }),
    // L10 同じ txHash でも reverted は dedup しない
    line({ flow: 'direct', result: 'reverted', chainId: 8453, tokenAddress: USDC_BASE, merchantAmount: '1000000', bridge: 'cctp-v2', txHash: '0xaa', feeBreakdownVersion: 1 }),
    // L11 gateway success → dedup の鍵は gatewayTransferSpecHash・circle の申告額は網手数料相当額にも入る
    line({ flow: 'direct', result: 'success', chainId: 8453, tokenAddress: USDC_BASE, merchantAmount: '200', feeAmount: '2', bridge: 'gateway', gatewayTransferSpecHash: '0xSPEC', txHash: '0x01', provider: 'circle', circlePaymasterNetUsdc: '11', feeBreakdownVersion: 1 }),
    // L12 L11 と同じ spec hash (txHash は別) → dedup
    line({ flow: 'direct', result: 'success', chainId: 8453, tokenAddress: USDC_BASE, merchantAmount: '999', feeAmount: '9', bridge: 'gateway', gatewayTransferSpecHash: '0xspec', txHash: '0x02', feeBreakdownVersion: 1 }),
    // L13 未知の chain・未知の bridge (unknown 扱い = cross-chain)・txHash 無し (dedup しない)
    line({ flow: 'direct', result: 'success', chainId: 999999, tokenAddress: '0xAbC', merchantAmount: '50', feeAmount: '1', bridge: 'mystery', feeBreakdownVersion: 1 }),
    // L14 JSON として壊れた行 → parseErrors
    'not json{',
    // L15〜L18 集計できない entry → invalidEntries
    line('a string'),
    line({ result: 'success', chainId: '137', tokenAddress: '0x1' }),
    line({ result: 'pending', chainId: 137, tokenAddress: '0x1' }),
    line({ result: 'success', chainId: 137.5, tokenAddress: '0x1' }),
    // L19 Kaia・金額が JSON の数値 (10 進の文字列として通る)・16 進の feeAmount は 0・空の saleAmount は 0
    //     (着金額で代替しない)・壊れた networkFeeEquivalent は 0 (circlePaymasterNetUsdc に落ちない)
    line({ flow: 'batch', result: 'success', chainId: 8217, tokenAddress: JPYC, merchantAmount: 1234, feeAmount: '0x10', saleAmount: '', networkFeeEquivalent: 'abc', circlePaymasterNetUsdc: '9', feeBreakdownVersion: 1 }),
    // L20 先頭 0 の金額は 10 進として読む・文字列の feeBreakdownVersion は分離記録済とみなさない
    line({ flow: 'batch', result: 'success', chainId: 8217, tokenAddress: JPYC, merchantAmount: '007', feeAmount: '3', feeBreakdownVersion: '1' }),
  ];

  const JPYC_L = JPYC.toLowerCase();
  const expected = {
    ok: true,
    meta: META,
    total: 21,
    windowFrom: 0,
    windowTo: 4999,
    fetched: 21,
    parseErrors: 1,
    filteredCount: 20,
    aggregatedCount: 14,
    invalidEntries: 4,
    crossChainDeduped: 2,
    filter: { chainId: null, since: null },
    byChain: [
      {
        chainId: 137,
        chainName: 'Polygon',
        successCount: 4,
        revertedCount: 1,
        errorCount: 1,
        totalMerchantWei: '6500',
        totalFeeWei: '45',
        totalSaleWei: '6510',
        totalNetworkFeeWei: '50',
        totalBridgeFeeMaxWei: '0',
        unknownBreakdownCount: 1,
        byToken: [
          { tokenAddress: JPYC_L, successCount: 3, revertedCount: 1, errorCount: 1, totalMerchantWei: '6000', totalFeeWei: '45', totalSaleWei: '6010', totalNetworkFeeWei: '10' },
          { tokenAddress: USDC_POLYGON.toLowerCase(), successCount: 1, revertedCount: 0, errorCount: 0, totalMerchantWei: '500', totalFeeWei: '0', totalSaleWei: '500', totalNetworkFeeWei: '40' },
        ],
        byBridge: [
          { bridge: 'direct', successCount: 4, revertedCount: 1, errorCount: 1, totalMerchantWei: '6500', totalFeeWei: '45', totalSaleWei: '6510', totalNetworkFeeWei: '50', totalBridgeFeeMaxWei: '0' },
        ],
      },
      // success 2 件で Base と並ぶ → chainId の小さい Kaia が先
      {
        chainId: 8217,
        chainName: 'Kaia',
        successCount: 2,
        revertedCount: 0,
        errorCount: 0,
        totalMerchantWei: '1241',
        totalFeeWei: '0',
        totalSaleWei: '7',
        totalNetworkFeeWei: '0',
        totalBridgeFeeMaxWei: '0',
        unknownBreakdownCount: 1,
        byToken: [
          { tokenAddress: JPYC_L, successCount: 2, revertedCount: 0, errorCount: 0, totalMerchantWei: '1241', totalFeeWei: '0', totalSaleWei: '7', totalNetworkFeeWei: '0' },
        ],
        byBridge: [
          { bridge: 'direct', successCount: 2, revertedCount: 0, errorCount: 0, totalMerchantWei: '1241', totalFeeWei: '0', totalSaleWei: '7', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '0' },
        ],
      },
      {
        chainId: 8453,
        chainName: 'Base',
        successCount: 2,
        revertedCount: 1,
        errorCount: 0,
        totalMerchantWei: '0',
        totalFeeWei: '2',
        totalSaleWei: '1000200',
        totalNetworkFeeWei: '11',
        totalBridgeFeeMaxWei: '1000',
        unknownBreakdownCount: 0,
        byToken: [
          { tokenAddress: USDC_BASE.toLowerCase(), successCount: 2, revertedCount: 1, errorCount: 0, totalMerchantWei: '0', totalFeeWei: '2', totalSaleWei: '1000200', totalNetworkFeeWei: '11' },
        ],
        byBridge: [
          { bridge: 'gateway', successCount: 1, revertedCount: 0, errorCount: 0, totalMerchantWei: '200', totalFeeWei: '2', totalSaleWei: '200', totalNetworkFeeWei: '11', totalBridgeFeeMaxWei: '0' },
          { bridge: 'cctp-v2', successCount: 1, revertedCount: 1, errorCount: 0, totalMerchantWei: '1000000', totalFeeWei: '0', totalSaleWei: '1000000', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '1000' },
        ],
      },
      {
        chainId: 999999,
        chainName: 'chainId:999999',
        successCount: 1,
        revertedCount: 0,
        errorCount: 0,
        totalMerchantWei: '0',
        totalFeeWei: '1',
        totalSaleWei: '50',
        totalNetworkFeeWei: '0',
        totalBridgeFeeMaxWei: '0',
        unknownBreakdownCount: 0,
        byToken: [
          { tokenAddress: '0xabc', successCount: 1, revertedCount: 0, errorCount: 0, totalMerchantWei: '0', totalFeeWei: '1', totalSaleWei: '50', totalNetworkFeeWei: '0' },
        ],
        byBridge: [
          { bridge: 'unknown', successCount: 1, revertedCount: 0, errorCount: 0, totalMerchantWei: '50', totalFeeWei: '1', totalSaleWei: '50', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '0' },
        ],
      },
    ],
    byBridge: [
      { bridge: 'direct', successCount: 6, revertedCount: 1, errorCount: 1, totalMerchantWei: '7741', totalFeeWei: '45', totalSaleWei: '6517', totalNetworkFeeWei: '50', totalBridgeFeeMaxWei: '0' },
      { bridge: 'gateway', successCount: 1, revertedCount: 0, errorCount: 0, totalMerchantWei: '200', totalFeeWei: '2', totalSaleWei: '200', totalNetworkFeeWei: '11', totalBridgeFeeMaxWei: '0' },
      { bridge: 'cctp-v2', successCount: 1, revertedCount: 1, errorCount: 0, totalMerchantWei: '1000000', totalFeeWei: '0', totalSaleWei: '1000000', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '1000' },
      { bridge: 'unknown', successCount: 1, revertedCount: 0, errorCount: 0, totalMerchantWei: '50', totalFeeWei: '1', totalSaleWei: '50', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '0' },
    ],
    byProvider: [
      { provider: 'pimlico', successCount: 1, revertedCount: 0, errorCount: 0, circleNetUsdcReported: '0' },
      { provider: 'circle', successCount: 2, revertedCount: 1, errorCount: 0, circleNetUsdcReported: '51' },
      { provider: 'unknown', successCount: 6, revertedCount: 1, errorCount: 1, circleNetUsdcReported: '0' },
    ],
  };

  it('200・本文 (key の並びを含む) が現行と同じ', async () => {
    mockKv(lines);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(JSON.stringify(expected));
    expect(kvLrange).toHaveBeenCalledWith(KEY, 0, 4999);
    expect(kvLlen).toHaveBeenCalledWith(KEY);
  });

  it('同じ入力を 2 回集計しても同じ本文 (呼び出しをまたいで状態を持たない)', async () => {
    mockKv(lines);
    const first = await (await GET(req())).text();
    const second = await (await GET(req())).text();
    expect(second).toBe(first);
  });
});

describe('stats characterization: 空の log と件数の読み取り失敗', () => {
  it('空 → 全 0・各一覧は空配列', async () => {
    mockKv([], 0);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({
      ok: true,
      meta: META,
      total: 0,
      windowFrom: 0,
      windowTo: 4999,
      fetched: 0,
      parseErrors: 0,
      filteredCount: 0,
      aggregatedCount: 0,
      invalidEntries: 0,
      crossChainDeduped: 0,
      filter: { chainId: null, since: null },
      byChain: [],
      byBridge: [],
      byProvider: [],
    }));
  });

  it('LLEN だけ失敗 → 200 のまま total は null', async () => {
    mockKv([], null);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeNull();
    expect(body.ok).toBe(true);
  });

  it('壊れた行と集計できない行だけ → byChain は空・件数だけ出る', async () => {
    mockKv(['{', '[]', '42', 'true', line({ chainId: 137 })], 5);
    const res = await GET(req());
    const body = await res.json();
    expect(body).toMatchObject({
      fetched: 5,
      parseErrors: 1,
      filteredCount: 4,
      aggregatedCount: 0,
      invalidEntries: 4,
      crossChainDeduped: 0,
      byChain: [],
      byBridge: [],
      byProvider: [],
    });
  });
});

describe('stats characterization: 期間 (since)・chain・window の絞り込み', () => {
  it('since はちょうどの時刻を含み、1ms 前・serverTs 無し・読めない serverTs は外す', async () => {
    const SINCE = '2026-05-23T00:00:00.000Z';
    const base = { flow: 'batch', result: 'success', chainId: 137, tokenAddress: JPYC, merchantAmount: '100', feeAmount: '1', feeBreakdownVersion: 1 };
    mockKv([
      line({ ...base, serverTs: SINCE }),
      line({ ...base, serverTs: '2026-05-22T23:59:59.999Z', merchantAmount: '200' }),
      line({ ...base, merchantAmount: '400' }),
      line({ ...base, serverTs: 'garbage', merchantAmount: '800' }),
      line({ ...base, serverTs: '2026-05-24', merchantAmount: '1600' }),
      line({ ...base, serverTs: '2026-05-25T00:00:00.000Z', chainId: 8217, merchantAmount: '3200' }),
      line({ ...base, serverTs: '2026-05-25T00:00:00.000Z', chainId: '137', merchantAmount: '6400' }),
      'oops',
    ], 99);
    const res = await GET(req({ from: '10', to: '20', chainId: '0x89', since: SINCE }));
    expect(res.status).toBe(200);
    expect(kvLrange).toHaveBeenCalledWith(KEY, 10, 20);
    expect(await res.text()).toBe(JSON.stringify({
      ok: true,
      meta: META,
      total: 99,
      windowFrom: 10,
      windowTo: 20,
      fetched: 8,
      parseErrors: 1,
      filteredCount: 2,
      aggregatedCount: 2,
      invalidEntries: 0,
      crossChainDeduped: 0,
      // chainId=0x89 は Number() で 137 になり、数値で返る。since は受け取った文字列のまま返す
      filter: { chainId: 137, since: SINCE },
      byChain: [
        {
          chainId: 137,
          chainName: 'Polygon',
          successCount: 2,
          revertedCount: 0,
          errorCount: 0,
          totalMerchantWei: '1700',
          totalFeeWei: '2',
          totalSaleWei: '1700',
          totalNetworkFeeWei: '0',
          totalBridgeFeeMaxWei: '0',
          unknownBreakdownCount: 0,
          byToken: [
            { tokenAddress: JPYC.toLowerCase(), successCount: 2, revertedCount: 0, errorCount: 0, totalMerchantWei: '1700', totalFeeWei: '2', totalSaleWei: '1700', totalNetworkFeeWei: '0' },
          ],
          byBridge: [
            { bridge: 'direct', successCount: 2, revertedCount: 0, errorCount: 0, totalMerchantWei: '1700', totalFeeWei: '2', totalSaleWei: '1700', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '0' },
          ],
        },
      ],
      byBridge: [
        { bridge: 'direct', successCount: 2, revertedCount: 0, errorCount: 0, totalMerchantWei: '1700', totalFeeWei: '2', totalSaleWei: '1700', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '0' },
      ],
      byProvider: [
        { provider: 'unknown', successCount: 2, revertedCount: 0, errorCount: 0, circleNetUsdcReported: '0' },
      ],
    }));
  });

  it('since 無しなら serverTs の無い entry も集計に入る', async () => {
    mockKv([
      line({ result: 'success', chainId: 137, tokenAddress: JPYC, merchantAmount: '1' }),
      line({ result: 'success', chainId: 137, tokenAddress: JPYC, merchantAmount: '2', serverTs: 'garbage' }),
    ]);
    const body = await (await GET(req())).json();
    expect(body.filteredCount).toBe(2);
    expect(body.byChain[0].totalMerchantWei).toBe('3');
  });

  it.each([
    // [query, windowFrom, windowTo]
    [{ from: '', to: '' }, 0, 0],
    [{ from: '1e3', to: '1999' }, 1000, 1999],
    [{ to: '4999.0' }, 0, 4999],
    [{ from: '4999' }, 4999, 4999],
  ])('window %o → %i..%i で読む', async (query, from, to) => {
    const res = await GET(req(query));
    expect(res.status).toBe(200);
    expect(kvLrange).toHaveBeenCalledWith(KEY, from, to);
    const body = await res.json();
    expect([body.windowFrom, body.windowTo]).toEqual([from, to]);
  });

  it.each([
    [{ chainId: ' 8217 ' }, 8217],
    [{ chainId: '8217.0' }, 8217],
  ])('chainId %o → filter.chainId は %i', async (query, chainId) => {
    const body = await (await GET(req(query))).json();
    expect(body.filter).toEqual({ chainId, since: null });
  });

  it('since は日付だけでも受け付け、受け取った文字列のまま返す', async () => {
    const body = await (await GET(req({ since: '2026-05-23' }))).json();
    expect(body.filter).toEqual({ chainId: null, since: '2026-05-23' });
  });
});

describe('stats characterization: 400 の本文と検査の順', () => {
  const WINDOW = { ok: false, error: 'invalid_window', maxWindow: 5000 };
  const CHAIN = { ok: false, error: 'invalid_chain_id' };
  const SINCE = { ok: false, error: 'invalid_since' };

  it.each([
    [{ from: 'abc' }, WINDOW],
    [{ from: '-1' }, WINDOW],
    [{ to: '-1' }, WINDOW],
    [{ from: '5', to: '4' }, WINDOW],
    [{ from: '0', to: '5000' }, WINDOW],
    [{ from: '0.5' }, WINDOW],
    // 検査の順: window → chainId → since
    [{ from: 'x', chainId: 'x', since: 'x' }, WINDOW],
    [{ chainId: 'x', since: 'x' }, CHAIN],
    [{ chainId: '' }, CHAIN],
    [{ chainId: '0' }, CHAIN],
    [{ chainId: '-137' }, CHAIN],
    [{ chainId: '1.5' }, CHAIN],
    [{ since: '' }, SINCE],
    [{ since: 'not-a-date' }, SINCE],
  ])('%o → 400 %o (KV は読まない)', async (query, body) => {
    const res = await GET(req(query));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON.stringify(body));
    expect(kvLrange).not.toHaveBeenCalled();
    expect(kvLlen).not.toHaveBeenCalled();
  });
});

describe('stats characterization: 認証と KV の失敗', () => {
  it.each([
    ['token 未設定', () => { delete process.env.PAYMENT_LOG_ADMIN_TOKEN; }, AUTH, 503, { ok: false, error: 'admin_token_not_configured' }],
    ['header 無し', () => {}, null, 401, { ok: false, error: 'unauthorized' }],
    ['token 違い', () => {}, 'Bearer nope', 401, { ok: false, error: 'unauthorized' }],
    ['KV 未設定', () => { vi.mocked(isKvConfigured).mockReturnValue(false); }, AUTH, 503, { ok: false, error: 'kv_not_configured' }],
  ] as const)('%s → %i', async (_name, setup, auth, status, body) => {
    setup();
    const res = await GET(req({}, auth));
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(JSON.stringify(body));
    expect(kvLrange).not.toHaveBeenCalled();
  });

  it('LRANGE 失敗 → 502・理由を warn に残す', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: false, reason: 'http_error', status: 503 });
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(JSON.stringify({ ok: false, error: 'kv_read_failed' }));
    expect(logger.warn).toHaveBeenCalledWith('payment-log.stats-read-failed', {
      reason: 'http_error',
      status: 503,
    });
  });
});

describe('stats characterization: 集計の細部', () => {
  it('standard-fee だけの chain も byChain に 0 件で出る (provider には出ない)・cross-chain の standard-fee も dedup する', async () => {
    const fee = { flow: 'standard-fee', chainId: 10, tokenAddress: JPYC, merchantAmount: '5', feeBreakdownVersion: 1 };
    mockKv([
      line({ ...fee, result: 'reverted' }),
      line({ ...fee, result: 'success', bridge: 'gateway', gatewayTransferSpecHash: '0xF' }),
      line({ ...fee, result: 'success', bridge: 'gateway', gatewayTransferSpecHash: '0xf' }),
    ]);
    const body = await (await GET(req())).json();
    expect(body.aggregatedCount).toBe(2);
    expect(body.crossChainDeduped).toBe(1);
    expect(body.byProvider).toEqual([]);
    expect(body.byChain).toEqual([
      {
        chainId: 10,
        chainName: 'OP Mainnet',
        successCount: 0,
        revertedCount: 0,
        errorCount: 0,
        totalMerchantWei: '0',
        totalFeeWei: '5',
        totalSaleWei: '0',
        totalNetworkFeeWei: '0',
        totalBridgeFeeMaxWei: '0',
        unknownBreakdownCount: 0,
        byToken: [
          { tokenAddress: JPYC.toLowerCase(), successCount: 0, revertedCount: 0, errorCount: 0, totalMerchantWei: '0', totalFeeWei: '5', totalSaleWei: '0', totalNetworkFeeWei: '0' },
        ],
        byBridge: [
          { bridge: 'direct', successCount: 0, revertedCount: 0, errorCount: 0, totalMerchantWei: '0', totalFeeWei: '0', totalSaleWei: '0', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '0' },
          { bridge: 'gateway', successCount: 0, revertedCount: 0, errorCount: 0, totalMerchantWei: '0', totalFeeWei: '5', totalSaleWei: '0', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '0' },
        ],
      },
    ]);
  });

  it('cross-chain の dedup 鍵は chain ごと (同じ txHash でも chainId が違えば別の着金)', async () => {
    const cc = { flow: 'direct', result: 'success', tokenAddress: USDC_BASE, merchantAmount: '10', bridge: 'cctp-v2', txHash: '0xabc', feeBreakdownVersion: 1 };
    mockKv([line({ ...cc, chainId: 8453 }), line({ ...cc, chainId: 42161 }), line({ ...cc, chainId: 8453 })]);
    const body = await (await GET(req())).json();
    expect(body.crossChainDeduped).toBe(1);
    expect(body.byChain.map((c: { chainId: number; successCount: number }) => [c.chainId, c.successCount])).toEqual([
      [8453, 1],
      [42161, 1],
    ]);
  });

  it('gateway で spec hash が文字列でなければ txHash で dedup・txHash も無ければ dedup しない', async () => {
    const gw = { flow: 'direct', result: 'success', chainId: 8453, tokenAddress: USDC_BASE, merchantAmount: '10', bridge: 'gateway', feeBreakdownVersion: 1 };
    mockKv([
      line({ ...gw, gatewayTransferSpecHash: 123, txHash: '0xT' }),
      line({ ...gw, txHash: '0xt' }),
      line({ ...gw }),
      line({ ...gw }),
      line({ ...gw, txHash: '' }),
      line({ ...gw, txHash: '' }),
    ]);
    const body = await (await GET(req())).json();
    expect(body.crossChainDeduped).toBe(1);
    expect(body.aggregatedCount).toBe(5);
    expect(body.byBridge).toEqual([
      { bridge: 'gateway', successCount: 5, revertedCount: 0, errorCount: 0, totalMerchantWei: '50', totalFeeWei: '0', totalSaleWei: '50', totalNetworkFeeWei: '0', totalBridgeFeeMaxWei: '0' },
    ]);
  });

  it('token の並びは success 降順・同数は最初に現れた順 (安定ソート)', async () => {
    const t = (tokenAddress: string, result: string) =>
      line({ flow: 'batch', result, chainId: 137, tokenAddress, merchantAmount: '1', feeBreakdownVersion: 1 });
    mockKv([t('0xB', 'reverted'), t('0xA', 'success'), t('0xC', 'success'), t('0xC', 'success'), t('0xB', 'success')]);
    const body = await (await GET(req())).json();
    expect(body.byChain[0].byToken.map((x: { tokenAddress: string; successCount: number }) => [x.tokenAddress, x.successCount])).toEqual([
      ['0xc', 2],
      ['0xb', 1],
      ['0xa', 1],
    ]);
  });

  it('chain の並びは success 降順・同数は chainId 昇順 (success 0 の chain も含む)', async () => {
    const c = (chainId: number, result: string) =>
      line({ flow: 'batch', result, chainId, tokenAddress: JPYC, merchantAmount: '1', feeBreakdownVersion: 1 });
    mockKv([c(8453, 'error'), c(137, 'reverted'), c(8217, 'success'), c(42161, 'success'), c(42161, 'success')]);
    const body = await (await GET(req())).json();
    expect(body.byChain.map((x: { chainId: number }) => x.chainId)).toEqual([42161, 8217, 137, 8453]);
  });

  it('feeBreakdownVersion は 1 以上の数値だけ分離記録済とみなす (0 は旧 log 扱い・2 は分離済)', async () => {
    const e = (feeBreakdownVersion: unknown) =>
      line({ flow: 'batch', result: 'success', chainId: 137, tokenAddress: JPYC, merchantAmount: '100', feeAmount: '7', feeBreakdownVersion });
    mockKv([e(0), e(2), e(null)]);
    const body = await (await GET(req())).json();
    expect(body.byChain[0].totalFeeWei).toBe('7');
    expect(body.byChain[0].unknownBreakdownCount).toBe(2);
  });

  it('saleAmount が null・数値の小数・指数表記の金額は 0 として足す', async () => {
    const e = (over: Record<string, unknown>) =>
      line({ flow: 'batch', result: 'success', chainId: 137, tokenAddress: JPYC, merchantAmount: '100', feeBreakdownVersion: 1, ...over });
    mockKv([
      e({ saleAmount: null }),
      e({ merchantAmount: 1.5 }),
      e({ merchantAmount: 1e21 }),
      e({ merchantAmount: '1e3' }),
      e({ merchantAmount: ' 10' }),
    ]);
    const body = await (await GET(req())).json();
    // 着金額は 1 件目の 100 だけ。売上総額は 1 件目が null → 0、残りは着金額 (0) で代替
    expect(body.byChain[0].totalMerchantWei).toBe('100');
    expect(body.byChain[0].totalSaleWei).toBe('0');
    expect(body.byChain[0].successCount).toBe(5);
  });

  it('circle の申告額は success だけを足す (reverted / error は件数だけ)', async () => {
    const e = (result: string, net: string) =>
      line({ flow: 'batch', result, chainId: 137, tokenAddress: JPYC, merchantAmount: '1', provider: 'circle', circlePaymasterNetUsdc: net, feeBreakdownVersion: 1 });
    mockKv([e('success', '100'), e('reverted', '200'), e('error', '400'), e('success', 'bad')]);
    const body = await (await GET(req())).json();
    expect(body.byProvider).toEqual([
      { provider: 'circle', successCount: 2, revertedCount: 1, errorCount: 1, circleNetUsdcReported: '100' },
    ]);
  });
});

describe('stats characterization: JSON の null 行 (object でない行)', () => {
  // 以前は JSON の null 行が parse に成功して entries に入り、filter / isAggregable が null の property を
  // 読んで TypeError になっていた (route は 500・窓全体の集計が取れない)。POST /api/log/payment は shape を
  // 検証してから書くので通常の経路では入らない。今は null も 42・"x"・[] と同じく、絞り込みがあれば外れ、
  // 無ければ invalidEntries に数えて集計から外す。集計の中身は壊れた行が無いときと 1 byte も変わらない。
  const SINCE = '2026-05-23T00:00:00.000Z';
  const good = [
    line({ flow: 'batch', result: 'success', chainId: 137, tokenAddress: JPYC, merchantAmount: '100', feeAmount: '1', feeBreakdownVersion: 1, serverTs: SINCE }),
    line({ flow: 'batch', result: 'reverted', chainId: 8453, tokenAddress: USDC_BASE, merchantAmount: '5', provider: 'circle', feeBreakdownVersion: 1, serverTs: SINCE }),
    line({ flow: 'direct', result: 'success', chainId: 8453, tokenAddress: USDC_BASE, merchantAmount: '7', saleAmount: '7', bridge: 'cctp-v2', txHash: '0xAB', provider: 'circle', circlePaymasterNetUsdc: '3', feeBreakdownVersion: 1, serverTs: SINCE }),
  ];
  // object でない行 (JSON としては読める): null・数値・文字列・配列
  const bad = ['null', '42', line('x'), '[]'];
  const mixed = ['null', good[0], '42', good[1], line('x'), good[2], '[]', 'null'];
  // 壊れた行の有無で変わってよいのは件数 (fetched・filteredCount・invalidEntries と total) だけ。
  const COUNT_KEYS = ['fetched', 'filteredCount', 'invalidEntries', 'total'];
  const aggregateOf = (body: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(body).filter(([k]) => !COUNT_KEYS.includes(k)));

  it('絞り込み無し → 200・null と他の object でない行を invalidEntries に数え、集計は壊れた行が無いときと同じ', async () => {
    mockKv(good);
    const clean = await (await GET(req())).json();
    mockKv(mixed);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(aggregateOf(body)).toEqual(aggregateOf(clean));
    expect(body).toMatchObject({
      fetched: mixed.length,
      parseErrors: 0,
      filteredCount: mixed.length,
      aggregatedCount: 3,
      invalidEntries: bad.length + 1,
    });
  });

  it.each([
    ['chainId', { chainId: '8453' }],
    ['since', { since: SINCE }],
    ['chainId と since', { chainId: '137', since: SINCE }],
  ])('%s で絞る → 200・null を含む object でない行は絞り込みで外れ、応答は壊れた行が無いときと同じ', async (_name, query) => {
    mockKv(good, 10);
    const clean = await (await GET(req(query))).json();
    mockKv(mixed, 10);
    const res = await GET(req(query));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect({ ...body, fetched: clean.fetched }).toEqual(clean);
    expect(body.fetched).toBe(mixed.length);
    expect(body.invalidEntries).toBe(0);
  });

  it('null だけの窓 → 200・byChain は空で invalidEntries 1', async () => {
    mockKv(['null']);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      fetched: 1,
      parseErrors: 0,
      filteredCount: 1,
      aggregatedCount: 0,
      invalidEntries: 1,
      byChain: [],
      byBridge: [],
      byProvider: [],
    });
  });
});
