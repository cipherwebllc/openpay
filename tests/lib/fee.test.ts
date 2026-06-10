// Phase 1 (alpha 期間中): FEE_BPS_GASLESS / FEE_BPS_STANDARD は 0n。
// calcFee は常に 0n を返し、calcBreakdown / calcSplitBreakdown も fee=0 ベースで動作する。
// Phase 2 で課金モデルを復活する際は、本ファイルの sanity check (FEE_BPS_* = 0n)
// が fail することで定数変更が intentional であることを fence する。

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

describe('FEE_BPS_* 定数 (Phase 1: 0n)', () => {
  it('FEE_BPS_GASLESS = 0n (alpha 期間中は手数料徴収なし)', () => {
    expect(FEE_BPS_GASLESS).toBe(0n);
  });
  it('FEE_BPS_STANDARD = 0n (alpha 期間中は手数料徴収なし)', () => {
    expect(FEE_BPS_STANDARD).toBe(0n);
  });
});

describe('calcFee — Phase 1 では両モードで常に 0n', () => {
  const ONE_USDC = 1_000_000n;
  const ONE_JPYC = 10n ** 18n;

  const SAMPLES: Array<{ amount: bigint; token: TokenSymbol; label: string }> = [
    { amount: 0n, token: 'usdc', label: 'USDC zero' },
    { amount: -1n, token: 'usdc', label: 'negative (defensive)' },
    { amount: 1n, token: 'usdc', label: 'USDC 1 wei' },
    { amount: ONE_USDC, token: 'usdc', label: 'USDC 1' },
    { amount: 100n * ONE_USDC, token: 'usdc', label: 'USDC 100' },
    { amount: 100_000n * ONE_USDC, token: 'usdc', label: 'USDC 100000' },
    { amount: ONE_JPYC, token: 'jpyc', label: 'JPYC 1' },
    { amount: 1000n * ONE_JPYC, token: 'jpyc', label: 'JPYC 1000' },
    { amount: 10_000_000n * ONE_JPYC, token: 'jpyc', label: 'JPYC 10M' },
  ];

  for (const mode of ['gasless', 'standard'] as const) {
    describe(`mode=${mode}`, () => {
      it.each(SAMPLES)(`$label: fee = 0n`, ({ amount, token }) => {
        expect(calcFee(amount, token, mode)).toBe(0n);
      });
    });
  }
});

describe('calcBreakdown — Phase 1: feeAmount = 0、merchant 控除なし', () => {
  const ONE_USDC = 1_000_000n;
  const ONE_JPYC = 10n ** 18n;

  describe('gasless / gas=customer (default)', () => {
    it('USDC 100, gas=0: customer=100, merchant=100, fee=0', () => {
      const r = calcBreakdown(100n * ONE_USDC, 'usdc', 'gasless', 'customer', 0n);
      expect(r.customerPays).toBe(100n * ONE_USDC);
      expect(r.merchantReceives).toBe(100n * ONE_USDC);
      expect(r.feeAmount).toBe(0n);
    });

    it('USDC 100, gas=0.5: customer=100.5 (gas 上乗せ), merchant=100, fee=0', () => {
      const r = calcBreakdown(100n * ONE_USDC, 'usdc', 'gasless', 'customer', 500_000n);
      expect(r.customerPays).toBe(100_500_000n);
      expect(r.merchantReceives).toBe(100n * ONE_USDC);
      expect(r.feeAmount).toBe(0n);
    });

    it('JPYC 1000, gas=2: customer=1002, merchant=1000, fee=0', () => {
      const r = calcBreakdown(1000n * ONE_JPYC, 'jpyc', 'gasless', 'customer', 2n * ONE_JPYC);
      expect(r.customerPays).toBe(1002n * ONE_JPYC);
      expect(r.merchantReceives).toBe(1000n * ONE_JPYC);
      expect(r.feeAmount).toBe(0n);
    });

    it('amount = 0: 全部 0', () => {
      const r = calcBreakdown(0n, 'usdc', 'gasless', 'customer', 0n);
      expect(r.customerPays).toBe(0n);
      expect(r.merchantReceives).toBe(0n);
      expect(r.feeAmount).toBe(0n);
    });

    it('default 引数 (mode 省略): gasless 扱い、fee=0', () => {
      const r = calcBreakdown(100n * ONE_USDC, 'usdc');
      expect(r.feeAmount).toBe(0n);
      expect(r.merchantReceives).toBe(100n * ONE_USDC);
    });
  });

  describe('gasless / gas=merchant (店主吸収)', () => {
    it('USDC 100, gas=0.5: customer=100, merchant=99.5 (gas 控除のみ), fee=0', () => {
      const r = calcBreakdown(100n * ONE_USDC, 'usdc', 'gasless', 'merchant', 500_000n);
      expect(r.customerPays).toBe(100n * ONE_USDC);
      expect(r.merchantReceives).toBe(99_500_000n);
      expect(r.feeAmount).toBe(0n);
    });

    it('underflow: amount < gas → merchant = 0', () => {
      const r = calcBreakdown(100_000n, 'usdc', 'gasless', 'merchant', 500_000n);
      expect(r.merchantReceives).toBe(0n);
      expect(r.customerPays).toBe(100_000n);
    });

    it('境界: amount = gas → merchant = 0 (calcBreakdown は amount > deduction で判定)', () => {
      const r = calcBreakdown(500_000n, 'usdc', 'gasless', 'merchant', 500_000n);
      expect(r.merchantReceives).toBe(0n);
    });
  });

  describe('standard mode', () => {
    it('USDC 100: customer=100, merchant=100, fee=0 (gas は無視)', () => {
      const r = calcBreakdown(100n * ONE_USDC, 'usdc', 'standard');
      expect(r.customerPays).toBe(100n * ONE_USDC);
      expect(r.merchantReceives).toBe(100n * ONE_USDC);
      expect(r.feeAmount).toBe(0n);
    });

    it('JPYC 1000: customer=1000, merchant=1000, fee=0', () => {
      const r = calcBreakdown(1000n * ONE_JPYC, 'jpyc', 'standard');
      expect(r.customerPays).toBe(1000n * ONE_JPYC);
      expect(r.merchantReceives).toBe(1000n * ONE_JPYC);
      expect(r.feeAmount).toBe(0n);
    });

    it('gasMode / gasAmount は無視される', () => {
      const r = calcBreakdown(100n * ONE_USDC, 'usdc', 'standard', 'merchant', 999_999n);
      expect(r.customerPays).toBe(100n * ONE_USDC);
      expect(r.merchantReceives).toBe(100n * ONE_USDC);
      expect(r.feeAmount).toBe(0n);
    });

    it('negative amount: 0 にクランプ', () => {
      const r = calcBreakdown(-1n, 'usdc', 'standard');
      expect(r.customerPays).toBe(0n);
      expect(r.merchantReceives).toBe(0n);
      expect(r.feeAmount).toBe(0n);
    });
  });
});

describe('calcSplitBreakdown — Phase 1: fee=0、distributable = merchant 全額', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';
  const C: Address = '0x3333333333333333333333333333333333333333';
  const ONE_USDC = 1_000_000n;
  const ONE_JPYC = 10n ** 18n;

  describe('gasless / gas=customer', () => {
    it('USDC 100, split B:50: A=50, B=50, fee=0, customer=100', () => {
      const r = calcSplitBreakdown(100n * ONE_USDC, 'usdc', A, [
        { to: B, percent: 50 },
      ]);
      expect(r.customerPays).toBe(100n * ONE_USDC);
      expect(r.feeAmount).toBe(0n);
      expect(r.recipients[0]).toEqual({ to: A, percent: 50, amount: 50n * ONE_USDC });
      expect(r.recipients[1]).toEqual({ to: B, percent: 50, amount: 50n * ONE_USDC });
    });

    it('USDC 100, split B:30/C:20: A=50, B=30, C=20, customer=100', () => {
      const r = calcSplitBreakdown(100n * ONE_USDC, 'usdc', A, [
        { to: B, percent: 30 },
        { to: C, percent: 20 },
      ]);
      expect(r.recipients[0]).toEqual({ to: A, percent: 50, amount: 50n * ONE_USDC });
      expect(r.recipients[1]).toEqual({ to: B, percent: 30, amount: 30n * ONE_USDC });
      expect(r.recipients[2]).toEqual({ to: C, percent: 20, amount: 20n * ONE_USDC });
      expect(r.feeAmount).toBe(0n);
    });

    it('JPYC 1000, split B:50: A=500, B=500, fee=0', () => {
      const r = calcSplitBreakdown(1000n * ONE_JPYC, 'jpyc', A, [
        { to: B, percent: 50 },
      ]);
      expect(r.feeAmount).toBe(0n);
      expect(r.recipients[0].amount).toBe(500n * ONE_JPYC);
      expect(r.recipients[1].amount).toBe(500n * ONE_JPYC);
    });

    it('amount = 0: 全 recipients が 0', () => {
      const r = calcSplitBreakdown(0n, 'usdc', A, [{ to: B, percent: 50 }]);
      expect(r.customerPays).toBe(0n);
      expect(r.recipients[0].amount).toBe(0n);
      expect(r.recipients[1].amount).toBe(0n);
    });

    it('split 3 件で 100% 全額分配 + 端数は primary 引き受け', () => {
      const D: Address = '0x4444444444444444444444444444444444444444';
      const r = calcSplitBreakdown(100n * ONE_USDC, 'usdc', A, [
        { to: B, percent: 33 },
        { to: C, percent: 33 },
        { to: D, percent: 33 },
      ]);
      expect(r.recipients).toHaveLength(4);
      expect(r.recipients[0].percent).toBe(1); // 100 - 33*3 = 1
      const sum = r.recipients.reduce((acc, x) => acc + x.amount, 0n);
      expect(sum).toBe(100n * ONE_USDC); // fee=0 なので全額分配
    });
  });

  describe('gasless / gas=merchant (店主吸収)', () => {
    it('USDC 100, gas=0.5, split B:50: distributable = 99.5', () => {
      const r = calcSplitBreakdown(
        100n * ONE_USDC,
        'usdc',
        A,
        [{ to: B, percent: 50 }],
        'gasless',
        'merchant',
        500_000n,
      );
      expect(r.customerPays).toBe(100n * ONE_USDC);
      expect(r.feeAmount).toBe(0n);
      expect(r.recipients[0].amount + r.recipients[1].amount).toBe(99_500_000n);
    });
  });

  describe('standard mode', () => {
    it('USDC 100, split B:50: A=50, B=50, fee=0, customer=100', () => {
      const r = calcSplitBreakdown(
        100n * ONE_USDC,
        'usdc',
        A,
        [{ to: B, percent: 50 }],
        'standard',
      );
      expect(r.customerPays).toBe(100n * ONE_USDC);
      expect(r.feeAmount).toBe(0n);
      expect(r.recipients[0].amount + r.recipients[1].amount).toBe(100n * ONE_USDC);
      expect(r.recipients[0].amount).toBe(50n * ONE_USDC);
      expect(r.recipients[1].amount).toBe(50n * ONE_USDC);
    });

    it('gasMode / gasAmount は無視される', () => {
      const r1 = calcSplitBreakdown(
        100n * ONE_USDC,
        'usdc',
        A,
        [{ to: B, percent: 50 }],
        'standard',
        'customer',
        500_000n,
      );
      const r2 = calcSplitBreakdown(
        100n * ONE_USDC,
        'usdc',
        A,
        [{ to: B, percent: 50 }],
        'standard',
      );
      expect(r1).toEqual(r2);
    });
  });
});

// invariant: Phase 1 (fee=0) では「customer outflow と merchant 受取の関係」が
// すべての mode で簡素化される。ここでは複数 sample 横断で fence する。
describe('cross-mode invariants (Phase 1: fee = 0)', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';

  const SAMPLES: Array<{ amount: bigint; token: TokenSymbol; gas: bigint; label: string }> = [
    { amount: 1_000_000n, token: 'usdc', gas: 0n, label: 'USDC 1, gas=0' },
    { amount: 100_000_000n, token: 'usdc', gas: 0n, label: 'USDC 100, gas=0' },
    { amount: 100_000_000n, token: 'usdc', gas: 300_000n, label: 'USDC 100, gas=0.3' },
    { amount: 100n * 10n ** 18n, token: 'jpyc', gas: 0n, label: 'JPYC 100' },
    { amount: 1000n * 10n ** 18n, token: 'jpyc', gas: 2n * 10n ** 18n, label: 'JPYC 1000, gas=2' },
  ];

  it.each(SAMPLES)('$label: calcFee = 0 (両モード)', ({ amount, token }) => {
    expect(calcFee(amount, token, 'gasless')).toBe(0n);
    expect(calcFee(amount, token, 'standard')).toBe(0n);
  });

  it.each(SAMPLES)(
    '$label: gasless/customer: merchant = amount, customer = amount + gas',
    ({ amount, token, gas }) => {
      const r = calcBreakdown(amount, token, 'gasless', 'customer', gas);
      expect(r.merchantReceives).toBe(amount);
      expect(r.customerPays).toBe(amount + gas);
      expect(r.feeAmount).toBe(0n);
    },
  );

  it.each(SAMPLES)(
    '$label: gasless/merchant: merchant = max(0, amount - gas), customer = amount',
    ({ amount, token, gas }) => {
      const r = calcBreakdown(amount, token, 'gasless', 'merchant', gas);
      const expected = amount > gas ? amount - gas : 0n;
      expect(r.merchantReceives).toBe(expected);
      expect(r.customerPays).toBe(amount);
      expect(r.feeAmount).toBe(0n);
    },
  );

  it.each(SAMPLES)('$label: standard: merchant = amount, customer = amount (gas 無視)', ({ amount, token, gas }) => {
    const r = calcBreakdown(amount, token, 'standard', 'merchant', gas);
    expect(r.merchantReceives).toBe(amount);
    expect(r.customerPays).toBe(amount);
    expect(r.feeAmount).toBe(0n);
  });

  it.each(SAMPLES)('$label: split 50/50: A + B = amount (fee 控除なし)', ({ amount, token }) => {
    const r = calcSplitBreakdown(amount, token, A, [{ to: B, percent: 50 }]);
    expect(r.feeAmount).toBe(0n);
    const sum = r.recipients.reduce((acc, x) => acc + x.amount, 0n);
    expect(sum).toBe(amount);
  });
});

// ============================================================
// USDC erc20/circle gas=merchant ネット経済性の不変条件
// ============================================================
// 【背景・偽陽性記録】
// コードレビューで「USDC gas=merchant は merchant 着金から gas を控除しつつ
// paymaster が顧客からも実 gas を pull するので二重計上」という指摘が出たが、
// 主監査で偽陽性と確定した。
//
// 【正しい経済性】
// amount=100, gas=2 のとき:
//   merchant transfer = 98 (=amount−gas)
//   paymaster が顧客 USDC から 2 を pull
//   → 顧客総支出 = 98 + 2 = 100 = 表示 customerPays ✓
//   → 店主受領 = 98 ✓
// 控除分は顧客の手元に残り、顧客がそれで paymaster pull を賄う
// (= 控除は顧客への前補填)。JPYC recover (控除分を feeReceiver へ送り
// 立替者=OpenPay を補償) とネットで等価。
// gasMode の約束 (店主吸収: 顧客は請求額のみ・店主は amount−gas) は USDC でも成立。
//
// このテストは上記不変条件を calcBreakdown レベルで固定し、
// 将来のリファクタで壊れた場合に即検出できるようにする。
describe('USDC gas=merchant ネット経済性不変条件 (偽陽性 "二重徴収" を防ぐフェンス)', () => {
  const ONE_USDC = 1_000_000n; // 6 decimals

  it('USDC 100, gas=2, gasMode=merchant: merchantReceives=98, customerPays=100 (顧客支出は amount のみ)', () => {
    // 控除は「顧客への前補填」: 顧客は 100 を支払い、うち 98 が merchant へ transfer、
    // 残 2 は顧客の手元に留まり paymaster pull (実 gas) を賄う。二重徴収ではない。
    const r = calcBreakdown(100n * ONE_USDC, 'usdc', 'gasless', 'merchant', 2n * ONE_USDC);
    expect(r.merchantReceives).toBe(98n * ONE_USDC);
    expect(r.customerPays).toBe(100n * ONE_USDC);
    expect(r.feeAmount).toBe(0n);
  });

  it('USDC 100, gas=2, gasMode=merchant: transfer合計 + paymaster pull = customerPays (等式の明示)', () => {
    // transfer合計 (merchant + feeReceiver) = 98
    // paymaster pull (= 控除分で顧客が賄う) = 2
    // 98 + 2 = 100 = customerPays ✓
    const GAS = 2n * ONE_USDC;
    const AMOUNT = 100n * ONE_USDC;
    const r = calcBreakdown(AMOUNT, 'usdc', 'gasless', 'merchant', GAS);
    const transferTotal = r.merchantReceives + r.feeAmount; // fee=0 なので = 98
    const paymasterPull = GAS; // 顧客の手元に残り paymaster pull を賄う前補填分
    expect(transferTotal + paymasterPull).toBe(r.customerPays);
  });

  it('USDC 100, gas=2, gasMode=customer (比較対象): merchantReceives=100, customerPays=102', () => {
    // gas=customer では顧客が gas を上乗せして支払い、merchant は全額受領。
    // transfer合計(100) + pull(2) = customerPays(102) も等式が成立している。
    const r = calcBreakdown(100n * ONE_USDC, 'usdc', 'gasless', 'customer', 2n * ONE_USDC);
    expect(r.merchantReceives).toBe(100n * ONE_USDC);
    expect(r.customerPays).toBe(102n * ONE_USDC);
    expect(r.feeAmount).toBe(0n);
    // transfer合計 + pull = customerPays の等式 (gas=customer 版)
    const transferTotal = r.merchantReceives + r.feeAmount;
    const paymasterPull = 2n * ONE_USDC;
    expect(transferTotal + paymasterPull).toBe(r.customerPays);
  });

  it('USDC 50, gas=1, gasMode=merchant: merchantReceives=49, customerPays=50 (別額でも等式成立)', () => {
    const GAS = 1n * ONE_USDC;
    const AMOUNT = 50n * ONE_USDC;
    const r = calcBreakdown(AMOUNT, 'usdc', 'gasless', 'merchant', GAS);
    expect(r.merchantReceives).toBe(49n * ONE_USDC);
    expect(r.customerPays).toBe(50n * ONE_USDC);
    const transferTotal = r.merchantReceives + r.feeAmount;
    expect(transferTotal + GAS).toBe(r.customerPays);
  });

  it('gas=merchant と gas=customer で顧客支出の差 = 0 (同一 amount で gas 負担者だけ変わる)', () => {
    // gas=merchant: customerPays = amount (顧客は amount のみ負担、merchant が gas を吸収)
    // gas=customer: customerPays = amount + gas (顧客が gas を追加負担)
    // → どちらも約束通りの経済性
    const AMOUNT = 100n * ONE_USDC;
    const GAS = 2n * ONE_USDC;
    const merchant = calcBreakdown(AMOUNT, 'usdc', 'gasless', 'merchant', GAS);
    const customer = calcBreakdown(AMOUNT, 'usdc', 'gasless', 'customer', GAS);
    expect(merchant.customerPays).toBe(AMOUNT);
    expect(customer.customerPays).toBe(AMOUNT + GAS);
    // merchant 受領の差 = gas (店主吸収分だけ少ない)
    expect(customer.merchantReceives - merchant.merchantReceives).toBe(GAS);
  });
});
