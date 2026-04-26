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
  describe('USDC (6 decimals, MIN_FEE = 100_000 = 0.1 USDC)', () => {
    it('amount = 0 returns 0', () => {
      expect(calcFee(0n, 'usdc')).toBe(0n);
    });

    it('negative amount returns 0 (defensive guard)', () => {
      expect(calcFee(-1n, 'usdc')).toBe(0n);
    });

    it('1% < MIN: returns MIN', () => {
      // 1 USDC: 1% = 10_000 (< MIN 100_000)
      expect(calcFee(1_000_000n, 'usdc')).toBe(100_000n);
    });

    it('boundary where 1% == MIN: returns MIN', () => {
      // 10 USDC: 1% = 100_000 (== MIN)
      expect(calcFee(10_000_000n, 'usdc')).toBe(100_000n);
    });

    it('1% > MIN: returns 1%', () => {
      // 100 USDC: 1% = 1_000_000 (> MIN)
      expect(calcFee(100_000_000n, 'usdc')).toBe(1_000_000n);
    });

    it('rounds 1% down (integer division)', () => {
      // 10.0001 USDC: 1% = 100_001 → integer (100_001 * 100 / 10_000 = 100_001)
      expect(calcFee(10_000_100n, 'usdc')).toBe(100_001n);
    });

    it('handles very large amounts without overflow', () => {
      const big = 10n ** 18n; // 10^12 USDC (absurd) — checks no JS number coercion
      expect(calcFee(big, 'usdc')).toBe(big / 100n);
    });
  });

  describe('JPYC (18 decimals, MIN_FEE = 15 JPYC)', () => {
    const ONE = 10n ** 18n;

    it('1% < MIN: returns MIN', () => {
      // 1000 JPYC: 1% = 10 JPYC (< MIN 15)
      expect(calcFee(1000n * ONE, 'jpyc')).toBe(15n * ONE);
    });

    it('boundary 1500 JPYC: 1% == MIN', () => {
      expect(calcFee(1500n * ONE, 'jpyc')).toBe(15n * ONE);
    });

    it('10000 JPYC: 1% = 100 JPYC > MIN', () => {
      expect(calcFee(10000n * ONE, 'jpyc')).toBe(100n * ONE);
    });
  });

  it('MIN_FEE table is exported correctly', () => {
    expect(MIN_FEE.jpyc).toBe(15n * 10n ** 18n);
    expect(MIN_FEE.usdc).toBe(100_000n);
  });
});

describe('calcBreakdown', () => {
  describe('include mode (内税: 店主負担)', () => {
    it('amount > fee: customer pays amount, merchant gets amount - fee', () => {
      const r = calcBreakdown(100_000_000n /* 100 USDC */, 'include', 'usdc');
      expect(r.customerPays).toBe(100_000_000n);
      expect(r.feeAmount).toBe(1_000_000n); // 1 USDC
      expect(r.merchantReceives).toBe(99_000_000n); // 99 USDC
      // 整合性: merchant + fee == customer
      expect(r.merchantReceives + r.feeAmount).toBe(r.customerPays);
    });

    it('amount < MIN_FEE: merchant gets 0, all goes to fee', () => {
      // 0.05 USDC, fee floor = 0.1 USDC
      const r = calcBreakdown(50_000n, 'include', 'usdc');
      expect(r.customerPays).toBe(50_000n);
      expect(r.merchantReceives).toBe(0n);
      expect(r.feeAmount).toBe(50_000n);
    });

    it('amount == fee boundary: merchant gets 0', () => {
      const r = calcBreakdown(100_000n, 'include', 'usdc');
      expect(r.customerPays).toBe(100_000n);
      expect(r.merchantReceives).toBe(0n);
      expect(r.feeAmount).toBe(100_000n);
    });

    it('amount = 0: all zero', () => {
      const r = calcBreakdown(0n, 'include', 'usdc');
      expect(r.customerPays).toBe(0n);
      expect(r.merchantReceives).toBe(0n);
      expect(r.feeAmount).toBe(0n);
    });
  });

  describe('exclude mode (外税: 客負担)', () => {
    it('customer pays amount + fee, merchant gets full amount', () => {
      const r = calcBreakdown(100_000_000n /* 100 USDC */, 'exclude', 'usdc');
      expect(r.merchantReceives).toBe(100_000_000n);
      expect(r.feeAmount).toBe(1_000_000n);
      expect(r.customerPays).toBe(101_000_000n);
      expect(r.merchantReceives + r.feeAmount).toBe(r.customerPays);
    });

    it('amount below MIN: customer pays amount + MIN', () => {
      const r = calcBreakdown(50_000n, 'exclude', 'usdc');
      expect(r.merchantReceives).toBe(50_000n);
      expect(r.feeAmount).toBe(100_000n);
      expect(r.customerPays).toBe(150_000n);
    });

    it('amount = 0: all zero (no min fee on zero amount)', () => {
      const r = calcBreakdown(0n, 'exclude', 'usdc');
      expect(r.customerPays).toBe(0n);
      expect(r.merchantReceives).toBe(0n);
      expect(r.feeAmount).toBe(0n);
    });
  });

  describe('JPYC breakdown', () => {
    const ONE = 10n ** 18n;

    it('include: 1000 JPYC with floor fee', () => {
      const r = calcBreakdown(1000n * ONE, 'include', 'jpyc');
      expect(r.customerPays).toBe(1000n * ONE);
      expect(r.feeAmount).toBe(15n * ONE);
      expect(r.merchantReceives).toBe(985n * ONE);
    });

    it('exclude: 10000 JPYC with 1% fee', () => {
      const r = calcBreakdown(10000n * ONE, 'exclude', 'jpyc');
      expect(r.merchantReceives).toBe(10000n * ONE);
      expect(r.feeAmount).toBe(100n * ONE);
      expect(r.customerPays).toBe(10100n * ONE);
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

describe('calcSplitBreakdown (C1)', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';
  const C: Address = '0x3333333333333333333333333333333333333333';

  it('USDC 100, 内税, split B:30 / C:20 → primary 50% (49.5 USDC)', () => {
    // amount=100 USDC = 100_000_000, fee = 1% = 1_000_000
    // distributable = 99_000_000
    // B = 99_000_000 * 30/100 = 29_700_000
    // C = 99_000_000 * 20/100 = 19_800_000
    // primary (A) = 99_000_000 - 29_700_000 - 19_800_000 = 49_500_000
    const r = calcSplitBreakdown(
      100_000_000n,
      'include',
      'usdc',
      A,
      [
        { to: B, percent: 30 },
        { to: C, percent: 20 },
      ],
    );
    expect(r.feeAmount).toBe(1_000_000n);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.recipients).toHaveLength(3);
    expect(r.recipients[0]).toEqual({ to: A, percent: 50, amount: 49_500_000n });
    expect(r.recipients[1]).toEqual({ to: B, percent: 30, amount: 29_700_000n });
    expect(r.recipients[2]).toEqual({ to: C, percent: 20, amount: 19_800_000n });
  });

  it('USDC 100, 外税, split B:50 → A 50, B 50, customer pays 101', () => {
    // amount=100 USDC, fee = 1, customer pays 101, distributable to merchants = 100
    const r = calcSplitBreakdown(
      100_000_000n,
      'exclude',
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

  it('端数は primary に集約 (USDC 1, 内税, split B:33 → primary 67% で残り全部)', () => {
    // amount=1 USDC = 1_000_000, fee = MIN 100_000
    // distributable = 900_000
    // B = 900_000 * 33/100 = 297_000
    // primary = 900_000 - 297_000 = 603_000 (= 67% + 端数 0、ここでは整数で割れる)
    const r = calcSplitBreakdown(
      1_000_000n,
      'include',
      'usdc',
      A,
      [{ to: B, percent: 33 }],
    );
    expect(r.feeAmount).toBe(100_000n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(900_000n);
    expect(r.recipients[1].amount).toBe(297_000n);
    expect(r.recipients[0].amount).toBe(603_000n);
  });

  it('割り切れない端数も primary に集約', () => {
    // amount=10 USDC = 10_000_000, fee = MIN 100_000
    // distributable = 9_900_000
    // split B:7, C:11 → primary 82%
    // B = 9_900_000 * 7/100 = 693_000
    // C = 9_900_000 * 11/100 = 1_089_000
    // primary = 9_900_000 - 693_000 - 1_089_000 = 8_118_000
    const r = calcSplitBreakdown(
      10_000_000n,
      'include',
      'usdc',
      A,
      [
        { to: B, percent: 7 },
        { to: C, percent: 11 },
      ],
    );
    const sum = r.recipients.reduce((acc, x) => acc + x.amount, 0n);
    expect(sum).toBe(9_900_000n);
    expect(r.recipients[0]).toEqual({ to: A, percent: 82, amount: 8_118_000n });
    expect(r.recipients[1]).toEqual({ to: B, percent: 7, amount: 693_000n });
    expect(r.recipients[2]).toEqual({ to: C, percent: 11, amount: 1_089_000n });
  });

  it('JPYC でも同じく動く', () => {
    // amount=1000 JPYC = 1000 * 10^18, fee = 1% = 10 * 10^18 (== MIN_FEE 15 はもっと多い)
    // 1% = 10 JPYC, MIN = 15 JPYC → fee = 15 JPYC
    // distributable = 1000 - 15 = 985 JPYC
    const ONE = 10n ** 18n;
    const r = calcSplitBreakdown(
      1000n * ONE,
      'include',
      'jpyc',
      A,
      [{ to: B, percent: 50 }],
    );
    expect(r.feeAmount).toBe(15n * ONE);
    expect(r.customerPays).toBe(1000n * ONE);
    // distributable = 985 JPYC、半分ずつ
    // B = 985 * 50/100 = 492 (整数除算)、A は残り 493
    expect(r.recipients[1].amount).toBe(492n * ONE + ONE / 2n); // 492.5 JPYC
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(985n * ONE);
  });

  it('amount = 0: customer も recipients も 0', () => {
    const r = calcSplitBreakdown(0n, 'include', 'usdc', A, [
      { to: B, percent: 50 },
    ]);
    expect(r.customerPays).toBe(0n);
    expect(r.feeAmount).toBe(0n);
    expect(r.recipients[0].amount).toBe(0n);
    expect(r.recipients[1].amount).toBe(0n);
  });
});
