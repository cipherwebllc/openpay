import { describe, it, expect } from 'vitest';
import { entryYenValue, roundYen } from '@/lib/historyYen';
import type { HistoryEntry } from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 4,
    id: 'id',
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000000', // 1000 JPYC
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '0',
    txHash: '0xTx',
    userOpHash: null,
    blockNumber: '1',
    errorMessage: null,
    storeName: '',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: '1000000000000000000000',
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

describe('roundYen', () => {
  it('round-half-up・NaN/Infinity → 0', () => {
    expect(roundYen(1000.4)).toBe(1000);
    expect(roundYen(1000.5)).toBe(1001);
    expect(roundYen(Number.NaN)).toBe(0);
    expect(roundYen(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('entryYenValue', () => {
  it('(a) JPYC は 1:1 exact (レート無関係)', () => {
    expect(entryYenValue(entry(), undefined)).toEqual({ kind: 'exact', yen: 1000 });
  });

  it('(a) JPYC の端数は round (1000.4 → 1000)', () => {
    const r = entryYenValue(
      entry({ merchantAmount: '1000400000000000000000' }),
      150,
    );
    expect(r).toEqual({ kind: 'exact', yen: 1000 });
  });

  it('(b) USDC + JPYC anchor は anchorAmount で exact・レート非依存', () => {
    const r = entryYenValue(
      entry({
        asset: 'usdc',
        merchantAmount: '6400000', // 6.4 USDC (受領額)
        anchorAmount: '1500',
        anchorSymbol: 'jpyc',
      }),
      undefined, // レート無しでも anchor で exact
    );
    expect(r).toEqual({ kind: 'exact', yen: 1500 });
  });

  it('(c) USDC・anchor 無し + レート有 → approx (現レート換算)', () => {
    const r = entryYenValue(
      entry({ asset: 'usdc', merchantAmount: '6400000', anchorAmount: null }),
      156.32,
    );
    // 6.4 * 156.32 = 1000.448 → round 1000
    expect(r).toEqual({ kind: 'approx', yen: 1000, rate: 156.32 });
  });

  it('(c′) USDC・anchor 無し + レート無 → unavailable', () => {
    expect(
      entryYenValue(
        entry({ asset: 'usdc', merchantAmount: '6400000', anchorAmount: null }),
        undefined,
      ),
    ).toEqual({ kind: 'unavailable' });
    // レートが 0 や負も unavailable
    expect(
      entryYenValue(
        entry({ asset: 'usdc', merchantAmount: '6400000', anchorAmount: null }),
        0,
      ),
    ).toEqual({ kind: 'unavailable' });
  });

  it('非数値 merchantAmount はガード (0 円・throw しない)', () => {
    expect(entryYenValue(entry({ merchantAmount: 'xxx' }), 150)).toEqual({
      kind: 'exact',
      yen: 0,
    });
  });

  // REM-22: 壊れた anchorAmount ("1,000"/""/"abc") は path(b) exact にしない
  // (silent ¥0 の確定売上を防ぐ)。レート有りなら approx・無しなら unavailable へ降格。
  describe('(b) anchorAmount の数値検証 (壊れた値は exact にしない)', () => {
    const broken = (anchorAmount: string) =>
      entry({
        asset: 'usdc',
        merchantAmount: '6400000', // 6.4 USDC
        anchorAmount,
        anchorSymbol: 'jpyc',
      });

    it.each(['1,000', '', 'abc', ' 1000', '1.2.3'])(
      'anchorAmount=%j + レート有 → exact でなく approx (path(c) 降格)',
      (bad) => {
        const r = entryYenValue(broken(bad), 156.32);
        expect(r.kind).toBe('approx');
        // 6.4 * 156.32 = 1000.448 → round 1000
        expect(r).toEqual({ kind: 'approx', yen: 1000, rate: 156.32 });
      },
    );

    it.each(['1,000', '', 'abc'])(
      'anchorAmount=%j + レート無 → exact でなく unavailable',
      (bad) => {
        expect(entryYenValue(broken(bad), undefined)).toEqual({
          kind: 'unavailable',
        });
      },
    );

    it('正常な anchorAmount ("1000" / "1234.56") は従来どおり exact', () => {
      expect(entryYenValue(broken('1000'), undefined)).toEqual({
        kind: 'exact',
        yen: 1000,
      });
      expect(entryYenValue(broken('1234.56'), undefined)).toEqual({
        kind: 'exact',
        yen: 1235, // round-half-up
      });
    });
  });
});
