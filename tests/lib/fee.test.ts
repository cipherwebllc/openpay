import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  calcBreakdown,
  calcDirectBreakdown,
  calcFee,
  calcSplitBreakdown,
} from '@/lib/fee';
import type { TokenSymbol } from '@/lib/tokens';

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

// 不変条件 (invariant) を多数のサンプルで一斉検証。
// プロパティベースではなく、決定的なサンプル集合で:
//   - bigint の境界
//   - 整数除算の端数
//   - 両 token / 両 gasMode の対称性
//   - 大数 (ETH-scale)
// を網羅する。実 calcFee/calcBreakdown/calcSplitBreakdown を走らせて検証。
describe('fee invariants (両 token・両 gasMode 横断)', () => {
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

  describe('calcFee', () => {
    it.each(SAMPLES)('$label: fee <= amount (fee は元本を超えない)', ({ amount, token }) => {
      const fee = calcFee(amount, token);
      expect(fee <= (amount > 0n ? amount : 0n)).toBe(true);
    });

    it.each(SAMPLES)('$label: fee >= 0 (負にならない)', ({ amount, token }) => {
      expect(calcFee(amount, token)).toBeGreaterThanOrEqual(0n);
    });

    it.each(SAMPLES)('$label: token 不可知 (同 amount で usdc/jpyc が同値)', ({ amount }) => {
      // 現状は両 token 同一料率 1.0%。token 引数は API 互換のため温存しているが、
      // 実挙動は同じであることをロックする (将来 token 別レートに分岐する際は本 test が早期警告)。
      expect(calcFee(amount, 'usdc')).toBe(calcFee(amount, 'jpyc'));
    });

    it('単調増加: a < b ⇒ calcFee(a) ≤ calcFee(b)', () => {
      const xs = [0n, 1n, 99n, 100n, 1_000n, 1_000_000n, 100_000_000n, 10n ** 18n];
      for (let i = 1; i < xs.length; i++) {
        expect(calcFee(xs[i], 'usdc')).toBeGreaterThanOrEqual(calcFee(xs[i - 1], 'usdc'));
      }
    });
  });

  describe('calcBreakdown', () => {
    // amount = 0 の場合 calcBreakdown は merchantReceives / customerPays を全 0 で返すため
    // 「customerPays = amount + gas」式は成立しない (gas > 0 でも 0 になる)。
    // 該当条件は別 test (`amount = 0: all zero`) で既にカバー済のため、本不変条件
    // からは amount > 0 のサンプルのみを対象とする。
    const NONZERO_AMOUNTS = SAMPLES.filter((s) => s.amount > 0n);

    it.each(NONZERO_AMOUNTS)('$label / customer: customerPays === amount + gas', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'customer', s.gas);
      expect(r.customerPays).toBe(s.amount + s.gas);
    });

    it.each(SAMPLES)('$label / merchant: customerPays === amount (gas 上乗せなし)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'merchant', s.gas);
      expect(r.customerPays).toBe(s.amount > 0n ? s.amount : 0n);
    });

    it.each(SAMPLES)('$label / customer: merchantReceives = max(0, amount - fee)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'customer', s.gas);
      const fee = calcFee(s.amount, s.token);
      const expected = s.amount > fee ? s.amount - fee : 0n;
      expect(r.merchantReceives).toBe(expected);
    });

    it.each(SAMPLES)('$label / merchant: merchantReceives = max(0, amount - fee - gas)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'merchant', s.gas);
      const fee = calcFee(s.amount, s.token);
      const deduction = fee + s.gas;
      const expected = s.amount > deduction ? s.amount - deduction : 0n;
      expect(r.merchantReceives).toBe(expected);
    });

    it.each(SAMPLES)('$label: feeAmount === calcFee(amount, token) (一貫した抽出)', (s) => {
      const r = calcBreakdown(s.amount, s.token, 'customer', s.gas);
      expect(r.feeAmount).toBe(calcFee(s.amount, s.token));
    });

    it.each(NONZERO_AMOUNTS)('$label: gas=0 で gasMode customer/merchant の merchant 受取は一致', (s) => {
      const c = calcBreakdown(s.amount, s.token, 'customer', 0n);
      const m = calcBreakdown(s.amount, s.token, 'merchant', 0n);
      expect(c.merchantReceives).toBe(m.merchantReceives);
    });
  });

  describe('calcSplitBreakdown', () => {
    // amount を必ず 1% > 0 になるサイズ (>= 100 wei) に絞る
    const NONZERO_SAMPLES = SAMPLES.filter((s) => s.amount >= 100n);

    it.each(NONZERO_SAMPLES)('$label: 全 recipient amount の合計 === merchant 受取', (s) => {
      const r = calcSplitBreakdown(
        s.amount,
        s.token,
        A,
        [
          { to: B, percent: 30 },
          { to: C, percent: 20 },
        ],
        'customer',
        s.gas,
      );
      const base = calcBreakdown(s.amount, s.token, 'customer', s.gas);
      const sum = r.recipients.reduce((acc, x) => acc + x.amount, 0n);
      expect(sum).toBe(base.merchantReceives);
    });

    it.each(NONZERO_SAMPLES)('$label: feeAmount は calcBreakdown と一致', (s) => {
      const r = calcSplitBreakdown(s.amount, s.token, A, [{ to: B, percent: 50 }]);
      const base = calcBreakdown(s.amount, s.token);
      expect(r.feeAmount).toBe(base.feeAmount);
    });

    it.each(NONZERO_SAMPLES)('$label: primary は残余を必ず引き受ける (端数集約)', (s) => {
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
        'merchant',
        s.gas,
      );
      const base = calcBreakdown(s.amount, s.token, 'merchant', s.gas);
      const sum = r.recipients.reduce((acc, x) => acc + x.amount, 0n);
      expect(sum).toBe(base.merchantReceives);
    });
  });

  describe('calcDirectBreakdown', () => {
    it.each(SAMPLES)('$label: customer === merchant === amount, fee=0', (s) => {
      const r = calcDirectBreakdown(s.amount);
      const expected = s.amount > 0n ? s.amount : 0n;
      expect(r.customerPays).toBe(expected);
      expect(r.merchantReceives).toBe(expected);
      expect(r.feeAmount).toBe(0n);
    });
  });
});
