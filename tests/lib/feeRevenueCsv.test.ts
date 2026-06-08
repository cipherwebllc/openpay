import { describe, it, expect } from 'vitest';
import { toFeeRevenueCsv } from '@/lib/feeRevenueCsv';
import type { FeeRevenueEvent } from '@/lib/feeRevenue';
import { CSV_BOM } from '@/lib/csv';

const JPYC = 10n ** 18n;

function ev(over: Partial<FeeRevenueEvent> = {}): FeeRevenueEvent {
  return {
    m: '0xabc0000000000000000000000000000000000001',
    p: '2026-06',
    v: (100n * JPYC).toString(),
    c: 137,
    t: Date.UTC(2026, 6, 3), // 2026-07-03
    h: '0x' + 'a'.repeat(64),
    ...over,
  };
}

describe('toFeeRevenueCsv (収入の生データ CSV)', () => {
  it('BOM + ヘッダ + 1入金1行・金額はJPYC(=円1:1)・入金日UTC', () => {
    const csv = toFeeRevenueCsv([ev()]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toContain('入金日(UTC)');
    expect(csv).toContain('金額(JPYC)');
    // 100 JPYC = 100 (末尾0整理)・円換算も同値。
    expect(csv).toContain('100,100,');
    // 入金日は UTC の 2026-07-03。
    expect(csv).toContain('2026-07-03');
    // 対象期間・店主・txHash。
    expect(csv).toContain('2026-06');
    expect(csv).toContain('0xabc0000000000000000000000000000000000001');
  });

  it('複数行 + 0件 (ヘッダのみ)', () => {
    const two = toFeeRevenueCsv([ev(), ev({ v: (50n * JPYC).toString() })]);
    expect(two.split('\r\n').filter((l) => l.length > 0)).toHaveLength(3); // header + 2
    const empty = toFeeRevenueCsv([]);
    expect(empty).toContain('入金日(UTC)');
    expect(empty.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1); // header only
  });
});
