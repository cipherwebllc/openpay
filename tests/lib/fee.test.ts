import { describe, it, expect } from 'vitest';
import {
  calcBreakdown,
  calcDirectBreakdown,
  calcFee,
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
