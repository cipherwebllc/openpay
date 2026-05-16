import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  calcBreakdown,
  calcFee,
  calcSplitBreakdown,
  FEE_BPS_GASLESS,
  FEE_BPS_STANDARD,
} from '@/lib/fee';
import type { TokenSymbol } from '@/lib/tokens';

describe('calcFee — gasless mode (1.0%)', () => {
  describe('USDC (6 decimals)', () => {
    it('amount = 0 returns 0', () => {
      expect(calcFee(0n, 'usdc', 'gasless')).toBe(0n);
    });

    it('negative amount returns 0 (defensive guard)', () => {
      expect(calcFee(-1n, 'usdc', 'gasless')).toBe(0n);
    });

    it('1 USDC: fee = 0.01 USDC (= 1.0%)', () => {
      expect(calcFee(1_000_000n, 'usdc', 'gasless')).toBe(10_000n);
    });

    it('5 USDC: fee = 0.05 USDC', () => {
      expect(calcFee(5_000_000n, 'usdc', 'gasless')).toBe(50_000n);
    });

    it('100 USDC: fee = 1.0 USDC', () => {
      expect(calcFee(100_000_000n, 'usdc', 'gasless')).toBe(1_000_000n);
    });

    it('rounds down (integer division)', () => {
      // 100.0001 USDC -> 1.000001 USDC fee
      expect(calcFee(100_000_100n, 'usdc', 'gasless')).toBe(1_000_001n);
    });

    it('極小 amount で proportional が 0 になる境界 (< 100 wei)', () => {
      // 99 wei USDC × 100 / 10000 = 0 (整数除算で消える)
      expect(calcFee(99n, 'usdc', 'gasless')).toBe(0n);
      // 100 wei = 0.0001 USDC × 1% = 1 wei
      expect(calcFee(100n, 'usdc', 'gasless')).toBe(1n);
    });

    it('handles very large amounts without overflow', () => {
      const big = 10n ** 18n;
      expect(calcFee(big, 'usdc', 'gasless')).toBe((big * 100n) / 10_000n);
    });
  });

  describe('JPYC (18 decimals)', () => {
    const ONE = 10n ** 18n;

    it('50 JPYC: fee = 0.5 JPYC', () => {
      expect(calcFee(50n * ONE, 'jpyc', 'gasless')).toBe((50n * ONE) / 100n);
    });

    it('100 JPYC: fee = 1 JPYC', () => {
      expect(calcFee(100n * ONE, 'jpyc', 'gasless')).toBe(ONE);
    });

    it('500 JPYC: fee = 5 JPYC', () => {
      expect(calcFee(500n * ONE, 'jpyc', 'gasless')).toBe(5n * ONE);
    });

    it('10000 JPYC: fee = 100 JPYC', () => {
      expect(calcFee(10000n * ONE, 'jpyc', 'gasless')).toBe(100n * ONE);
    });

    it('極小 amount で proportional が 0 になる境界 (< 100 wei)', () => {
      expect(calcFee(99n, 'jpyc', 'gasless')).toBe(0n);
      expect(calcFee(100n, 'jpyc', 'gasless')).toBe(1n);
    });
  });
});

describe('calcFee — standard mode (0.5%)', () => {
  const ONE_USDC = 1_000_000n;
  const ONE_JPYC = 10n ** 18n;

  it('amount = 0 returns 0', () => {
    expect(calcFee(0n, 'usdc', 'standard')).toBe(0n);
    expect(calcFee(0n, 'jpyc', 'standard')).toBe(0n);
  });

  it('USDC 100: fee = 0.5 USDC (0.5%)', () => {
    expect(calcFee(100n * ONE_USDC, 'usdc', 'standard')).toBe(ONE_USDC / 2n);
  });

  it('USDC 1000: fee = 5 USDC', () => {
    expect(calcFee(1000n * ONE_USDC, 'usdc', 'standard')).toBe(5n * ONE_USDC);
  });

  it('JPYC 1000: fee = 5 JPYC', () => {
    expect(calcFee(1000n * ONE_JPYC, 'jpyc', 'standard')).toBe(5n * ONE_JPYC);
  });

  it('JPYC 10000: fee = 50 JPYC', () => {
    expect(calcFee(10000n * ONE_JPYC, 'jpyc', 'standard')).toBe(50n * ONE_JPYC);
  });

  it('極小 amount で proportional が 0 になる境界 (standard は 50bps なので < 200 wei で 0)', () => {
    // 199 wei × 50 / 10000 = 0 (整数除算で消える)
    expect(calcFee(199n, 'usdc', 'standard')).toBe(0n);
    // 200 wei × 50 / 10000 = 1
    expect(calcFee(200n, 'usdc', 'standard')).toBe(1n);
  });

  it('standard fee は gasless fee のちょうど半額', () => {
    const amount = 12_345_678n;
    const gasless = calcFee(amount, 'usdc', 'gasless');
    const standard = calcFee(amount, 'usdc', 'standard');
    // gasless = 1.0%, standard = 0.5% なので standard*2 ≈ gasless (整数除算で同値か±1)
    expect(standard * 2n).toBe(gasless);
  });
});

describe('FEE_BPS_* 定数の妥当性', () => {
  it('FEE_BPS_GASLESS = 100n (= 1.0%)', () => {
    expect(FEE_BPS_GASLESS).toBe(100n);
  });
  it('FEE_BPS_STANDARD = 50n (= 0.5%)', () => {
    expect(FEE_BPS_STANDARD).toBe(50n);
  });
  it('standard は gasless のちょうど半分', () => {
    expect(FEE_BPS_STANDARD * 2n).toBe(FEE_BPS_GASLESS);
  });
});

describe('calcBreakdown — gasless / gas=customer (default)', () => {
  // 顧客がネットワーク手数料を負担。OpenPay 利用手数料は常に merchant 控除。
  // customer = amount + gas, merchant = amount - fee, op = fee

  it('USDC 100, gas=0: customer=100, merchant=99, fee=1.0', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'gasless', 'customer', 0n);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(99_000_000n);
    expect(r.feeAmount).toBe(1_000_000n);
  });

  it('USDC 100, gas=0.5: customer=100.5, merchant=99, fee=1.0', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'gasless', 'customer', 500_000n);
    expect(r.customerPays).toBe(100_500_000n);
    expect(r.merchantReceives).toBe(99_000_000n);
    expect(r.feeAmount).toBe(1_000_000n);
  });

  it('USDC 1, gas=0: fee=0.01, merchant=0.99, customer=1', () => {
    const r = calcBreakdown(1_000_000n, 'usdc', 'gasless', 'customer', 0n);
    expect(r.customerPays).toBe(1_000_000n);
    expect(r.merchantReceives).toBe(990_000n);
    expect(r.feeAmount).toBe(10_000n);
  });

  it('amount = 0: all zero', () => {
    const r = calcBreakdown(0n, 'usdc', 'gasless', 'customer', 0n);
    expect(r.customerPays).toBe(0n);
    expect(r.merchantReceives).toBe(0n);
    expect(r.feeAmount).toBe(0n);
  });

  it('JPYC 1000, gas=0: merchant=990, fee=10, customer=1000', () => {
    const ONE = 10n ** 18n;
    const r = calcBreakdown(1000n * ONE, 'jpyc', 'gasless', 'customer', 0n);
    expect(r.customerPays).toBe(1000n * ONE);
    expect(r.merchantReceives).toBe(990n * ONE);
    expect(r.feeAmount).toBe(10n * ONE);
  });

  it('JPYC 100, gas=2: merchant=99, fee=1, customer=102', () => {
    const ONE = 10n ** 18n;
    const r = calcBreakdown(100n * ONE, 'jpyc', 'gasless', 'customer', 2n * ONE);
    expect(r.customerPays).toBe(102n * ONE);
    expect(r.merchantReceives).toBe(99n * ONE);
    expect(r.feeAmount).toBe(ONE);
  });

  it('amount = 99 wei (proportional が 0): fee=0, merchant=amount (underflow なし)', () => {
    const r = calcBreakdown(99n, 'usdc', 'gasless', 'customer', 0n);
    expect(r.feeAmount).toBe(0n);
    expect(r.merchantReceives).toBe(99n);
    expect(r.customerPays).toBe(99n);
  });

  it('default 引数: mode 省略時は gasless 扱い', () => {
    const r = calcBreakdown(100_000_000n, 'usdc');
    expect(r.feeAmount).toBe(1_000_000n);
    expect(r.merchantReceives).toBe(99_000_000n);
  });
});

describe('calcBreakdown — gasless / gas=merchant (店主吸収)', () => {
  // 店主がネットワーク手数料も吸収。customer = amount, merchant = amount - fee - gas

  it('USDC 100, gas=0.5: customer=100, merchant=98.5, fee=1.0', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'gasless', 'merchant', 500_000n);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(98_500_000n);
    expect(r.feeAmount).toBe(1_000_000n);
  });

  it('USDC 100, gas=0 (gas 未確定時): customer=100, merchant=99', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'gasless', 'merchant', 0n);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(99_000_000n);
  });

  it('USDC 1, gas=0.5: customer=1, merchant=0.49 (1.0 - 0.01 fee - 0.5 gas)', () => {
    const r = calcBreakdown(1_000_000n, 'usdc', 'gasless', 'merchant', 500_000n);
    expect(r.merchantReceives).toBe(490_000n);
  });

  it('境界: amount = fee + gas → merchant = 0', () => {
    // 100_000 wei × 1% = 1000 wei、merchant = 100_000 - 1000 - 500_000 < 0 → 0
    const r = calcBreakdown(100_000n, 'usdc', 'gasless', 'merchant', 500_000n);
    expect(r.merchantReceives).toBe(0n);
    expect(r.customerPays).toBe(100_000n);
  });

  it('underflow: amount < gas → merchant = 0 (gas が dominant)', () => {
    const r = calcBreakdown(100_000n, 'usdc', 'gasless', 'merchant', 500_000n);
    expect(r.merchantReceives).toBe(0n);
  });

  it('JPYC 1000, gas=2: customer=1000, merchant=988', () => {
    const ONE = 10n ** 18n;
    const r = calcBreakdown(1000n * ONE, 'jpyc', 'gasless', 'merchant', 2n * ONE);
    expect(r.customerPays).toBe(1000n * ONE);
    expect(r.merchantReceives).toBe(988n * ONE);
  });

  it('amount = 0: 全部 0', () => {
    const r = calcBreakdown(0n, 'usdc', 'gasless', 'merchant', 100_000n);
    expect(r.customerPays).toBe(0n);
    expect(r.merchantReceives).toBe(0n);
  });
});

describe('calcBreakdown — standard mode (顧客 wallet で gas 自前負担)', () => {
  // standard mode では gas を OpenPay の breakdown に乗せない。
  // customer = amount (wallet が gas を別建てで請求)、merchant = amount - fee (0.5%)
  // gasMode / gasAmount は無視される。

  it('USDC 100: customer=100, merchant=99.5, fee=0.5 (0.5%)', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'standard');
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(99_500_000n);
    expect(r.feeAmount).toBe(500_000n);
  });

  it('JPYC 1000: merchant=995, fee=5, customer=1000', () => {
    const ONE = 10n ** 18n;
    const r = calcBreakdown(1000n * ONE, 'jpyc', 'standard');
    expect(r.customerPays).toBe(1000n * ONE);
    expect(r.merchantReceives).toBe(995n * ONE);
    expect(r.feeAmount).toBe(5n * ONE);
  });

  it('gasMode / gasAmount は無視される (customer 指定でも gas を上乗せしない)', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'standard', 'customer', 500_000n);
    // customer は amount のみ。gasAmount は無視。
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(99_500_000n);
  });

  it('gasMode=merchant でも gas は merchant 控除に含めない (standard では gas に touch しない)', () => {
    const r = calcBreakdown(100_000_000n, 'usdc', 'standard', 'merchant', 500_000n);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.merchantReceives).toBe(99_500_000n);
  });

  it('amount = 0: all zero', () => {
    const r = calcBreakdown(0n, 'usdc', 'standard');
    expect(r.customerPays).toBe(0n);
    expect(r.merchantReceives).toBe(0n);
    expect(r.feeAmount).toBe(0n);
  });

  it('amount = 199 wei (standard 50bps proportional が 0): fee=0, merchant=amount', () => {
    const r = calcBreakdown(199n, 'usdc', 'standard');
    expect(r.feeAmount).toBe(0n);
    expect(r.merchantReceives).toBe(199n);
    expect(r.customerPays).toBe(199n);
  });

  it('negative amount: 0 にクランプ', () => {
    const r = calcBreakdown(-1n, 'usdc', 'standard');
    expect(r.customerPays).toBe(0n);
    expect(r.merchantReceives).toBe(0n);
    expect(r.feeAmount).toBe(0n);
  });
});

describe('calcSplitBreakdown — gasless / gas=customer (default)', () => {
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
      'gasless',
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

describe('calcSplitBreakdown — gasless / gas=merchant', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';

  it('USDC 100, split B:50, gas=0.5: distributable = 98.5, A=49.25, B=49.25', () => {
    const r = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [{ to: B, percent: 50 }],
      'gasless',
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
      'gasless',
      'merchant',
      500_000n,
    );
    expect(r.recipients[0].amount).toBe(0n);
    expect(r.recipients[1].amount).toBe(0n);
  });
});

describe('calcSplitBreakdown — standard mode', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';

  it('USDC 100, split B:50, standard: fee=0.5 (0.5%)、distributable=99.5、A=49.75, B=49.75', () => {
    const r = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [{ to: B, percent: 50 }],
      'standard',
    );
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.feeAmount).toBe(500_000n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(99_500_000n);
    expect(r.recipients[0].amount).toBe(49_750_000n);
    expect(r.recipients[1].amount).toBe(49_750_000n);
  });

  it('standard mode では gasMode / gasAmount は無視される', () => {
    const r1 = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [{ to: B, percent: 50 }],
      'standard',
      'customer',
      500_000n,
    );
    const r2 = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [{ to: B, percent: 50 }],
      'standard',
    );
    expect(r1.customerPays).toBe(r2.customerPays);
    expect(r1.recipients[0].amount).toBe(r2.recipients[0].amount);
    expect(r1.recipients[1].amount).toBe(r2.recipients[1].amount);
  });
});

// bigint の境界、整数除算の端数、両 token / 両 gasMode / 両 PayMode の対称性、大数 (ETH-scale)
// を 16 サンプル × 各 invariant で網羅。
describe('fee invariants (両 token・両 PayMode・両 gasMode 横断)', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';
  const C: Address = '0x3333333333333333333333333333333333333333';

  // 代表サンプル: USDC (6 decimals) と JPYC (18 decimals) の混在
  const SAMPLES: Array<{
    amount: bigint;
    token: TokenSymbol;
    gas: bigint;
    label: string;
  }> = [
    { amount: 0n, token: 'usdc', gas: 0n, label: 'USDC zero' },
    { amount: 1n, token: 'usdc', gas: 0n, label: 'USDC 1 wei (proportional=0)' },
    { amount: 99n, token: 'usdc', gas: 0n, label: 'USDC 99 wei (proportional=0 境界)' },
    { amount: 100n, token: 'usdc', gas: 0n, label: 'USDC 100 wei (proportional=1)' },
    { amount: 100_000n, token: 'usdc', gas: 0n, label: 'USDC 0.1' },
    { amount: 1_000_000n, token: 'usdc', gas: 0n, label: 'USDC 1' },
    { amount: 5_000_000n, token: 'usdc', gas: 0n, label: 'USDC 5' },
    { amount: 100_000_000n, token: 'usdc', gas: 0n, label: 'USDC 100' },
    { amount: 100_000_000n, token: 'usdc', gas: 300_000n, label: 'USDC 100 + gas 0.3' },
    { amount: 10_000_000_000n, token: 'usdc', gas: 0n, label: 'USDC 10000' },
    { amount: 0n, token: 'jpyc', gas: 0n, label: 'JPYC zero' },
    { amount: 1n, token: 'jpyc', gas: 0n, label: 'JPYC 1 wei' },
    { amount: 50n * 10n ** 18n, token: 'jpyc', gas: 5n * 10n ** 17n, label: 'JPYC 50 + gas 0.5' },
    { amount: 100n * 10n ** 18n, token: 'jpyc', gas: 2n * 10n ** 18n, label: 'JPYC 100 + gas 2' },
    { amount: 500n * 10n ** 18n, token: 'jpyc', gas: 0n, label: 'JPYC 500 (1%==旧 MIN 境界)' },
    { amount: 10000n * 10n ** 18n, token: 'jpyc', gas: 10n * 10n ** 18n, label: 'JPYC 10000 + gas 10' },
  ];

  describe('calcFee (gasless mode)', () => {
    it.each(SAMPLES)('$label: fee <= amount (fee は元本を超えない)', ({ amount, token }) => {
      const fee = calcFee(amount, token, 'gasless');
      expect(fee <= (amount > 0n ? amount : 0n)).toBe(true);
    });

    it.each(SAMPLES)('$label: fee >= 0 (負にならない)', ({ amount, token }) => {
      expect(calcFee(amount, token, 'gasless')).toBeGreaterThanOrEqual(0n);
    });

    it.each(SAMPLES)('$label: token 不可知 (同 amount で usdc/jpyc が同値)', ({ amount }) => {
      // 現状は両 token 同一料率。token 引数は API 互換のため温存しているが、
      // 実挙動は同じであることをロックする (将来 token 別レートに分岐する際は本 test が早期警告)。
      expect(calcFee(amount, 'usdc', 'gasless')).toBe(calcFee(amount, 'jpyc', 'gasless'));
    });

    it('単調増加: a < b ⇒ calcFee(a) ≤ calcFee(b)', () => {
      const xs = [0n, 1n, 99n, 100n, 1_000n, 1_000_000n, 100_000_000n, 10n ** 18n];
      for (let i = 1; i < xs.length; i++) {
        expect(calcFee(xs[i], 'usdc', 'gasless')).toBeGreaterThanOrEqual(
          calcFee(xs[i - 1], 'usdc', 'gasless'),
        );
      }
    });
  });

  describe('calcFee (standard mode)', () => {
    it.each(SAMPLES)('$label: standard fee <= gasless fee (常に半額以下)', ({ amount, token }) => {
      const g = calcFee(amount, token, 'gasless');
      const s = calcFee(amount, token, 'standard');
      expect(s).toBeLessThanOrEqual(g);
    });

    it.each(SAMPLES)('$label: standard fee >= 0', ({ amount, token }) => {
      expect(calcFee(amount, token, 'standard')).toBeGreaterThanOrEqual(0n);
    });
  });

  describe('calcBreakdown (gasless)', () => {
    // amount = 0 の場合 calcBreakdown は merchantReceives / customerPays を全 0 で返すため
    // 「customerPays = amount + gas」式は成立しない (gas > 0 でも 0 になる)。
    const NONZERO_AMOUNTS = SAMPLES.filter((s) => s.amount > 0n);

    it.each(NONZERO_AMOUNTS)('$label / customer: customerPays === amount + gas', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'gasless', 'customer', s.gas);
      expect(r.customerPays).toBe(s.amount + s.gas);
    });

    it.each(SAMPLES)('$label / merchant: customerPays === amount (gas 上乗せなし)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'gasless', 'merchant', s.gas);
      expect(r.customerPays).toBe(s.amount > 0n ? s.amount : 0n);
    });

    it.each(SAMPLES)('$label / customer: merchantReceives = max(0, amount - fee)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'gasless', 'customer', s.gas);
      const fee = calcFee(s.amount, s.token, 'gasless');
      const expected = s.amount > fee ? s.amount - fee : 0n;
      expect(r.merchantReceives).toBe(expected);
    });

    it.each(SAMPLES)('$label / merchant: merchantReceives = max(0, amount - fee - gas)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'gasless', 'merchant', s.gas);
      const fee = calcFee(s.amount, s.token, 'gasless');
      const deduction = fee + s.gas;
      const expected = s.amount > deduction ? s.amount - deduction : 0n;
      expect(r.merchantReceives).toBe(expected);
    });

    it.each(SAMPLES)('$label: feeAmount === calcFee(amount, token, gasless)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'gasless', 'customer', s.gas);
      expect(r.feeAmount).toBe(calcFee(s.amount, s.token, 'gasless'));
    });

    it.each(NONZERO_AMOUNTS)('$label: gas=0 で gasMode customer/merchant の merchant 受取は一致', (s) => {
      const c = calcBreakdown(s.amount, s.token, 'gasless', 'customer', 0n);
      const m = calcBreakdown(s.amount, s.token, 'gasless', 'merchant', 0n);
      expect(c.merchantReceives).toBe(m.merchantReceives);
    });
  });

  describe('calcBreakdown (standard)', () => {
    it.each(SAMPLES)('$label: standard / customerPays === amount (gas 上乗せなし)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'standard', 'customer', s.gas);
      expect(r.customerPays).toBe(s.amount > 0n ? s.amount : 0n);
    });

    it.each(SAMPLES)('$label: standard / merchantReceives = max(0, amount - fee_0.5%)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'standard', 'customer', s.gas);
      const fee = calcFee(s.amount, s.token, 'standard');
      const expected = s.amount > fee ? s.amount - fee : 0n;
      expect(r.merchantReceives).toBe(expected);
    });

    it.each(SAMPLES)('$label: standard / feeAmount === calcFee(amount, token, standard)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'standard', 'customer', s.gas);
      expect(r.feeAmount).toBe(calcFee(s.amount, s.token, 'standard'));
    });

    it.each(SAMPLES)('$label: standard では gasMode の値を変えても結果が同じ', (s) => {
      const c = calcBreakdown(s.amount, s.token, 'standard', 'customer', s.gas);
      const m = calcBreakdown(s.amount, s.token, 'standard', 'merchant', s.gas);
      expect(c.customerPays).toBe(m.customerPays);
      expect(c.merchantReceives).toBe(m.merchantReceives);
      expect(c.feeAmount).toBe(m.feeAmount);
    });
  });

  describe('calcSplitBreakdown', () => {
    // amount を必ず 1% > 0 になるサイズ (>= 100 wei) に絞る
    const NONZERO_SAMPLES = SAMPLES.filter((s) => s.amount >= 100n);

    it.each(NONZERO_SAMPLES)('$label (gasless): 全 recipient amount の合計 === merchant 受取', (s) => {
      const r = calcSplitBreakdown(
        s.amount,
        s.token,
        A,
        [
          { to: B, percent: 30 },
          { to: C, percent: 20 },
        ],
        'gasless',
        'customer',
        s.gas,
      );
      const base = calcBreakdown(s.amount, s.token, 'gasless', 'customer', s.gas);
      const sum = r.recipients.reduce((acc, x) => acc + x.amount, 0n);
      expect(sum).toBe(base.merchantReceives);
    });

    it.each(NONZERO_SAMPLES)('$label (gasless): feeAmount は calcBreakdown と一致', (s) => {
      const r = calcSplitBreakdown(s.amount, s.token, A, [{ to: B, percent: 50 }]);
      const base = calcBreakdown(s.amount, s.token);
      expect(r.feeAmount).toBe(base.feeAmount);
    });

    it.each(NONZERO_SAMPLES)('$label (gasless): primary は残余を必ず引き受ける (端数集約)', (s) => {
      // 33/33/33 のような整数除算の端数が出る split で primary が必ず非負
      const r = calcSplitBreakdown(s.amount, s.token, A, [
        { to: B, percent: 33 },
        { to: C, percent: 33 },
      ]);
      expect(r.recipients[0].percent).toBe(34); // 100 - 33 - 33
      expect(r.recipients[0].amount).toBeGreaterThanOrEqual(0n);
    });

    it.each(NONZERO_SAMPLES)('$label / merchant gas: 合計 === amount - fee - gas (underflow 時は 0)', (s) => {
      if (s.amount === 0n) return;
      const r = calcSplitBreakdown(
        s.amount,
        s.token,
        A,
        [{ to: B, percent: 50 }],
        'gasless',
        'merchant',
        s.gas,
      );
      const base = calcBreakdown(s.amount, s.token, 'gasless', 'merchant', s.gas);
      const sum = r.recipients.reduce((acc, x) => acc + x.amount, 0n);
      expect(sum).toBe(base.merchantReceives);
    });

    it.each(NONZERO_SAMPLES)('$label (standard): 全 recipient 合計 === amount - fee_0.5%', (s) => {
      const r = calcSplitBreakdown(
        s.amount,
        s.token,
        A,
        [{ to: B, percent: 50 }],
        'standard',
      );
      const base = calcBreakdown(s.amount, s.token, 'standard');
      const sum = r.recipients.reduce((acc, x) => acc + x.amount, 0n);
      expect(sum).toBe(base.merchantReceives);
    });
  });
});

// ---------------------------------------------------------------------------
// クロスモード不変条件 — gasless と standard の相対関係 / 経済的一貫性
// ---------------------------------------------------------------------------
describe('cross-mode invariants (gasless vs standard)', () => {
  // 大きめサンプル: 整数除算の粒度問題が起きない金額帯
  const SAMPLES_LARGE: Array<{ amount: bigint; token: TokenSymbol; label: string }> = [
    { amount: 1_000_000n, token: 'usdc', label: 'USDC 1' },
    { amount: 100_000_000n, token: 'usdc', label: 'USDC 100' },
    { amount: 100n * 10n ** 18n, token: 'jpyc', label: 'JPYC 100' },
    { amount: 10000n * 10n ** 18n, token: 'jpyc', label: 'JPYC 10000' },
  ];

  it.each(SAMPLES_LARGE)('$label: standard fee は gasless fee のちょうど半額', (s) => {
    const gasless = calcFee(s.amount, s.token, 'gasless');
    const standard = calcFee(s.amount, s.token, 'standard');
    expect(standard * 2n).toBe(gasless);
  });

  it.each(SAMPLES_LARGE)('$label: standard では merchant + operator = amount (gas 介在なし)', (s) => {
    const r = calcBreakdown(s.amount, s.token, 'standard');
    expect(r.merchantReceives + r.feeAmount).toBe(s.amount);
    expect(r.customerPays).toBe(s.amount);
  });

  it.each(SAMPLES_LARGE)('$label: gasless / customer では merchant + operator = amount (gas は customer 上乗せ)', (s) => {
    const r = calcBreakdown(s.amount, s.token, 'gasless', 'customer', 1000n);
    expect(r.merchantReceives + r.feeAmount).toBe(s.amount);
    expect(r.customerPays).toBe(s.amount + 1000n);
  });

  it.each(SAMPLES_LARGE)('$label: gasless / merchant では merchant + operator + gas = amount (店主吸収)', (s) => {
    const r = calcBreakdown(s.amount, s.token, 'gasless', 'merchant', 1000n);
    expect(r.merchantReceives + r.feeAmount + 1000n).toBe(s.amount);
    expect(r.customerPays).toBe(s.amount);
  });

  it.each(SAMPLES_LARGE)('$label: standard / gasMode を変えても結果は同一 (gas irrelevant)', (s) => {
    const c = calcBreakdown(s.amount, s.token, 'standard', 'customer', 9999n);
    const m = calcBreakdown(s.amount, s.token, 'standard', 'merchant', 9999n);
    expect(c).toEqual(m);
  });

  it.each(SAMPLES_LARGE)('$label: standard は gasless より merchant 取り分が多い (低い手数料)', (s) => {
    const gasless = calcBreakdown(s.amount, s.token, 'gasless');
    const standard = calcBreakdown(s.amount, s.token, 'standard');
    expect(standard.merchantReceives).toBeGreaterThan(gasless.merchantReceives);
  });

  // 整数除算境界: amount=199 wei は standard 0.5% で fee=0、gasless 1% で fee=1
  it('境界 199 wei: standard fee=0 / gasless fee=1 (整数除算の差異)', () => {
    expect(calcFee(199n, 'usdc', 'standard')).toBe(0n);
    expect(calcFee(199n, 'usdc', 'gasless')).toBe(1n);
  });

  // 境界 amount=99 wei: 両モードで fee=0
  it('境界 99 wei: 両モードで fee=0 (どちらも整数除算で潰れる)', () => {
    expect(calcFee(99n, 'usdc', 'standard')).toBe(0n);
    expect(calcFee(99n, 'usdc', 'gasless')).toBe(0n);
  });

  // 境界 amount=100 wei: gasless で fee=1、standard で fee=0
  it('境界 100 wei: gasless fee=1、standard fee=0', () => {
    expect(calcFee(100n, 'usdc', 'standard')).toBe(0n);
    expect(calcFee(100n, 'usdc', 'gasless')).toBe(1n);
  });

  it('split + standard: distributable は amount - fee (gas を一切控除しない)', () => {
    const A: Address = '0x1111111111111111111111111111111111111111';
    const B: Address = '0x2222222222222222222222222222222222222222';
    const r = calcSplitBreakdown(
      100_000_000n,
      'usdc',
      A,
      [{ to: B, percent: 50 }],
      'standard',
      'merchant', // ignored in standard
      999_999n, // ignored in standard
    );
    // standard: fee = 0.5 USDC, distributable = 99.5 USDC, 50/50 split
    expect(r.feeAmount).toBe(500_000n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(99_500_000n);
    expect(r.customerPays).toBe(100_000_000n); // gas 上乗せなし
  });

  it('split + standard で amount < fee (= 199 wei): merchant 全 0', () => {
    const A: Address = '0x1111111111111111111111111111111111111111';
    const B: Address = '0x2222222222222222222222222222222222222222';
    // 199 wei × 0.5% = 0 fee。merchant = 199, split 50% で primary 100, B 99
    // (端数は primary が引き受ける)
    const r = calcSplitBreakdown(
      199n,
      'usdc',
      A,
      [{ to: B, percent: 50 }],
      'standard',
    );
    expect(r.feeAmount).toBe(0n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(199n);
  });
});
