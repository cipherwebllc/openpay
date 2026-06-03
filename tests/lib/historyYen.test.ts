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
});
