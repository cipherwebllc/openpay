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
  describe('USDC (6 decimals, 1.2% / MIN_FEE = 200_000 = 0.2 USDC)', () => {
    it('amount = 0 returns 0', () => {
      expect(calcFee(0n, 'usdc')).toBe(0n);
    });

    it('negative amount returns 0 (defensive guard)', () => {
      expect(calcFee(-1n, 'usdc')).toBe(0n);
    });

    it('1.2% < MIN: returns MIN', () => {
      // 1 USDC: 1.2% = 12_000 (< MIN 200_000)
      expect(calcFee(1_000_000n, 'usdc')).toBe(200_000n);
    });

    it('10 USDC でもまだフロア (1.2% = 120_000 < 200_000)', () => {
      expect(calcFee(10_000_000n, 'usdc')).toBe(200_000n);
    });

    it('boundary where 1.2% == MIN: returns MIN', () => {
      // 1.2% == 0.2 USDC となる境界 = 16.666... USDC
      // 16_666_666 wei: 16_666_666 * 120 / 10_000 = 199_999 (< MIN 200_000) → MIN
      expect(calcFee(16_666_666n, 'usdc')).toBe(200_000n);
      // 16_666_667 wei: 16_666_667 * 120 / 10_000 = 200_000 (== MIN) → MIN (== proportional)
      expect(calcFee(16_666_667n, 'usdc')).toBe(200_000n);
      // 16_666_750 wei: 16_666_750 * 120 / 10_000 = 200_001 (> MIN) → proportional
      expect(calcFee(16_666_750n, 'usdc')).toBe(200_001n);
    });

    it('1.2% > MIN: returns 1.2%', () => {
      // 100 USDC: 1.2% = 1_200_000 (> MIN)
      expect(calcFee(100_000_000n, 'usdc')).toBe(1_200_000n);
    });

    it('rounds 1.2% down (integer division)', () => {
      // 100.000083 USDC: 1.2% = 100_000_083 * 120 / 10_000 = 1_200_000 (端数切り捨て)
      expect(calcFee(100_000_083n, 'usdc')).toBe(1_200_000n);
      // 100.0001 USDC: 1.2% = 100_000_100 * 120 / 10_000 = 1_200_001 (端数あり)
      expect(calcFee(100_000_100n, 'usdc')).toBe(1_200_001n);
    });

    it('handles very large amounts without overflow', () => {
      const big = 10n ** 18n; // 10^12 USDC (absurd) — checks no JS number coercion
      expect(calcFee(big, 'usdc')).toBe((big * 120n) / 10_000n);
    });
  });

  describe('JPYC (18 decimals, 1.0% / MIN_FEE = 15 JPYC)', () => {
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
    expect(MIN_FEE.usdc).toBe(200_000n);
  });
});

describe('calcBreakdown', () => {
  describe('include mode (内税: 店主負担)', () => {
    it('amount > fee: customer pays amount, merchant gets amount - fee', () => {
      const r = calcBreakdown(100_000_000n /* 100 USDC */, 'include', 'usdc');
      expect(r.customerPays).toBe(100_000_000n);
      expect(r.feeAmount).toBe(1_200_000n); // 1.2 USDC
      expect(r.merchantReceives).toBe(98_800_000n); // 98.8 USDC
      // 整合性: merchant + fee == customer
      expect(r.merchantReceives + r.feeAmount).toBe(r.customerPays);
    });

    it('amount < MIN_FEE: merchant gets 0, all goes to fee', () => {
      // 0.05 USDC, fee floor = 0.2 USDC
      const r = calcBreakdown(50_000n, 'include', 'usdc');
      expect(r.customerPays).toBe(50_000n);
      expect(r.merchantReceives).toBe(0n);
      expect(r.feeAmount).toBe(50_000n);
    });

    it('amount == fee boundary: merchant gets 0', () => {
      // amount = MIN_FEE = 0.2 USDC: customer 全額が fee に吸収
      const r = calcBreakdown(200_000n, 'include', 'usdc');
      expect(r.customerPays).toBe(200_000n);
      expect(r.merchantReceives).toBe(0n);
      expect(r.feeAmount).toBe(200_000n);
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
      expect(r.feeAmount).toBe(1_200_000n);
      expect(r.customerPays).toBe(101_200_000n);
      expect(r.merchantReceives + r.feeAmount).toBe(r.customerPays);
    });

    it('amount below MIN: customer pays amount + MIN', () => {
      const r = calcBreakdown(50_000n, 'exclude', 'usdc');
      expect(r.merchantReceives).toBe(50_000n);
      expect(r.feeAmount).toBe(200_000n);
      expect(r.customerPays).toBe(250_000n);
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

  it('USDC 100, 内税, split B:30 / C:20 → primary 50% (49.4 USDC)', () => {
    // amount=100 USDC = 100_000_000, fee = 1.2% = 1_200_000
    // distributable = 98_800_000
    // B = 98_800_000 * 30/100 = 29_640_000
    // C = 98_800_000 * 20/100 = 19_760_000
    // primary (A) = 98_800_000 - 29_640_000 - 19_760_000 = 49_400_000
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
    expect(r.feeAmount).toBe(1_200_000n);
    expect(r.customerPays).toBe(100_000_000n);
    expect(r.recipients).toHaveLength(3);
    expect(r.recipients[0]).toEqual({ to: A, percent: 50, amount: 49_400_000n });
    expect(r.recipients[1]).toEqual({ to: B, percent: 30, amount: 29_640_000n });
    expect(r.recipients[2]).toEqual({ to: C, percent: 20, amount: 19_760_000n });
  });

  it('USDC 100, 外税, split B:50 → A 50, B 50, customer pays 101.2', () => {
    // amount=100 USDC, fee = 1.2, customer pays 101.2, distributable to merchants = 100
    const r = calcSplitBreakdown(
      100_000_000n,
      'exclude',
      'usdc',
      A,
      [{ to: B, percent: 50 }],
    );
    expect(r.feeAmount).toBe(1_200_000n);
    expect(r.customerPays).toBe(101_200_000n);
    expect(r.recipients).toEqual([
      { to: A, percent: 50, amount: 50_000_000n },
      { to: B, percent: 50, amount: 50_000_000n },
    ]);
  });

  it('端数は primary に集約 (USDC 1, 内税, split B:33 → primary 67% で残り全部)', () => {
    // amount=1 USDC = 1_000_000, 1.2% = 12_000 < MIN 200_000 → fee = 200_000
    // distributable = 800_000
    // B = 800_000 * 33/100 = 264_000
    // primary = 800_000 - 264_000 = 536_000 (= 67% + 端数 0、ここでは整数で割れる)
    const r = calcSplitBreakdown(
      1_000_000n,
      'include',
      'usdc',
      A,
      [{ to: B, percent: 33 }],
    );
    expect(r.feeAmount).toBe(200_000n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(800_000n);
    expect(r.recipients[1].amount).toBe(264_000n);
    expect(r.recipients[0].amount).toBe(536_000n);
  });

  it('割り切れない端数も primary に集約', () => {
    // amount=10 USDC = 10_000_000, 1.2% = 120_000 < MIN 200_000 → fee = 200_000
    // distributable = 9_800_000
    // split B:7, C:11 → primary 82%
    // B = 9_800_000 * 7/100 = 686_000
    // C = 9_800_000 * 11/100 = 1_078_000
    // primary = 9_800_000 - 686_000 - 1_078_000 = 8_036_000
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
    expect(sum).toBe(9_800_000n);
    expect(r.recipients[0]).toEqual({ to: A, percent: 82, amount: 8_036_000n });
    expect(r.recipients[1]).toEqual({ to: B, percent: 7, amount: 686_000n });
    expect(r.recipients[2]).toEqual({ to: C, percent: 11, amount: 1_078_000n });
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

  it('split が 1 件 1% (極端): primary 99% で残余取得、% 合計が 100', () => {
    const r = calcSplitBreakdown(
      10_000_000n,
      'exclude',
      'usdc',
      A,
      [{ to: B, percent: 1 }],
    );
    // amount=10 USDC, exclude, 1.2%=120_000 < MIN 200_000 → fee = 0.2 USDC
    // distributable = 10 USDC, customer pays 10.2
    // B = 10 USDC * 1% = 100_000 (0.1 USDC)
    // primary = 10 - 0.1 = 9.9 USDC
    expect(r.feeAmount).toBe(200_000n);
    expect(r.customerPays).toBe(10_200_000n);
    expect(r.recipients[0].percent).toBe(99);
    expect(r.recipients[0].amount).toBe(9_900_000n);
    expect(r.recipients[1].percent).toBe(1);
    expect(r.recipients[1].amount).toBe(100_000n);
  });

  it('split 3 件 (上限): すべての受取人に正しく配分、合計が distributable と一致', () => {
    const C2 = '0x4444444444444444444444444444444444444444' as Address;
    const r = calcSplitBreakdown(
      100_000_000n,
      'include',
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
    expect(sum).toBe(98_800_000n); // distributable = 100 - 1.2 fee
  });

  it('巨大 amount (10^36) でも overflow せず比率配分が正しい', () => {
    // bigint なので native の 64-bit overflow は無いが、回帰検出のため境界
    const huge = 10n ** 36n;
    const r = calcSplitBreakdown(huge, 'exclude', 'usdc', A, [
      { to: B, percent: 50 },
    ]);
    // amount * 1.2% = huge * 120 / 10_000 (USDC MIN 0.2 = 2e5 << 1.2e34)
    // distributable = huge (exclude → merchant 受取 = amount)
    // primary = huge / 2、B = huge / 2
    expect(r.feeAmount).toBe((huge * 120n) / 10_000n);
    expect(r.recipients[0].amount + r.recipients[1].amount).toBe(huge);
    expect(r.recipients[1].amount).toBe(huge / 2n);
  });

  it('% 合計が 99 (主が 1%): distributable のほぼ全部が split に流れる', () => {
    const C2 = '0x4444444444444444444444444444444444444444' as Address;
    const r = calcSplitBreakdown(
      100_000_000n,
      'exclude',
      'usdc',
      A,
      [
        { to: B, percent: 33 },
        { to: C, percent: 33 },
        { to: C2, percent: 33 },
      ],
    );
    expect(r.recipients[0].percent).toBe(1);
    // primary 1% でも 0 にはならず、端数集約で >= 1 USDC * 1%
    expect(r.recipients[0].amount).toBeGreaterThan(0n);
  });

  it('正確な数値: % 33+33+33 で primary 1% は 100 USDC のうち 1 USDC + 端数', () => {
    // README に書いた "rounding edge case" の正確な数字を pin する
    // amount=100 USDC = 100_000_000 (USDC 6 decimals)
    // exclude → distributable = 100 USDC, fee = 1.2% = 1.2 USDC
    // B = 100 * 33 / 100 = 33 USDC = 33_000_000
    // C = 同上 = 33_000_000
    // C2 = 同上 = 33_000_000
    // primary = 100 - 33 - 33 - 33 = 1 USDC = 1_000_000 (rounding 端数なし)
    const C2 = '0x4444444444444444444444444444444444444444' as Address;
    const r = calcSplitBreakdown(
      100_000_000n,
      'exclude',
      'usdc',
      A,
      [
        { to: B, percent: 33 },
        { to: C, percent: 33 },
        { to: C2, percent: 33 },
      ],
    );
    expect(r.recipients[0].amount).toBe(1_000_000n); // primary = 1.0 USDC
    expect(r.recipients[1].amount).toBe(33_000_000n);
    expect(r.recipients[2].amount).toBe(33_000_000n);
    expect(r.recipients[3].amount).toBe(33_000_000n);
    // 顧客は 100 + 1.2 fee = 101.2 USDC を支払う
    expect(r.customerPays).toBe(101_200_000n);
    expect(r.feeAmount).toBe(1_200_000n);
  });

  it('worst-case rounding: 100 wei amount + 99% split で primary は 1 wei', () => {
    // 最小単位での丸めの挙動。"主受取人が極小額になる" UX 上の注意点を pin
    // amount=100 wei (USDC 0.0001 wei!), exclude, fee = MIN 0.1 USDC = 100_000
    // distributable = 100 wei
    // split: B=99% → 100 * 99 / 100 = 99 wei
    // primary = 100 - 99 = 1 wei
    const r = calcSplitBreakdown(100n, 'exclude', 'usdc', A, [
      { to: B, percent: 99 },
    ]);
    expect(r.recipients[0].amount).toBe(1n); // primary = 1 wei (極小)
    expect(r.recipients[1].amount).toBe(99n);
    expect(r.recipients[0].percent).toBe(1);
  });
});
