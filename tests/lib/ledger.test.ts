import { describe, it, expect } from 'vitest';
import {
  buildLedger,
  applyLedgerFilters,
  ledgerDirectionCounts,
  ledgerAssetCounts,
} from '@/lib/ledger';
import { EMPTY_HISTORY_FILTERS, type HistoryFilters } from '@/lib/historyFilters';
import type { HistoryEntry } from '@/lib/history';
import type { PayerReceipt, PayerReceiptStatus } from '@/lib/payerReceipt';

// 必要なフィールドだけ満たす最小ファクトリ (ledger は一部フィールドのみ読む)。
function hist(o: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h1',
    ts: 1000,
    flow: 'batch',
    status: 'success',
    asset: 'jpyc',
    merchant: '0xMerchant',
    merchantAmount: '1000',
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '0',
    storeName: '',
    note: '',
    txHash: '0xhhhh',
    ...o,
  } as HistoryEntry;
}

function rcpt(o: Partial<PayerReceipt> = {}): PayerReceipt {
  return {
    schemaVersion: 1,
    receiptId: 'r1',
    createdAt: '2026-06-01T00:00:00.000Z',
    direction: 'paid',
    kind: 'payment_receipt',
    status: 'confirmed',
    tokenSymbol: 'JPYC',
    amount: '500',
    currency: 'JPYC',
    merchantAddress: '0xShopAddr',
    ...o,
  } as PayerReceipt;
}

const filters = (o: Partial<HistoryFilters> = {}): HistoryFilters => ({
  ...EMPTY_HISTORY_FILTERS,
  ...o,
});

describe('buildLedger', () => {
  it('history は in、payerReceipt は out。新しい順 (ts 降順) に並ぶ', () => {
    const ledger = buildLedger(
      [hist({ id: 'h1', ts: 1000 })],
      [rcpt({ receiptId: 'r1', paidAt: '2026-06-02T00:00:00.000Z' })], // ts 大
    );
    expect(ledger.map((l) => l.direction)).toEqual(['out', 'in']); // out が新しい
    expect(ledger[0].kind).toBe('paid');
    expect(ledger[1].kind).toBe('received');
    // 原本を保持。
    expect(ledger[1].received?.id).toBe('h1');
    expect(ledger[0].paid?.receiptId).toBe('r1');
  });

  it('tokenSymbol を asset へ正規化 (JPYC/USDC→小文字・他は null)', () => {
    const ledger = buildLedger(
      [],
      [
        rcpt({ receiptId: 'a', tokenSymbol: 'JPYC' }),
        rcpt({ receiptId: 'b', tokenSymbol: 'usdc' }),
        rcpt({ receiptId: 'c', tokenSymbol: 'WBTC' }),
      ],
    );
    const byId = Object.fromEntries(ledger.map((l) => [l.paid?.receiptId, l.asset]));
    expect(byId.a).toBe('jpyc');
    expect(byId.b).toBe('usdc');
    expect(byId.c).toBeNull();
  });

  it.each<[PayerReceiptStatus, string]>([
    ['confirmed', 'success'],
    ['pending', 'pending'],
    ['failed', 'reverted'],
    ['unknown', 'pending'], // unknown は error でなく pending に倒す
  ])('payerReceipt status %s → PaymentResult %s', (input, expected) => {
    const ledger = buildLedger([], [rcpt({ status: input })]);
    expect(ledger[0].status).toBe(expected);
  });

  it('不正/欠落な日付は ts=0 (NaN を漏らさない)', () => {
    const ledger = buildLedger(
      [],
      [
        rcpt({ receiptId: 'bad', createdAt: 'not-a-date', paidAt: undefined }),
      ],
    );
    expect(ledger[0].ts).toBe(0);
    expect(Number.isNaN(ledger[0].ts)).toBe(false);
  });

  it('同一 tx が received と paid 両方にあっても両方表示 (dedup しない・意図的)', () => {
    const ledger = buildLedger(
      [hist({ id: 'x', txHash: '0xsame' })],
      [rcpt({ receiptId: '0xsame', txHash: '0xsame' })],
    );
    expect(ledger).toHaveLength(2);
    expect(ledger.filter((l) => l.direction === 'in')).toHaveLength(1);
    expect(ledger.filter((l) => l.direction === 'out')).toHaveLength(1);
  });
});

describe('applyLedgerFilters', () => {
  const ledger = buildLedger(
    [
      hist({ id: 'h1', ts: 5000, asset: 'jpyc', status: 'success', merchant: '0xAlice' }),
      hist({ id: 'h2', ts: 4000, asset: 'usdc', status: 'reverted', merchant: '0xBob' }),
    ],
    [
      rcpt({ receiptId: 'r1', paidAt: '2026-06-01T00:00:00.000Z', tokenSymbol: 'JPYC', status: 'confirmed', merchantName: 'Coffee Shop' }),
    ],
  );

  it('direction フィルタ', () => {
    expect(applyLedgerFilters(ledger, filters({ direction: 'in' })).every((l) => l.direction === 'in')).toBe(true);
    expect(applyLedgerFilters(ledger, filters({ direction: 'out' })).map((l) => l.kind)).toEqual(['paid']);
    expect(applyLedgerFilters(ledger, filters({ direction: 'all' }))).toHaveLength(3);
  });

  it('asset フィルタ (受取/支払い横断)', () => {
    const jpyc = applyLedgerFilters(ledger, filters({ asset: 'jpyc' }));
    // h1 (in/jpyc) + r1 (out/jpyc)
    expect(jpyc).toHaveLength(2);
    expect(jpyc.every((l) => l.asset === 'jpyc')).toBe(true);
  });

  it('status フィルタ (正規化後の PaymentResult 空間)', () => {
    expect(applyLedgerFilters(ledger, filters({ status: 'reverted' })).map((l) => l.received?.id)).toEqual(['h2']);
    // confirmed→success: h1 (in) + r1 (out)
    expect(applyLedgerFilters(ledger, filters({ status: 'success' }))).toHaveLength(2);
  });

  it('期間フィルタ (ts 境界)', () => {
    // h1 ts=5000 のみ
    expect(applyLedgerFilters(ledger, filters({ fromTs: 4500, toTs: 6000 })).map((l) => l.received?.id)).toEqual(['h1']);
  });

  it('検索 (paid は merchantName も対象)', () => {
    const r = applyLedgerFilters(ledger, filters({ search: 'coffee' }));
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('paid');
  });

  it('複数フィルタは AND 合成', () => {
    // direction=in かつ asset=usdc → h2 のみ
    const r = applyLedgerFilters(ledger, filters({ direction: 'in', asset: 'usdc' }));
    expect(r.map((l) => l.received?.id)).toEqual(['h2']);
  });
});

describe('件数ヘルパ', () => {
  const ledger = buildLedger(
    [hist({ id: 'h1', asset: 'jpyc' }), hist({ id: 'h2', asset: 'usdc' })],
    [rcpt({ receiptId: 'r1', tokenSymbol: 'JPYC' })],
  );

  it('ledgerDirectionCounts', () => {
    expect(ledgerDirectionCounts(ledger)).toEqual({ all: 3, in: 2, out: 1 });
  });

  it('ledgerAssetCounts (受取+支払い両方)', () => {
    expect(ledgerAssetCounts(ledger)).toEqual({ all: 3, jpyc: 2, usdc: 1 });
  });
});
