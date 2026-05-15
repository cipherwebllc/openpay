import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  calcBreakdown,
  calcDirectBreakdown,
  calcFee,
  calcSplitBreakdown,
} from '@/lib/fee';

describe('calcFee', () => {
  describe('USDC (6 decimals, 1.0% 純プロポーショナル)', () => {
    it('amount = 0 returns 0', () => {
      expect(calcFee(0n, 'usdc')).toBe(0n);
    });

    it('negative amount returns 0 (defensive guard)', () => {
      expect(calcFee(-1n, 'usdc')).toBe(0n);
    });

    it('1 USDC: fee = 0.01 USDC (= 1.0%)', () => {
      expect(calcFee(1_000_000n, 'usdc')).toBe(10_000n);
    });

    it('5 USDC: fee = 0.05 USDC', () => {
      expect(calcFee(5_000_000n, 'usdc')).toBe(50_000n);
    });

    it('100 USDC: fee = 1.0 USDC', () => {
      expect(calcFee(100_000_000n, 'usdc')).toBe(1_000_000n);
    });

    it('rounds down (integer division)', () => {
      // 100.0001 USDC -> 1.000001 USDC fee
      expect(calcFee(100_000_100n, 'usdc')).toBe(1_000_001n);
    });

    it('極小 amount で proportional が 0 になる境界 (< 100 wei)', () => {
      // 99 wei USDC × 100 / 10000 = 0 (整数除算で消える)
      expect(calcFee(99n, 'usdc')).toBe(0n);
      // 100 wei = 0.0001 USDC × 1% = 1 wei
      expect(calcFee(100n, 'usdc')).toBe(1n);
    });

    it('handles very large amounts without overflow', () => {
      const big = 10n ** 18n;
      expect(calcFee(big, 'usdc')).toBe((big * 100n) / 10_000n);
    });
  });

  describe('JPYC (18 decimals, 1.0% 純プロポーショナル)', () => {
    const ONE = 10n ** 18n;

    it('50 JPYC: fee = 0.5 JPYC', () => {
      expect(calcFee(50n * ONE, 'jpyc')).toBe((50n * ONE) / 100n);
    });

    it('100 JPYC: fee = 1 JPYC', () => {
      expect(calcFee(100n * ONE, 'jpyc')).toBe(ONE);
    });

    it('500 JPYC: fee = 5 JPYC', () => {
      expect(calcFee(500n * ONE, 'jpyc')).toBe(5n * ONE);
    });

    it('10000 JPYC: fee = 100 JPYC', () => {
      expect(calcFee(10000n * ONE, 'jpyc')).toBe(100n * ONE);
    });

    it('極小 amount で proportional が 0 になる境界 (< 100 wei)', () => {
      expect(calcFee(99n, 'jpyc')).toBe(0n);
      expect(calcFee(100n, 'jpyc')).toBe(1n);
    });
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

  it('USDC 1, gas=0: fee=0.01, merchant=0.99, customer=1', () => {
    const r = calcBreakdown(1_000_000n, 'usdc');
    expect(r.customerPays).toBe(1_000_000n);
    expect(r.merchantReceives).toBe(990_000n);
    expect(r.feeAmount).toBe(10_000n);
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

  it('JPYC 100, gas=2: merchant=99, fee=1, customer=102', () => {
    const ONE = 10n ** 18n;
    const r = calcBreakdown(100n * ONE, 'jpyc', 'customer', 2n * ONE);
    expect(r.customerPays).toBe(102n * ONE);
    expect(r.merchantReceives).toBe(99n * ONE);
    expect(r.feeAmount).toBe(ONE);
  });

  it('amount = 99 wei (proportional が 0): fee=0, merchant=amount (underflow なし)', () => {
    const r = calcBreakdown(99n, 'usdc');
    expect(r.feeAmount).toBe(0n);
    expect(r.merchantReceives).toBe(99n);
    expect(r.customerPays).toBe(99n);
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

  it('USDC 1, gas=0.5: customer=1, merchant=0.49 (1.0 - 0.01 fee - 0.5 gas)', () => {
    const r = calcBreakdown(1_000_000n, 'usdc', 'merchant', 500_000n);
    expect(r.merchantReceives).toBe(490_000n);
  });

  it('境界: amount = fee + gas → merchant = 0', () => {
    // fee = 1% × amount、amount = X、gas = G として、X - X*0.01 - G = 0 ⇔ X*0.99 = G
    // gas=500_000 wei に対して amount = 505_051 wei で merchant ≈ 0 (整数除算誤差含む)
    // ただし 100_000 wei × 1% = 1000 wei、merchant = 100_000 - 1000 - 500_000 < 0 → 0
    const r = calcBreakdown(100_000n, 'usdc', 'merchant', 500_000n);
    expect(r.merchantReceives).toBe(0n);
    expect(r.customerPays).toBe(100_000n);
  });

  it('underflow: amount < gas → merchant = 0 (gas が dominant)', () => {
    const r = calcBreakdown(100_000n, 'usdc', 'merchant', 500_000n);
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

  it('USDC 1, split B:50: distributable=0.99 (A と B が 0.495 ずつ)', () => {
    const r = calcSplitBreakdown(1_000_000n, 'usdc', A, [
      { to: B, percent: 50 },
    ]);
    expect(r.feeAmount).toBe(10_000n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(990_000n);
    expect(r.recipients[0].amount).toBe(495_000n);
    expect(r.recipients[1].amount).toBe(495_000n);
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

  it('underflow + split: 全 recipient が 0 (amount < gas)', () => {
    const r = calcSplitBreakdown(
      100_000n,
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
