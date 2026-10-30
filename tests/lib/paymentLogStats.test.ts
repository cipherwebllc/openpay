// lib/paymentLogStats.ts の純関数の単体テスト (第 8 回レビュー F-8・PR-18)。
// route を通した応答の固定は tests/app/api/log-payment-stats-characterization.test.ts と
// tests/app/api/log-payment-stats.test.ts。ここは関数ごとの境界を直接確かめる。

import { describe, it, expect } from 'vitest';
import {
  aggregatePaymentLog,
  filterPaymentLogEntries,
  isAggregable,
  normalizeBridge,
  normalizeProvider,
  parsePaymentLogLines,
  parseWei,
  serializeBridges,
  serializeChains,
  serializeProviders,
  statsChainName,
  type PaymentLogStatsEntry,
} from '@/lib/paymentLogStats';

const TOKEN = '0xToken';

function entry(over: Partial<PaymentLogStatsEntry> = {}): PaymentLogStatsEntry {
  return {
    flow: 'batch',
    result: 'success',
    chainId: 137,
    tokenAddress: TOKEN,
    merchantAmount: '100',
    feeAmount: '1',
    feeBreakdownVersion: 1,
    ...over,
  };
}

// 型の上では string でも、KV の JSON からは数値や null が来る (実行時の値をそのまま渡す)。
const raw = (v: unknown) => v as string;

describe('parseWei', () => {
  it.each([
    [undefined, 0n],
    ['', 0n],
    ['0', 0n],
    ['007', 7n],
    ['9'.repeat(78), BigInt('9'.repeat(78))],
    ['-1', 0n],
    ['1.5', 0n],
    ['1e3', 0n],
    ['0x10', 0n],
    [' 10', 0n],
  ])('%j → %s', (v, want) => {
    expect(parseWei(v)).toBe(want);
  });

  it('JSON の数値は 10 進の文字列として読めるものだけ通る', () => {
    expect(parseWei(raw(1234))).toBe(1234n);
    expect(parseWei(raw(1.5))).toBe(0n);
    expect(parseWei(raw(1e21))).toBe(0n);
    expect(parseWei(raw(null))).toBe(0n);
  });
});

describe('normalizeBridge / normalizeProvider', () => {
  it.each([
    [undefined, 'direct'],
    ['', 'direct'],
    ['none', 'direct'],
    ['gateway', 'gateway'],
    ['cctp-v2', 'cctp-v2'],
    ['Gateway', 'unknown'],
    ['future', 'unknown'],
  ])('bridge %j → %s', (v, want) => {
    expect(normalizeBridge(v)).toBe(want);
  });

  it.each([
    ['pimlico', 'pimlico'],
    ['circle', 'circle'],
    [undefined, 'unknown'],
    ['Circle', 'unknown'],
  ])('provider %j → %s', (v, want) => {
    expect(normalizeProvider(v)).toBe(want);
  });
});

describe('isAggregable', () => {
  it('chainId (整数)・tokenAddress (文字列)・result (success/reverted/error) が揃えば true', () => {
    expect(isAggregable(entry())).toBe(true);
    expect(isAggregable(entry({ result: 'reverted' }))).toBe(true);
    expect(isAggregable(entry({ result: 'error', tokenAddress: '' }))).toBe(true);
    expect(isAggregable(entry({ chainId: 0 }))).toBe(true);
  });

  it.each([
    ['chainId 無し', { chainId: undefined }],
    ['chainId が文字列', { chainId: raw('137') as unknown as number }],
    ['chainId が小数', { chainId: 137.5 }],
    ['tokenAddress 無し', { tokenAddress: undefined }],
    ['result が pending', { result: 'pending' }],
    ['result 無し', { result: undefined }],
  ])('%s → false', (_name, over) => {
    expect(isAggregable(entry(over as Partial<PaymentLogStatsEntry>))).toBe(false);
  });

  // 型の上では entry でも、KV の JSON 行からは object でない値が来る (実行時の値をそのまま渡す)。
  it.each([null, 42, 'x', [], true])('object でない値 %j → 投げずに false', (v) => {
    expect(isAggregable(v as unknown as PaymentLogStatsEntry)).toBe(false);
  });
});

describe('statsChainName', () => {
  it('既知の chain は viem の名前・未知は chainId:N', () => {
    expect(statsChainName(137)).toBe('Polygon');
    expect(statsChainName(8217)).toBe('Kaia');
    expect(statsChainName(8453)).toBe('Base');
    expect(statsChainName(999999)).toBe('chainId:999999');
  });
});

describe('parsePaymentLogLines', () => {
  it('JSON として読めない行だけを数え、読めた値は形を問わず entries に入れる', () => {
    const { entries, parseErrors } = parsePaymentLogLines(['{"chainId":1}', '{', '"s"', '42', 'null', '']);
    expect(parseErrors).toBe(2);
    expect(entries).toEqual([{ chainId: 1 }, 's', 42, null]);
  });

  it('空配列 → 空', () => {
    expect(parsePaymentLogLines([])).toEqual({ entries: [], parseErrors: 0 });
  });
});

describe('filterPaymentLogEntries', () => {
  const at = (serverTs: string | undefined, chainId = 137) => entry({ serverTs, chainId });

  it('条件なしなら全件をそのまま (新しい配列で) 返す', () => {
    const input = [at(undefined), at('garbage')];
    const out = filterPaymentLogEntries(input, {});
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('chainId は厳密一致 (文字列の "137" は外れる)', () => {
    const str = { ...entry(), chainId: raw('137') as unknown as number };
    expect(filterPaymentLogEntries([at('x', 137), at('x', 8217), str], { chainId: 137 })).toHaveLength(1);
  });

  it('since は sinceMs 以上を残し、serverTs 無し・読めない値は外す', () => {
    const sinceMs = Date.parse('2026-05-23T00:00:00.000Z');
    const out = filterPaymentLogEntries(
      [
        at('2026-05-23T00:00:00.000Z'),
        at('2026-05-22T23:59:59.999Z'),
        at(undefined),
        at(''),
        at('garbage'),
        at('2026-05-24'),
      ],
      { sinceMs },
    );
    expect(out.map((e) => e.serverTs)).toEqual(['2026-05-23T00:00:00.000Z', '2026-05-24']);
  });

  it('JSON の null 行は投げず、42・"x"・[] と同じく絞り込みがあれば外し、無ければ残す', () => {
    const odd = [null, 42, 'x', []] as unknown as PaymentLogStatsEntry[];
    const ok = at('2026-05-23T00:00:00.000Z');
    const input = [odd[0], ok, ...odd.slice(1)];
    expect(filterPaymentLogEntries(input, {})).toEqual(input);
    expect(filterPaymentLogEntries(input, { chainId: 137 })).toEqual([ok]);
    expect(filterPaymentLogEntries(input, { sinceMs: 0 })).toEqual([ok]);
  });
});

describe('aggregatePaymentLog', () => {
  it('空 → すべて 0 と空配列', () => {
    expect(aggregatePaymentLog([])).toEqual({
      chains: [],
      aggregatedCount: 0,
      invalidEntries: 0,
      crossChainDeduped: 0,
      byBridge: [],
      byProvider: [],
    });
  });

  it('success は件数と金額、reverted / error は件数だけ', () => {
    const agg = aggregatePaymentLog([
      entry({ merchantAmount: '100', feeAmount: '1', saleAmount: '110', networkFeeEquivalent: '3' }),
      entry({ result: 'reverted', merchantAmount: '1000' }),
      entry({ result: 'error', merchantAmount: '1000' }),
    ]);
    expect(agg.aggregatedCount).toBe(3);
    const [chain] = agg.chains;
    expect(chain).toMatchObject({
      chainId: 137,
      chainName: 'Polygon',
      successCount: 1,
      revertedCount: 1,
      errorCount: 1,
      totalMerchantWei: 100n,
      totalFeeWei: 1n,
      totalSaleWei: 110n,
      totalNetworkFeeWei: 3n,
      unknownBreakdownCount: 0,
    });
    expect(chain.byToken.get(TOKEN.toLowerCase())?.successCount).toBe(1);
  });

  it('旧 log (feeBreakdownVersion が 1 以上の数値でない) は手数料を足さず unknownBreakdownCount に数える', () => {
    const agg = aggregatePaymentLog([
      entry({ feeBreakdownVersion: undefined, feeAmount: '9' }),
      entry({ feeBreakdownVersion: 0, feeAmount: '9' }),
      entry({ feeBreakdownVersion: 2, feeAmount: '5' }),
    ]);
    expect(agg.chains[0].totalFeeWei).toBe(5n);
    expect(agg.chains[0].unknownBreakdownCount).toBe(2);
  });

  it('saleAmount 無しは着金額で代替・networkFeeEquivalent 無しは circlePaymasterNetUsdc を使う', () => {
    const agg = aggregatePaymentLog([
      entry({ merchantAmount: '100', circlePaymasterNetUsdc: '7' }),
      entry({ merchantAmount: '100', saleAmount: '', networkFeeEquivalent: 'x', circlePaymasterNetUsdc: '7' }),
    ]);
    expect(agg.chains[0].totalSaleWei).toBe(100n);
    expect(agg.chains[0].totalNetworkFeeWei).toBe(7n);
  });

  it('standard-fee は success のときだけ merchantAmount を手数料に足し、件数・GMV・provider には入れない', () => {
    const agg = aggregatePaymentLog([
      entry({ flow: 'standard-merchant', merchantAmount: '1000', feeAmount: undefined }),
      entry({ flow: 'standard-fee', merchantAmount: '5', provider: 'pimlico' }),
      entry({ flow: 'standard-fee', result: 'reverted', merchantAmount: '5' }),
    ]);
    expect(agg.aggregatedCount).toBe(3);
    expect(agg.chains[0]).toMatchObject({ successCount: 1, revertedCount: 0, totalMerchantWei: 1000n, totalFeeWei: 5n });
    expect(agg.byProvider.map((p) => [p.provider, p.successCount])).toEqual([['unknown', 1]]);
  });

  it('cross-chain success は (bridge・chainId・小文字の txHash / gateway の spec hash) で dedup し、着金額は chain から外して bridge に残す', () => {
    const agg = aggregatePaymentLog([
      entry({ bridge: 'cctp-v2', txHash: '0xAA', merchantAmount: '10', bridgeFeeMax: '2' }),
      entry({ bridge: 'cctp-v2', txHash: '0xaa', merchantAmount: '99' }),
      entry({ bridge: 'cctp-v2', txHash: '0xaa', result: 'reverted' }),
      entry({ bridge: 'gateway', gatewayTransferSpecHash: '0xS', txHash: '0x1', merchantAmount: '20' }),
      entry({ bridge: 'gateway', gatewayTransferSpecHash: '0xs', txHash: '0x2', merchantAmount: '99' }),
      entry({ bridge: 'gateway', chainId: 8453, gatewayTransferSpecHash: '0xs', merchantAmount: '30' }),
    ]);
    expect(agg.crossChainDeduped).toBe(2);
    expect(agg.aggregatedCount).toBe(4);
    const polygon = agg.chains.find((c) => c.chainId === 137)!;
    expect(polygon).toMatchObject({ successCount: 2, revertedCount: 1, totalMerchantWei: 0n, totalSaleWei: 30n, totalBridgeFeeMaxWei: 2n });
    expect(agg.byBridge.map((b) => [b.bridge, b.successCount, b.totalMerchantWei])).toEqual([
      ['gateway', 2, 50n],
      ['cctp-v2', 1, 10n],
    ]);
  });

  it('集計できない entry は invalidEntries に数えて飛ばす', () => {
    const agg = aggregatePaymentLog([entry({ result: 'pending' }), entry({ chainId: undefined }), entry()]);
    expect(agg.invalidEntries).toBe(2);
    expect(agg.aggregatedCount).toBe(1);
  });

  it('JSON の null 行も投げずに invalidEntries に数え、残りの集計は null が無いときと同じ', () => {
    const odd = [null, 42, 'x', []] as unknown as PaymentLogStatsEntry[];
    const good = [entry(), entry({ chainId: 8453, result: 'reverted' })];
    const agg = aggregatePaymentLog([odd[0], good[0], odd[1], odd[2], good[1], odd[3], odd[0]]);
    expect(agg).toEqual({ ...aggregatePaymentLog(good), invalidEntries: 5 });
  });

  it('chain は success 降順・同数は chainId 昇順、bridge と provider は固定順', () => {
    const agg = aggregatePaymentLog([
      entry({ chainId: 8453, bridge: 'mystery', provider: 'circle' }),
      entry({ chainId: 8217, bridge: 'cctp-v2', provider: 'pimlico' }),
      entry({ chainId: 42161, result: 'error' }),
      entry({ chainId: 10, bridge: 'gateway' }),
      entry({ chainId: 10 }),
    ]);
    expect(agg.chains.map((c) => c.chainId)).toEqual([10, 8217, 8453, 42161]);
    expect(agg.byBridge.map((b) => b.bridge)).toEqual(['direct', 'gateway', 'cctp-v2', 'unknown']);
    expect(agg.byProvider.map((p) => p.provider)).toEqual(['pimlico', 'circle', 'unknown']);
  });

  it('circle の申告額は success だけを足す', () => {
    const agg = aggregatePaymentLog([
      entry({ provider: 'circle', circlePaymasterNetUsdc: '100' }),
      entry({ provider: 'circle', circlePaymasterNetUsdc: '200', result: 'reverted' }),
      entry({ provider: 'pimlico', circlePaymasterNetUsdc: '400' }),
    ]);
    expect(agg.byProvider.map((p) => [p.provider, p.circleNetUsdcReported])).toEqual([
      ['pimlico', 0n],
      ['circle', 100n],
    ]);
  });

  it('呼び出しごとに状態を持たない (同じ入力で同じ結果)', () => {
    const input = [entry({ bridge: 'cctp-v2', txHash: '0x1' })];
    expect(aggregatePaymentLog(input)).toEqual(aggregatePaymentLog(input));
    expect(aggregatePaymentLog(input).crossChainDeduped).toBe(0);
  });
});

describe('serialize*', () => {
  it('bigint を 10 進の文字列にし、token は success 降順 (同数は現れた順)・chain の bridge は固定順で並べる', () => {
    const agg = aggregatePaymentLog([
      entry({ tokenAddress: '0xB', result: 'reverted' }),
      entry({ tokenAddress: '0xA', bridge: 'gateway', merchantAmount: '9'.repeat(78), saleAmount: '1' }),
      entry({ tokenAddress: '0xB' }),
      entry({ tokenAddress: '0xC' }),
      entry({ tokenAddress: '0xC' }),
    ]);
    const [chain] = serializeChains(agg.chains);
    expect(chain.byToken.map((t) => [t.tokenAddress, t.successCount])).toEqual([
      ['0xc', 2],
      ['0xb', 1],
      ['0xa', 1],
    ]);
    expect(chain.byBridge.map((b) => b.bridge)).toEqual(['direct', 'gateway']);
    expect(chain.byBridge[1].totalMerchantWei).toBe('9'.repeat(78));
    expect(chain.totalMerchantWei).toBe('300');
    expect(Object.keys(chain)).toEqual([
      'chainId', 'chainName', 'successCount', 'revertedCount', 'errorCount', 'totalMerchantWei', 'totalFeeWei',
      'totalSaleWei', 'totalNetworkFeeWei', 'totalBridgeFeeMaxWei', 'unknownBreakdownCount', 'byToken', 'byBridge',
    ]);
  });

  it('bridge と provider の key の並びと文字列化', () => {
    const agg = aggregatePaymentLog([entry({ provider: 'circle', circlePaymasterNetUsdc: '5', bridgeFeeMax: '3' })]);
    expect(serializeBridges(agg.byBridge)).toEqual([
      { bridge: 'direct', successCount: 1, revertedCount: 0, errorCount: 0, totalMerchantWei: '100', totalFeeWei: '1', totalSaleWei: '100', totalNetworkFeeWei: '5', totalBridgeFeeMaxWei: '3' },
    ]);
    expect(Object.keys(serializeBridges(agg.byBridge)[0])).toEqual([
      'bridge', 'successCount', 'revertedCount', 'errorCount', 'totalMerchantWei', 'totalFeeWei', 'totalSaleWei',
      'totalNetworkFeeWei', 'totalBridgeFeeMaxWei',
    ]);
    expect(serializeProviders(agg.byProvider)).toEqual([
      { provider: 'circle', successCount: 1, revertedCount: 0, errorCount: 0, circleNetUsdcReported: '5' },
    ]);
    expect(Object.keys(serializeProviders(agg.byProvider)[0])).toEqual([
      'provider', 'successCount', 'revertedCount', 'errorCount', 'circleNetUsdcReported',
    ]);
  });

  it('空配列はそのまま空', () => {
    expect(serializeChains([])).toEqual([]);
    expect(serializeBridges([])).toEqual([]);
    expect(serializeProviders([])).toEqual([]);
  });
});
