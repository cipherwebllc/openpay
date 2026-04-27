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
      expect(calcFee(1_000_000n, 'usdc')).toBe(50_000n);
    });

    it('boundary where 1.0% == MIN: returns MIN', () => {
      expect(calcFee(4_999_999n, 'usdc')).toBe(50_000n);
      expect(calcFee(5_000_000n, 'usdc')).toBe(50_000n);
      expect(calcFee(5_000_100n, 'usdc')).toBe(50_001n);
    });

    it('1.0% > MIN: returns 1.0%', () => {
      expect(calcFee(100_000_000n, 'usdc')).toBe(1_000_000n);
    });

    it('rounds 1.0% down (integer division)', () => {
      expect(calcFee(100_000_100n, 'usdc')).toBe(1_000_001n);
    });

    it('handles very large amounts without overflow', () => {
      const big = 10n ** 18n;
      expect(calcFee(big, 'usdc')).toBe((big * 100n) / 10_000n);
    });
  });

  describe('JPYC (18 decimals, 1.0% / MIN_FEE = 5 JPYC)', () => {
    const ONE = 10n ** 18n;

    it('1% < MIN: returns MIN', () => {
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

describe('calcBreakdown — gas=customer mode (default)', () => {
  // 顧客がネットワーク手数料を負担。運営手数料は常に merchant 控除。
  // customer = amount + gas, merchant = amount - fee, op = fee

  it('USDC 100, gas=0: customer=100, merchant=99, fee=1.0', () => {
    const r = calcBreakdown(100_000_000n, 'usdc');
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(99_000_000n);
    expect(r.feeAmount).toBe(1_000_000n);
  });

  it('USDC 100, gas=0.5: customer=100.5, merchant=99, fee=1.0', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'customer', 500_000n);
    expect(r.customerPays).toBe(100_500_000n);
    expect(r.merchantReceives).toBe(99_000_000n);
    expect(r.feeAmount).toBe(1_000_000n);
  });

  it('USDC 1, gas=0: 1% < MIN → fee=0.05, merchant=0.95, customer=1', () => {
    const r = calcBreakdown(1_000_000n, 'usdc');
    expect(r.customerPays).toBe(1_000_000n);
    expect(r.merchantReceives).toBe(950_000n);
    expect(r.feeAmount).toBe(50_000n);
  });

  it('amount = 0: all zero', () => {
    const r = calcBreakdown(0n, 'usdc');
    expect(r.customerPays).toBe(0n);
    expect(r.merchantReceives).toBe(0n);
    expect(r.feeAmount).toBe(0n);
  });

  it('JPYC 1000, gas=0: merchant=990, fee=10, customer=1000', () => {
    const ONE = 10n ** 18n;
    const r = calcBreakdown(1000n * ONE, 'jpyc');
    expect(r.customerPays).toBe(1000n * ONE);
    expect(r.merchantReceives).toBe(990n * ONE);
    expect(r.feeAmount).toBe(10n * ONE);
  });

  it('JPYC 100, gas=2: merchant=95, fee=5 (MIN), customer=102', () => {
    const ONE = 10n ** 18n;
    const r = calcBreakdown(100n * ONE, 'jpyc', 'customer', 2n * ONE);
    expect(r.customerPays).toBe(102n * ONE);
    expect(r.merchantReceives).toBe(95n * ONE);
    expect(r.feeAmount).toBe(5n * ONE);
  });

  it('underflow: amount < fee → merchant = 0 (フロア)', () => {
    const r = calcBreakdown(30_000n, 'usdc');
    expect(r.merchantReceives).toBe(0n);
    expect(r.feeAmount).toBe(50_000n);
  });
});

describe('calcBreakdown — gas=merchant mode (店主吸収)', () => {
  // 店主がネットワーク手数料も吸収。customer = amount, merchant = amount - fee - gas

  it('USDC 100, gas=0.5: customer=100, merchant=98.5, fee=1.0', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'merchant', 500_000n);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(98_500_000n);
    expect(r.feeAmount).toBe(1_000_000n);
  });

  it('USDC 100, gas=0 (gas 未確定時): customer=100, merchant=99', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'merchant', 0n);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(99_000_000n);
  });

  it('USDC 1, gas=0.5: customer=1, merchant=0.45 (1.0 - 0.05 - 0.5)', () => {
    const r = calcBreakdown(1_000_000n, 'usdc', 'merchant', 500_000n);
    expect(r.merchantReceives).toBe(450_000n);
  });

  it('境界: amount = fee + gas → merchant = 0', () => {
    const r = calcBreakdown(550_000n, 'usdc', 'merchant', 500_000n);
    expect(r.merchantReceives).toBe(0n);
    expect(r.customerPays).toBe(550_000n);
  });

  it('underflow: amount < fee + gas → merchant = 0 (フロア)', () => {
    const r = calcBreakdown(300_000n, 'usdc', 'merchant', 500_000n);
    expect(r.merchantReceives).toBe(0n);
  });

  it('JPYC 1000, gas=2: customer=1000, merchant=988', () => {
    const ONE = 10n ** 18n;
    const r = calcBreakdown(1000n * ONE, 'jpyc', 'merchant', 2n * ONE);
    expect(r.customerPays).toBe(1000n * ONE);
    expect(r.merchantReceives).toBe(988n * ONE);
  });

  it('amount = 0: 全部 0', () => {
    const r = calcBreakdown(0n, 'usdc', 'merchant', 100_000n);
    expect(r.customerPays).toBe(0n);
    expect(r.merchantReceives).toBe(0n);
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
});

describe('calcSplitBreakdown — gas=customer (default)', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';
  const C: Address = '0x3333333333333333333333333333333333333333';

  it('USDC 100, split B:50, gas=0: distributable = 99 (amount - fee), A=49.5, B=49.5', () => {
    const r = calcSplitBreakdown(100_000_000n, 'usdc', A, [
      { to: B, percent: 50 },
    ]);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.feeAmount).toBe(1_000_000n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(99_000_000n);
    expect(r.recipients[0].amount).toBe(49_500_000n);
    expect(r.recipients[1].amount).toBe(49_500_000n);
  });

  it('USDC 100, split B:30/C:20, gas=0.5: customer=100.5, distributable=99', () => {
    const r = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [
        { to: B, percent: 30 },
        { to: C, percent: 20 },
      ],
      'customer',
      500_000n,
    );
    expect(r.customerPays).toBe(100_500_000n);
    expect(r.feeAmount).toBe(1_000_000n);
    expect(r.recipients[0]).toEqual({ to: A, percent: 50, amount: 49_500_000n });
    expect(r.recipients[1]).toEqual({ to: B, percent: 30, amount: 29_700_000n });
    expect(r.recipients[2]).toEqual({ to: C, percent: 20, amount: 19_800_000n });
  });

  it('JPYC 1000, split B:50: distributable=990 (1000-10 fee)', () => {
    const ONE = 10n ** 18n;
    const r = calcSplitBreakdown(1000n * ONE, 'jpyc', A, [
      { to: B, percent: 50 },
    ]);
    expect(r.feeAmount).toBe(10n * ONE);
    expect(r.recipients[0].amount).toBe(495n * ONE);
    expect(r.recipients[1].amount).toBe(495n * ONE);
  });

  it('amount = 0: customer も recipients も 0', () => {
    const r = calcSplitBreakdown(0n, 'usdc', A, [{ to: B, percent: 50 }]);
    expect(r.customerPays).toBe(0n);
    expect(r.recipients[0].amount).toBe(0n);
    expect(r.recipients[1].amount).toBe(0n);
  });

  it('split 3 件: distributable = amount - fee 全体を比率配分', () => {
    const C2 = '0x4444444444444444444444444444444444444444' as Address;
    const r = calcSplitBreakdown(100_000_000n, 'usdc', A, [
      { to: B, percent: 10 },
      { to: C, percent: 20 },
      { to: C2, percent: 30 },
    ]);
    expect(r.recipients).toHaveLength(4);
    expect(r.recipients[0].percent).toBe(40);
    const sum = r.recipients.reduce((s, x) => s + x.amount, 0n);
    expect(sum).toBe(99_000_000n);
  });
});

describe('calcSplitBreakdown — gas=merchant', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';

  it('USDC 100, split B:50, gas=0.5: distributable = 98.5, A=49.25, B=49.25', () => {
    const r = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [{ to: B, percent: 50 }],
      'merchant',
      500_000n,
    );
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.feeAmount).toBe(1_000_000n);
    expect(r.recipients[1].amount).toBe(49_250_000n);
    expect(r.recipients[0].amount).toBe(49_250_000n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(98_500_000n);
  });

  it('underflow + split: 全 recipient が 0', () => {
    const r = calcSplitBreakdown(
      300_000n,
      'usdc',
      A,
      [{ to: B, percent: 50 }],
      'merchant',
      500_000n,
    );
    expect(r.recipients[0].amount).toBe(0n);
    expect(r.recipients[1].amount).toBe(0n);
  });
});
