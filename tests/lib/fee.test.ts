import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  calcBreakdown,
  calcDirectBreakdown,
  calcFee,
  calcSplitBreakdown,
  MIN_FEE,
} from '@/lib/fee';

describe('calcFee', () => {
  describe('USDC (6 decimals, 1.0% / MIN_FEE = 50_000 = 0.05 USDC)', () => {
    it('amount = 0 returns 0', () => {
      expect(calcFee(0n, 'usdc')).toBe(0n);
    });

    it('negative amount returns 0 (defensive guard)', () => {
      expect(calcFee(-1n, 'usdc')).toBe(0n);
    });

    it('1.0% < MIN: returns MIN', () => {
      // 1 USDC: 1.0% = 10_000 (< MIN 50_000)
      expect(calcFee(1_000_000n, 'usdc')).toBe(50_000n);
    });

    it('boundary where 1.0% == MIN: returns MIN', () => {
      // 1.0% == 0.05 USDC となる境界 = 5 USDC
      // 4_999_999 wei: 4_999_999 * 100 / 10_000 = 49_999 (< MIN) → MIN
      expect(calcFee(4_999_999n, 'usdc')).toBe(50_000n);
      // 5_000_000 wei: 1.0% = 50_000 (== MIN) → MIN
      expect(calcFee(5_000_000n, 'usdc')).toBe(50_000n);
      // 5_000_100 wei: 1.0% = 50_001 (> MIN) → proportional
      expect(calcFee(5_000_100n, 'usdc')).toBe(50_001n);
    });

    it('1.0% > MIN: returns 1.0%', () => {
      // 100 USDC: 1.0% = 1_000_000 (> MIN)
      expect(calcFee(100_000_000n, 'usdc')).toBe(1_000_000n);
    });

    it('rounds 1.0% down (integer division)', () => {
      // 100.0001 USDC: 1.0% = 100_000_100 * 100 / 10_000 = 1_000_001
      expect(calcFee(100_000_100n, 'usdc')).toBe(1_000_001n);
    });

    it('handles very large amounts without overflow', () => {
      const big = 10n ** 18n; // 10^12 USDC (absurd) — checks no JS number coercion
      expect(calcFee(big, 'usdc')).toBe((big * 100n) / 10_000n);
    });
  });

  describe('JPYC (18 decimals, 1.0% / MIN_FEE = 5 JPYC)', () => {
    const ONE = 10n ** 18n;

    it('1% < MIN: returns MIN', () => {
      // 100 JPYC: 1% = 1 JPYC (< MIN 5)
      expect(calcFee(100n * ONE, 'jpyc')).toBe(5n * ONE);
    });

    it('boundary 500 JPYC: 1% == MIN', () => {
      expect(calcFee(500n * ONE, 'jpyc')).toBe(5n * ONE);
    });

    it('10000 JPYC: 1% = 100 JPYC > MIN', () => {
      expect(calcFee(10000n * ONE, 'jpyc')).toBe(100n * ONE);
    });
  });

  it('MIN_FEE table is exported correctly', () => {
    expect(MIN_FEE.jpyc).toBe(5n * 10n ** 18n);
    expect(MIN_FEE.usdc).toBe(50_000n);
  });
});

describe('calcBreakdown (exclude 一本: customer = amount + fee, merchant = amount, op = fee)', () => {
  it('USDC 100: customer pays amount + fee, merchant gets full amount', () => {
    const r = calcBreakdown(100_000_000n /* 100 USDC */, 'usdc');
    expect(r.merchantReceives).toBe(100_000_000n);
    expect(r.feeAmount).toBe(1_000_000n); // 1.0 USDC
    expect(r.customerPays).toBe(101_000_000n);
    expect(r.merchantReceives + r.feeAmount).toBe(r.customerPays);
  });

  it('USDC 1: customer pays amount + MIN (1.0% < MIN)', () => {
    const r = calcBreakdown(1_000_000n, 'usdc');
    expect(r.merchantReceives).toBe(1_000_000n);
    expect(r.feeAmount).toBe(50_000n);
    expect(r.customerPays).toBe(1_050_000n);
  });

  it('amount = 0: all zero (no min fee on zero amount)', () => {
    const r = calcBreakdown(0n, 'usdc');
    expect(r.customerPays).toBe(0n);
    expect(r.merchantReceives).toBe(0n);
    expect(r.feeAmount).toBe(0n);
  });

  describe('JPYC breakdown', () => {
    const ONE = 10n ** 18n;

    it('1000 JPYC: 1% > MIN → fee = 10 JPYC, customer = 1010', () => {
      const r = calcBreakdown(1000n * ONE, 'jpyc');
      expect(r.merchantReceives).toBe(1000n * ONE);
      expect(r.feeAmount).toBe(10n * ONE);
      expect(r.customerPays).toBe(1010n * ONE);
    });

    it('100 JPYC: 1% < MIN → fee = 5 JPYC, customer = 105', () => {
      const r = calcBreakdown(100n * ONE, 'jpyc');
      expect(r.merchantReceives).toBe(100n * ONE);
      expect(r.feeAmount).toBe(5n * ONE);
      expect(r.customerPays).toBe(105n * ONE);
    });
  });
});

describe('calcDirectBreakdown (mode=direct)', () => {
  it('amount > 0: customer = merchant = amount, fee = 0', () => {
    const r = calcDirectBreakdown(100_000_000n);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(100_000_000n);
    expect(r.feeAmount).toBe(0n);
  });

  it('amount = 0: 全部 0', () => {
    const r = calcDirectBreakdown(0n);
    expect(r.customerPays).toBe(0n);
    expect(r.merchantReceives).toBe(0n);
    expect(r.feeAmount).toBe(0n);
  });

  it('negative amount: 0 にクランプ', () => {
    const r = calcDirectBreakdown(-1n);
    expect(r.customerPays).toBe(0n);
    expect(r.merchantReceives).toBe(0n);
  });

  it('JPYC でも USDC でも結果は amount に比例 (token を見ない)', () => {
    const big = 12345n * 10n ** 18n;
    const r = calcDirectBreakdown(big);
    expect(r.customerPays).toBe(big);
    expect(r.feeAmount).toBe(0n);
  });
});

describe('calcSplitBreakdown', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';
  const C: Address = '0x3333333333333333333333333333333333333333';

  it('USDC 100, split B:50 → A 50, B 50, customer pays 101', () => {
    // amount=100 USDC, fee = 1.0 USDC, customer pays 101, distributable = 100
    const r = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [{ to: B, percent: 50 }],
    );
    expect(r.feeAmount).toBe(1_000_000n);
    expect(r.customerPays).toBe(101_000_000n);
    expect(r.recipients).toEqual([
      { to: A, percent: 50, amount: 50_000_000n },
      { to: B, percent: 50, amount: 50_000_000n },
    ]);
  });

  it('USDC 100, split B:30/C:20 → primary 50% (50 USDC)', () => {
    // amount=100 USDC, fee = 1.0 USDC, distributable = 100 USDC (exclude semantics)
    // B = 100 * 30/100 = 30 USDC, C = 100 * 20/100 = 20 USDC, primary = 50 USDC
    const r = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [
        { to: B, percent: 30 },
        { to: C, percent: 20 },
      ],
    );
    expect(r.feeAmount).toBe(1_000_000n);
    expect(r.customerPays).toBe(101_000_000n);
    expect(r.recipients).toHaveLength(3);
    expect(r.recipients[0]).toEqual({ to: A, percent: 50, amount: 50_000_000n });
    expect(r.recipients[1]).toEqual({ to: B, percent: 30, amount: 30_000_000n });
    expect(r.recipients[2]).toEqual({ to: C, percent: 20, amount: 20_000_000n });
  });

  it('割り切れない端数は primary に集約', () => {
    // amount=10 USDC, fee = MIN 0.05 USDC, distributable = 10 USDC
    // B = 10 * 7/100 = 0.7, C = 10 * 11/100 = 1.1, primary = 10 - 0.7 - 1.1 = 8.2
    const r = calcSplitBreakdown(
      10_000_000n,
      'usdc',
      A,
      [
        { to: B, percent: 7 },
        { to: C, percent: 11 },
      ],
    );
    const sum = r.recipients.reduce((acc, x) => acc + x.amount, 0n);
    expect(sum).toBe(10_000_000n); // distributable = full amount (exclude)
    expect(r.recipients[0]).toEqual({ to: A, percent: 82, amount: 8_200_000n });
    expect(r.recipients[1]).toEqual({ to: B, percent: 7, amount: 700_000n });
    expect(r.recipients[2]).toEqual({ to: C, percent: 11, amount: 1_100_000n });
  });

  it('JPYC でも同じく動く', () => {
    // amount=1000 JPYC, fee = 10 JPYC (1% > MIN 5)
    // distributable = 1000, B 50%, A 50%
    const ONE = 10n ** 18n;
    const r = calcSplitBreakdown(
      1000n * ONE,
      'jpyc',
      A,
      [{ to: B, percent: 50 }],
    );
    expect(r.feeAmount).toBe(10n * ONE);
    expect(r.customerPays).toBe(1010n * ONE);
    expect(r.recipients[0].amount).toBe(500n * ONE);
    expect(r.recipients[1].amount).toBe(500n * ONE);
  });

  it('amount = 0: customer も recipients も 0', () => {
    const r = calcSplitBreakdown(0n, 'usdc', A, [
      { to: B, percent: 50 },
    ]);
    expect(r.customerPays).toBe(0n);
    expect(r.feeAmount).toBe(0n);
    expect(r.recipients[0].amount).toBe(0n);
    expect(r.recipients[1].amount).toBe(0n);
  });

  it('split 1 件 1% (極端): primary 99% で残余取得', () => {
    const r = calcSplitBreakdown(
      10_000_000n,
      'usdc',
      A,
      [{ to: B, percent: 1 }],
    );
    // amount=10 USDC, fee = 0.1 USDC (proportional > MIN 0.05)
    // distributable = 10 USDC, customer pays 10.1
    // B = 10 USDC * 1% = 100_000 (0.1 USDC), primary = 9.9 USDC
    expect(r.feeAmount).toBe(100_000n);
    expect(r.customerPays).toBe(10_100_000n);
    expect(r.recipients[0].percent).toBe(99);
    expect(r.recipients[0].amount).toBe(9_900_000n);
    expect(r.recipients[1].percent).toBe(1);
    expect(r.recipients[1].amount).toBe(100_000n);
  });

  it('split 3 件 (上限): すべての受取人に正しく配分', () => {
    const C2 = '0x4444444444444444444444444444444444444444' as Address;
    const r = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [
        { to: B, percent: 10 },
        { to: C, percent: 20 },
        { to: C2, percent: 30 },
      ],
    );
    expect(r.recipients).toHaveLength(4);
    expect(r.recipients[0].percent).toBe(40); // 100 - 10 - 20 - 30
    const sum = r.recipients.reduce((s, x) => s + x.amount, 0n);
    expect(sum).toBe(100_000_000n); // distributable = full amount (exclude)
  });

  it('巨大 amount (10^36) でも overflow せず比率配分が正しい', () => {
    const huge = 10n ** 36n;
    const r = calcSplitBreakdown(huge, 'usdc', A, [
      { to: B, percent: 50 },
    ]);
    expect(r.feeAmount).toBe((huge * 100n) / 10_000n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(huge);
    expect(r.recipients[1].amount).toBe(huge / 2n);
  });

  it('worst-case rounding: 100 wei amount + 99% split で primary は 1 wei', () => {
    // amount=100 wei, fee = MIN 50_000, distributable = 100 wei
    // B=99% → 99 wei, primary = 1 wei
    const r = calcSplitBreakdown(100n, 'usdc', A, [
      { to: B, percent: 99 },
    ]);
    expect(r.recipients[0].amount).toBe(1n);
    expect(r.recipients[1].amount).toBe(99n);
    expect(r.recipients[0].percent).toBe(1);
  });
});
