import { describe, it, expect } from 'vitest';
import {
  applyHistoryFilters,
  historyEntrySearchText,
  isIncomeSaleEntry,
  summarizeHistory,
  dayRangeToTsBounds,
  monthBounds,
  currentMonthKey,
  previousMonthKey,
  EMPTY_HISTORY_FILTERS,
  type HistoryFilters,
} from '@/lib/historyFilters';
import type { HistoryEntry } from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 4,
    id: Math.random().toString(36),
    ts: new Date(2026, 5, 15, 12, 0, 0).getTime(), // 2026-06-15 12:00 local
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xAAA1',
    merchantAmount: '1000000000000000000000',
    customer: '0xBBB2',
    feeReceiver: '0xFee',
    feeAmount: '0',
    txHash: '0xdeadbeef',
    userOpHash: null,
    blockNumber: '1',
    errorMessage: null,
    storeName: '',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: null,
    networkFeeEquivalent: null,
    feeBreakdownVersion: 1,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: null,
    lineItems: null,
    ...overrides,
  };
}

const F = (o: Partial<HistoryFilters>): HistoryFilters => ({
  ...EMPTY_HISTORY_FILTERS,
  ...o,
});

describe('applyHistoryFilters', () => {
  const entries = [
    entry({ id: 'a', asset: 'jpyc', status: 'success' }),
    entry({ id: 'b', asset: 'usdc', status: 'error', note: 'refund test' }),
    entry({ id: 'c', asset: 'usdc', status: 'success', customer: '0xCAFE' }),
  ];

  it('asset フィルタ', () => {
    expect(applyHistoryFilters(entries, F({ asset: 'usdc' })).map((e) => e.id)).toEqual(['b', 'c']);
  });
  it('status フィルタ', () => {
    expect(applyHistoryFilters(entries, F({ status: 'success' })).map((e) => e.id)).toEqual(['a', 'c']);
  });
  it('検索 (大小無視・customer/note/txHash 等を部分一致)', () => {
    expect(applyHistoryFilters(entries, F({ search: 'cafe' })).map((e) => e.id)).toEqual(['c']);
    expect(applyHistoryFilters(entries, F({ search: 'REFUND' })).map((e) => e.id)).toEqual(['b']);
    expect(applyHistoryFilters(entries, F({ search: '0xdead' })).length).toBe(3); // 共通 txHash
  });
  it('空白検索は素通り', () => {
    expect(applyHistoryFilters(entries, F({ search: '   ' })).length).toBe(3);
  });
  it('AND 合成 (usdc かつ success)', () => {
    expect(
      applyHistoryFilters(entries, F({ asset: 'usdc', status: 'success' })).map((e) => e.id),
    ).toEqual(['c']);
  });
  it('日付境界は両端 inclusive (ローカル)', () => {
    const e = entry({ id: 'x', ts: new Date(2026, 5, 15, 12, 0).getTime() });
    const sameDay = dayRangeToTsBounds('2026-06-15', '2026-06-15');
    expect(applyHistoryFilters([e], F(sameDay)).length).toBe(1);
    const nextDay = dayRangeToTsBounds('2026-06-16', '2026-06-16');
    expect(applyHistoryFilters([e], F(nextDay)).length).toBe(0);
  });
});

describe('isIncomeSaleEntry', () => {
  it.each(['batch', 'direct', 'standard-merchant'] as const)('success × %s → true', (flow) => {
    expect(isIncomeSaleEntry(entry({ flow, status: 'success' }))).toBe(true);
  });
  it('success × standard-fee → false (手数料は売上でない)', () => {
    expect(isIncomeSaleEntry(entry({ flow: 'standard-fee', status: 'success' }))).toBe(false);
  });
  it.each(['reverted', 'error', 'pending'] as const)('%s → false', (status) => {
    expect(isIncomeSaleEntry(entry({ status }))).toBe(false);
  });
});

describe('summarizeHistory', () => {
  it('店舗負担手数料の JPYC 売上は saleAmount (gross)、standard-fee leg は GMV 除外', () => {
    const sale = entry({
      merchantAmount: '990000000000000000000',
      saleAmount: '1000000000000000000000',
    });
    const fee = entry({
      flow: 'standard-fee',
      merchantAmount: '10000000000000000000',
      saleAmount: null,
    });
    const s = summarizeHistory([sale, fee], undefined);
    expect(s.gmvYen).toBe(1000);
    expect(s.tokenTotals.jpyc).toBe('990000000000000000000');
  });

  it('counts は全体・tokenTotals/GMV は income-sale のみ', () => {
    const entries = [
      entry({ asset: 'jpyc', status: 'success', merchantAmount: '1000000000000000000000' }), // +1000円
      entry({
        asset: 'usdc',
        status: 'success',
        merchantAmount: '6400000',
        anchorAmount: '1500',
        anchorSymbol: 'jpyc',
      }), // +1500円 (anchor exact)
      entry({ status: 'reverted' }), // 集計対象外
      entry({ flow: 'standard-fee', status: 'success' }), // 売上でない
    ];
    const s = summarizeHistory(entries, 150);
    expect(s.counts).toEqual({ success: 3, reverted: 1, error: 0, pending: 0, total: 4 });
    expect(s.tokenTotals.jpyc).toBe('1000000000000000000000');
    expect(s.tokenTotals.usdc).toBe('6400000');
    expect(s.gmvYen).toBe(2500);
    expect(s.gmvHasApprox).toBe(false);
    expect(s.gmvUnavailableCount).toBe(0);
  });

  it('approx 行があれば gmvHasApprox=true', () => {
    const s = summarizeHistory(
      [entry({ asset: 'usdc', merchantAmount: '6400000', anchorAmount: null })],
      150,
    );
    expect(s.gmvYen).toBe(960); // 6.4*150
    expect(s.gmvHasApprox).toBe(true);
  });

  it('評価不能 (USDC 無 anchor・レート無) があれば gmvYen=null', () => {
    const s = summarizeHistory(
      [
        entry({ asset: 'jpyc', merchantAmount: '1000000000000000000000' }),
        entry({ asset: 'usdc', merchantAmount: '6400000', anchorAmount: null }),
      ],
      undefined,
    );
    expect(s.gmvYen).toBeNull();
    expect(s.gmvUnavailableCount).toBe(1);
    // token 合計は維持される
    expect(s.tokenTotals.jpyc).toBe('1000000000000000000000');
  });
});

describe('日付 helper', () => {
  it('monthBounds: 2026-06 は 6/1 00:00 〜 6/30 23:59:59.999', () => {
    const { fromTs, toTs } = monthBounds('2026-06');
    expect(fromTs).toBe(new Date(2026, 5, 1, 0, 0, 0, 0).getTime());
    expect(toTs).toBe(new Date(2026, 5, 30, 23, 59, 59, 999).getTime());
  });
  it('monthBounds: YYYY-MM 形式に合致しない入力は当月へ防御フォールバック', () => {
    // 呼出側はプリセットからしか渡さない前提の保険 (regex 不一致のみが対象)。
    const fallback = monthBounds(currentMonthKey(new Date()));
    expect(monthBounds('garbage')).toEqual(fallback);
    expect(monthBounds('')).toEqual(fallback);
    expect(monthBounds('2026/06')).toEqual(fallback); // 区切りが '-' でない
  });
  it('currentMonthKey / previousMonthKey (1月→前年12月 rollover)', () => {
    expect(currentMonthKey(new Date(2026, 5, 15))).toBe('2026-06');
    expect(previousMonthKey(new Date(2026, 0, 15))).toBe('2025-12');
    expect(previousMonthKey(new Date(2026, 5, 15))).toBe('2026-05');
  });
  it('dayRangeToTsBounds: null は境界なし', () => {
    expect(dayRangeToTsBounds(null, null)).toEqual({ fromTs: null, toTs: null });
  });
});

describe('検索 (v5 記帳補助メタも対象)', () => {
  it('商品名 / メモ / 管理番号 / 明細名 でヒットする', () => {
    const a = entry({
      id: 'a',
      productName: '抹茶ラテ',
      memo: '物販',
      receiptNo: 'R-777',
      lineItems: [
        {
          name: '限定Tシャツ',
          quantity: 1,
          unitPrice: '3000',
          amount: '3000',
          taxRate: 10,
          taxCategory: 'taxable_10',
          memo: null,
        },
      ],
    });
    const b = entry({ id: 'b' });
    const list = [a, b];
    const f = (q: string) =>
      applyHistoryFilters(list, { ...EMPTY_HISTORY_FILTERS, search: q }).map(
        (x) => x.id,
      );
    expect(f('抹茶')).toEqual(['a']);
    expect(f('物販')).toEqual(['a']);
    expect(f('R-777')).toEqual(['a']);
    expect(f('限定T')).toEqual(['a']);
    expect(f('zzz')).toEqual([]);
  });
});

// 検索 haystack を組み立てる純関数。lib/ledger の受取行検索と共有 (ドリフト防止)。
describe('historyEntrySearchText', () => {
  it('全フィールドを小文字で連結 (merchant/customer/storeName/note/txHash/商品名/メモ/管理番号/明細名)', () => {
    const e = entry({
      merchant: '0xMERCHANT',
      customer: '0xCUST',
      storeName: 'CAFE Mocha',
      note: 'REFUND',
      txHash: '0xDEAD',
      productName: '抹茶ラテ',
      memo: '物販',
      receiptNo: 'R-777',
      lineItems: [
        {
          name: 'ケーキ',
          quantity: 1,
          unitPrice: '500',
          amount: '500',
          taxRate: 8,
          taxCategory: 'taxable_8',
          memo: null,
        },
        {
          name: 'コーヒー',
          quantity: 2,
          unitPrice: '300',
          amount: '600',
          taxRate: 8,
          taxCategory: 'taxable_8',
          memo: null,
        },
      ],
    });
    const hay = historyEntrySearchText(e);
    // 出力は完全に小文字化されている (大文字 ASCII が残らない)。
    expect(hay).toBe(hay.toLowerCase());
    // 各フィールドが含まれる (明細名は join で全件)。
    for (const needle of [
      '0xmerchant',
      '0xcust',
      'cafe mocha',
      'refund',
      '0xdead',
      '抹茶ラテ',
      '物販',
      'r-777',
      'ケーキ',
      'コーヒー',
    ]) {
      expect(hay).toContain(needle);
    }
  });

  it('nullable 欠落フィールドは "null"/"undefined" 文字列を混入させない (?? "" フォールバック)', () => {
    const e = entry({
      merchant: '0xAAA1',
      customer: null,
      storeName: '',
      note: '',
      txHash: null,
      productName: null,
      memo: null,
      receiptNo: null,
      lineItems: null,
    });
    const hay = historyEntrySearchText(e);
    expect(hay).not.toContain('null');
    expect(hay).not.toContain('undefined');
    expect(hay).toContain('0xaaa1');
  });

  it('lineItems が null/未定義でも例外を投げず空 join で続行する', () => {
    expect(() => historyEntrySearchText(entry({ lineItems: null }))).not.toThrow();
    expect(() =>
      historyEntrySearchText(entry({ lineItems: undefined })),
    ).not.toThrow();
  });

  it('applyHistoryFilters と同一の文字列を使う (フィルタとの一貫性)', () => {
    // フィルタが haystack に含まれる語でヒットし、含まれない語ではヒットしない。
    const e = entry({ id: 'x', productName: 'ホットサンド' });
    const hay = historyEntrySearchText(e);
    expect(hay.includes('ホットサンド')).toBe(true);
    expect(
      applyHistoryFilters([e], F({ search: 'ホットサンド' })).map((x) => x.id),
    ).toEqual(['x']);
  });
});
