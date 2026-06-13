import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  effectiveGasMode,
  isMerchantGasAbsorb,
  effectivePayMode,
  effectiveGasAmount,
  paymentBreakdown,
  paymentSplitBreakdown,
  gasReimbursementValue,
  networkFeeEquivalentValue,
  minimumAmountWei,
} from '@/lib/paymentMoney';
import {
  calcBreakdown,
  calcSplitBreakdown,
  type GasMode,
  type PayMode,
} from '@/lib/fee';
import type { PaymentRoute } from '@/lib/paymentRoute';
import type { PaymasterMode } from '@/lib/tokens';
import type { TokenSymbol } from '@/lib/tokens';

// lib/paymentMoney は CheckoutForm の money/gas/fee 導出を route 駆動の純関数に切り出した単一情報源
// (Phase 1.2)。本テストは「**最高感度の挙動不変**」の錨: route × gasMode × token (+ recover bps /
// circle surcharge / free / standard) の直積を網羅し、各純関数の wei/boolean を固定する。以後の
// 経路・手数料変更はこの表への行追加 (or 既存行の意図的更新) として現れ、想定外の drift を fail させる。
//
// 純関数は env/hook を読まないため、env 依存の量 (recover 手数料 relayGasEquiv / paymaster gas quote
// gasAmount) は **解決済みの値** を引数で与える (CheckoutForm が recoverFeeValue / activeQuote から
// 算出する値に相当)。本テストでは固定 sentinel を使う。

const JPYC = 10n ** 18n; // 1 JPYC (18 decimals)
const USDC = 1_000_000n; // 1 USDC (6 decimals)

// route の代表値 (現行 CheckoutForm で発火する 5 経路)。
const ROUTES = {
  standard: { kind: 'standard' } as PaymentRoute,
  relayFree: { kind: 'relay', recover: false } as PaymentRoute,
  relayRecover: { kind: 'relay', recover: true } as PaymentRoute,
  gaslessPimlico: { kind: 'gasless', provider: 'pimlico' } as PaymentRoute,
  gaslessCircle: { kind: 'gasless', provider: 'circle' } as PaymentRoute,
} satisfies Record<string, PaymentRoute>;

const ALL_ROUTES = Object.entries(ROUTES) as ReadonlyArray<
  [keyof typeof ROUTES, PaymentRoute]
>;
const GAS_MODES: readonly GasMode[] = ['customer', 'merchant'];

// ---------------------------------------------------------------------------
// effectiveGasMode: recover は merchant 強制、それ以外は params.gas (省略 customer)。
// 現行: `useRecover ? 'merchant' : (params.gas ?? 'customer')`
// ---------------------------------------------------------------------------
describe('effectiveGasMode — recover は merchant 強制 / 他は URL gas (省略 customer)', () => {
  for (const [name, route] of ALL_ROUTES) {
    for (const paramsGas of [undefined, 'customer', 'merchant'] as const) {
      it(`route=${name} paramsGas=${paramsGas ?? 'undefined'}`, () => {
        const got = effectiveGasMode(route, paramsGas);
        // recover のみ強制 merchant。他は素朴に params.gas ?? 'customer'。
        const want: GasMode =
          route.kind === 'relay' && route.recover
            ? 'merchant'
            : (paramsGas ?? 'customer');
        expect(got).toBe(want);
      });
    }
  }

  it('recover は URL gas=customer を無視して merchant に倒す (確定モデル 2026-06-12)', () => {
    expect(effectiveGasMode(ROUTES.relayRecover, 'customer')).toBe('merchant');
  });
  it('relay free は URL gas をそのまま尊重する (customer)', () => {
    expect(effectiveGasMode(ROUTES.relayFree, 'customer')).toBe('customer');
  });
});

// ---------------------------------------------------------------------------
// isMerchantGasAbsorb: 非 standard かつ gasMode==='merchant'。
// 現行: `!isStandard && effectiveGas === 'merchant'`
// ---------------------------------------------------------------------------
describe('isMerchantGasAbsorb — 非 standard かつ merchant', () => {
  for (const [name, route] of ALL_ROUTES) {
    for (const gasMode of GAS_MODES) {
      it(`route=${name} gasMode=${gasMode}`, () => {
        const got = isMerchantGasAbsorb(route, gasMode);
        const want = route.kind !== 'standard' && gasMode === 'merchant';
        expect(got).toBe(want);
      });
    }
  }

  it('standard は gasMode=merchant でも false (standard は gas に touch しない)', () => {
    expect(isMerchantGasAbsorb(ROUTES.standard, 'merchant')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// effectivePayMode: standard route なら 'standard'、それ以外は params.mode 透過。
// 現行: `isStandard ? 'standard' : params.mode`
// ---------------------------------------------------------------------------
describe('effectivePayMode — standard route のみ standard、他は params.mode 透過', () => {
  for (const [name, route] of ALL_ROUTES) {
    for (const paramsMode of [undefined, 'gasless', 'standard'] as Array<
      PayMode | undefined
    >) {
      it(`route=${name} paramsMode=${paramsMode ?? 'undefined'}`, () => {
        const got = effectivePayMode(route, paramsMode);
        const want = route.kind === 'standard' ? 'standard' : paramsMode;
        expect(got).toBe(want);
      });
    }
  }

  it('非 standard + params.mode=undefined は undefined を透過 (calcBreakdown 既定 gasless へ倒す)', () => {
    expect(effectivePayMode(ROUTES.gaslessPimlico, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// effectiveGasAmount: relay → relayGasEquiv / JPYC → 0n / それ以外 → gasAmount。
// 現行: `useRelay ? relayGasEquiv : isJpyc ? 0n : gasAmount`
// 短絡順 (relay 最優先 → isJpyc → gasAmount) を厳密に固定する。
// ---------------------------------------------------------------------------
describe('effectiveGasAmount — relay 回収額 / JPYC 0 / USDC quote の短絡順', () => {
  const RELAY_FEE = 2n * JPYC; // recover 回収額 (= 2 JPYC フロア相当の sentinel)
  const QUOTE = 100_000n; // USDC paymaster gas quote sentinel (0.1 USDC)

  // relay (free/recover) は token に関わらず relayGasEquiv をそのまま返す (quote を見ない)。
  it('relay free: relayGasEquiv (=0n free) を返す・gasAmount/isJpyc 無視', () => {
    expect(
      effectiveGasAmount(ROUTES.relayFree, {
        isJpyc: true,
        relayGasEquiv: 0n,
        gasAmount: QUOTE,
      }),
    ).toBe(0n);
  });
  it('relay recover: relayGasEquiv (=回収額) を返す・gasAmount 無視', () => {
    expect(
      effectiveGasAmount(ROUTES.relayRecover, {
        isJpyc: true,
        relayGasEquiv: RELAY_FEE,
        gasAmount: QUOTE,
      }),
    ).toBe(RELAY_FEE);
  });
  // relay は isJpyc=false でも relayGasEquiv 優先 (短絡順 relay > isJpyc の固定)。
  it('relay は isJpyc=false でも relayGasEquiv を優先 (短絡順 relay > isJpyc)', () => {
    expect(
      effectiveGasAmount(ROUTES.relayRecover, {
        isJpyc: false,
        relayGasEquiv: RELAY_FEE,
        gasAmount: QUOTE,
      }),
    ).toBe(RELAY_FEE);
  });

  // 非 relay JPYC (gasless/pimlico sponsorship or circle) は常に 0n (ガス無料化)。
  for (const [name, route] of [
    ['gaslessPimlico', ROUTES.gaslessPimlico],
    ['gaslessCircle', ROUTES.gaslessCircle],
    ['standard', ROUTES.standard],
  ] as const) {
    it(`非 relay JPYC (route=${name}): 0n を返す (gasAmount 無視)`, () => {
      expect(
        effectiveGasAmount(route, {
          isJpyc: true,
          relayGasEquiv: 0n,
          gasAmount: QUOTE,
        }),
      ).toBe(0n);
    });
  }

  // 非 relay USDC は gasAmount (quote) をそのまま (未取得は undefined を透過)。
  it('非 relay USDC (gasless/pimlico erc20): gasAmount をそのまま返す', () => {
    expect(
      effectiveGasAmount(ROUTES.gaslessPimlico, {
        isJpyc: false,
        relayGasEquiv: 0n,
        gasAmount: QUOTE,
      }),
    ).toBe(QUOTE);
  });
  it('非 relay USDC: gasAmount 未取得 (undefined) は undefined を透過する', () => {
    expect(
      effectiveGasAmount(ROUTES.gaslessPimlico, {
        isJpyc: false,
        relayGasEquiv: 0n,
        gasAmount: undefined,
      }),
    ).toBeUndefined();
  });
  it('非 relay USDC circle: gasAmount をそのまま返す (circle quote の gasAmount)', () => {
    expect(
      effectiveGasAmount(ROUTES.gaslessCircle, {
        isJpyc: false,
        relayGasEquiv: 0n,
        gasAmount: QUOTE,
      }),
    ).toBe(QUOTE);
  });
});

// ---------------------------------------------------------------------------
// paymentBreakdown: calcBreakdown を route 由来の mode/gasMode/effectiveGasAmount で呼ぶ薄いラッパ。
// effectiveGasAmount ?? 0n で undefined を 0n に倒す点を含め、calcBreakdown と完全一致させる。
// ---------------------------------------------------------------------------
describe('paymentBreakdown — calcBreakdown との完全一致 (route × gasMode × token + gas 額)', () => {
  // CheckoutForm の代表額 (USDC=55, JPYC=3000) + 端数/gas 控除のエッジ。
  const AMOUNTS: ReadonlyArray<{ token: TokenSymbol; amount: bigint; label: string }> = [
    { token: 'usdc', amount: 55n * USDC, label: 'USDC 55' },
    { token: 'jpyc', amount: 3000n * JPYC, label: 'JPYC 3000' },
    { token: 'usdc', amount: 40_000n, label: 'USDC 0.04 (gas 未満)' },
    { token: 'usdc', amount: 0n, label: 'USDC 0 (空)' },
  ];
  const GAS_AMOUNTS: ReadonlyArray<bigint | undefined> = [
    undefined,
    0n,
    100_000n,
    2n * JPYC,
  ];
  const PAY_MODES: ReadonlyArray<PayMode | undefined> = [
    undefined,
    'gasless',
    'standard',
  ];

  let count = 0;
  for (const { token, amount, label } of AMOUNTS) {
    for (const payMode of PAY_MODES) {
      for (const gasMode of GAS_MODES) {
        for (const gas of GAS_AMOUNTS) {
          count++;
          it(`token=${label} payMode=${payMode ?? 'undefined'} gasMode=${gasMode} gas=${gas ?? 'undefined'}`, () => {
            const got = paymentBreakdown({
              totalWei: amount,
              token,
              payMode,
              gasMode,
              effectiveGasAmount: gas,
            });
            // 参照: calcBreakdown を直接呼ぶ (ラッパは undefined→0n のみを足す)。
            const want = calcBreakdown(amount, token, payMode, gasMode, gas ?? 0n);
            expect(got).toEqual(want);
          });
        }
      }
    }
  }

  it(`breakdown 直積を網羅している (網羅性の自己検査)`, () => {
    // 4 amounts × 3 payModes × 2 gasModes × 4 gasAmounts = 96。
    expect(count).toBe(96);
  });

  // 代表的な会計上の値を明示固定 (fee=0 の現状)。
  it('gasless/customer: customer=amount+gas, merchant=amount (gas は merchant 控除に乗らない)', () => {
    const b = paymentBreakdown({
      totalWei: 55n * USDC,
      token: 'usdc',
      payMode: 'gasless',
      gasMode: 'customer',
      effectiveGasAmount: 100_000n,
    });
    expect(b.customerPays).toBe(55n * USDC + 100_000n);
    expect(b.merchantReceives).toBe(55n * USDC);
    expect(b.feeAmount).toBe(0n);
  });
  it('gasless/merchant: customer=amount, merchant=amount-gas', () => {
    const b = paymentBreakdown({
      totalWei: 55n * USDC,
      token: 'usdc',
      payMode: 'gasless',
      gasMode: 'merchant',
      effectiveGasAmount: 100_000n,
    });
    expect(b.customerPays).toBe(55n * USDC);
    expect(b.merchantReceives).toBe(55n * USDC - 100_000n);
  });
  it('gasless/merchant で amount<gas: merchant underflow → 0n (送信 block 条件)', () => {
    const b = paymentBreakdown({
      totalWei: 40_000n, // 0.04 USDC
      token: 'usdc',
      payMode: 'gasless',
      gasMode: 'merchant',
      effectiveGasAmount: 100_000n, // 0.1 USDC
    });
    expect(b.merchantReceives).toBe(0n);
  });
  it('standard: customer=amount, merchant=amount (gasAmount は無視・fee=0)', () => {
    const b = paymentBreakdown({
      totalWei: 55n * USDC,
      token: 'usdc',
      payMode: 'standard',
      gasMode: 'merchant', // standard は gasMode irrelevant
      effectiveGasAmount: 100_000n, // standard は gas を breakdown に組み込まない
    });
    expect(b.customerPays).toBe(55n * USDC);
    expect(b.merchantReceives).toBe(55n * USDC);
  });
  it('JPYC relay free (gas=0): customer=merchant=3000 JPYC (無徴収)', () => {
    const b = paymentBreakdown({
      totalWei: 3000n * JPYC,
      token: 'jpyc',
      payMode: 'gasless',
      gasMode: 'customer',
      effectiveGasAmount: 0n, // JPYC は effectiveGasAmount=0n
    });
    expect(b.customerPays).toBe(3000n * JPYC);
    expect(b.merchantReceives).toBe(3000n * JPYC);
  });
  it('JPYC recover merchant 吸収 (gas=回収額 2 JPYC): merchant=value-2, customer=value', () => {
    const b = paymentBreakdown({
      totalWei: 3000n * JPYC,
      token: 'jpyc',
      payMode: 'gasless',
      gasMode: 'merchant', // recover は merchant 固定
      effectiveGasAmount: 2n * JPYC, // recover 回収額
    });
    // customer は満額 (上乗せ無し)、merchant は回収額を内枠吸収。
    expect(b.customerPays).toBe(3000n * JPYC);
    expect(b.merchantReceives).toBe((3000n - 2n) * JPYC);
  });
});

// ---------------------------------------------------------------------------
// paymentSplitBreakdown: calcSplitBreakdown を route 由来の payMode/gasMode/effectiveGasAmount で
// 呼ぶ薄いラッパ (PaymentForm 専用・split)。calcSplitBreakdown と完全一致 + undefined→0n の透過、
// および PaymentForm.test.tsx が pin する具体額 (USDC merchant split / JPYC free split) を錨固定する。
// ---------------------------------------------------------------------------
describe('paymentSplitBreakdown — calcSplitBreakdown との完全一致 + split 按分の wei 固定', () => {
  const MERCHANT = '0x1111111111111111111111111111111111111111' as Address;
  const B = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
  const SPLITS: ReadonlyArray<{ to: Address; percent: number }> = [
    { to: B, percent: 50 },
  ];

  // calcSplitBreakdown を直接呼んだ参照と、ラッパ経由 (effectiveGasAmount=undefined→0n) が一致。
  const AMOUNTS: ReadonlyArray<{ token: TokenSymbol; amount: bigint; label: string }> = [
    { token: 'usdc', amount: 100n * USDC, label: 'USDC 100' },
    { token: 'jpyc', amount: 1000n * JPYC, label: 'JPYC 1000' },
    { token: 'usdc', amount: 0n, label: 'USDC 0' },
  ];
  const GAS_AMOUNTS: ReadonlyArray<bigint | undefined> = [undefined, 0n, 500_000n];
  const PAY_MODES: ReadonlyArray<PayMode | undefined> = [undefined, 'gasless'];
  const SPLIT_GAS_MODES: ReadonlyArray<GasMode | undefined> = [
    undefined,
    'customer',
    'merchant',
  ];

  let count = 0;
  for (const { token, amount, label } of AMOUNTS) {
    for (const payMode of PAY_MODES) {
      for (const gasMode of SPLIT_GAS_MODES) {
        for (const gas of GAS_AMOUNTS) {
          count++;
          it(`token=${label} payMode=${payMode ?? 'undefined'} gasMode=${gasMode ?? 'undefined'} gas=${gas ?? 'undefined'}`, () => {
            const got = paymentSplitBreakdown({
              totalWei: amount,
              token,
              primary: MERCHANT,
              splits: SPLITS,
              payMode,
              gasMode,
              effectiveGasAmount: gas,
            });
            // 参照: calcSplitBreakdown を直接呼ぶ。ラッパは undefined→0n のみを足す
            // (gasMode undefined は calcSplitBreakdown の既定 'customer' に倒れる)。
            const want = calcSplitBreakdown(
              amount,
              token,
              MERCHANT,
              SPLITS,
              payMode,
              gasMode,
              gas ?? 0n,
            );
            expect(got).toEqual(want);
          });
        }
      }
    }
  }

  it('split 直積を網羅 (3 amounts × 2 payModes × 3 gasModes × 3 gasAmounts = 54)', () => {
    expect(count).toBe(54);
  });

  // PaymentForm.test.tsx の split 送信ケースを錨固定 (byte-equivalence の回帰検知)。
  // USDC merchant split: distributable = amount - fee(0) - gas, primary 50% / B 50%。
  it('USDC merchant split (PaymentForm 相当): distributable=amount-gas を 50/50 按分', () => {
    const s = paymentSplitBreakdown({
      totalWei: 100n * USDC, // 100 USDC
      token: 'usdc',
      primary: MERCHANT,
      splits: SPLITS,
      payMode: 'gasless',
      gasMode: 'merchant',
      effectiveGasAmount: 500_000n, // gas 0.5 USDC
    });
    // distributable = 100 - 0(fee) - 0.5(gas) = 99.5 → primary 49.75 / B 49.75。
    expect(s.recipients[0].amount).toBe(49_750_000n);
    expect(s.recipients[1].amount).toBe(49_750_000n);
    expect(s.feeAmount).toBe(0n);
    // gas=merchant のため customerPays は満額 (上乗せなし)。
    expect(s.customerPays).toBe(100n * USDC);
  });

  // JPYC free split: effectiveGasAmount=0 (ガス無料化) のため受取人は満額按分・customer 満額。
  it('JPYC free split (PaymentForm 相当・ega=0): 受取人満額 50/50・gas 控除なし', () => {
    const s = paymentSplitBreakdown({
      totalWei: 1000n * JPYC,
      token: 'jpyc',
      primary: MERCHANT,
      splits: SPLITS,
      payMode: 'gasless',
      gasMode: 'merchant', // 旧 QR の gas=merchant でも JPYC 無料化で ega=0 のため控除 0
      effectiveGasAmount: 0n,
    });
    expect(s.recipients[0].amount).toBe(500n * JPYC);
    expect(s.recipients[1].amount).toBe(500n * JPYC);
    expect(s.feeAmount).toBe(0n);
    expect(s.customerPays).toBe(1000n * JPYC);
  });

  // gasMode undefined (params.gas 省略) は calcSplitBreakdown 既定 'customer' に倒れる
  // (PaymentForm が effectiveGas へ正規化せず params.gas を渡すケースの byte 同一性)。
  it('gasMode=undefined は customer 扱い: customer=amount+gas, 受取人は満額按分', () => {
    const s = paymentSplitBreakdown({
      totalWei: 100n * USDC,
      token: 'usdc',
      primary: MERCHANT,
      splits: SPLITS,
      payMode: 'gasless',
      gasMode: undefined, // = 'customer'
      effectiveGasAmount: 500_000n,
    });
    // customer = amount + gas (customer 負担)、受取人 = amount を 50/50 (gas 控除なし)。
    expect(s.customerPays).toBe(100n * USDC + 500_000n);
    expect(s.recipients[0].amount).toBe(50n * USDC);
    expect(s.recipients[1].amount).toBe(50n * USDC);
  });
});

// ---------------------------------------------------------------------------
// gasReimbursementValue: !isJpyc && !isCircle && paymasterMode==='sponsorship' ? gasAmount??0n : 0n
// JPYC=0 (全額負担)・USDC erc20=0 (直接徴収)・circle=0・残る USDC sponsorship のみ回収。
// ---------------------------------------------------------------------------
describe('gasReimbursementValue — sponsorship USDC のみ回収・他は 0', () => {
  const QUOTE = 100_000n;
  const PAYMASTER_MODES: readonly PaymasterMode[] = [
    'sponsorship',
    'erc20',
    'unavailable',
  ];

  let count = 0;
  for (const [name, route] of ALL_ROUTES) {
    for (const isJpyc of [false, true]) {
      for (const paymasterMode of PAYMASTER_MODES) {
        for (const gasAmount of [undefined, QUOTE] as const) {
          count++;
          it(`route=${name} isJpyc=${isJpyc} pm=${paymasterMode} gas=${gasAmount ?? 'undefined'}`, () => {
            const got = gasReimbursementValue(route, {
              isJpyc,
              paymasterMode,
              gasAmount,
            });
            const want =
              !isJpyc &&
              !(route.kind === 'gasless' && route.provider === 'circle') &&
              paymasterMode === 'sponsorship'
                ? (gasAmount ?? 0n)
                : 0n;
            expect(got).toBe(want);
          });
        }
      }
    }
  }

  it('gasReimbursement 直積を網羅 (5 routes × 2 isJpyc × 3 pm × 2 gas = 60)', () => {
    expect(count).toBe(60);
  });

  // 代表ケース明示。
  it('USDC sponsorship (testnet fallback): gasAmount を回収する', () => {
    expect(
      gasReimbursementValue(ROUTES.gaslessPimlico, {
        isJpyc: false,
        paymasterMode: 'sponsorship',
        gasAmount: QUOTE,
      }),
    ).toBe(QUOTE);
  });
  it('USDC erc20 (mainnet): 0n (paymaster が顧客 USDC から直接徴収)', () => {
    expect(
      gasReimbursementValue(ROUTES.gaslessPimlico, {
        isJpyc: false,
        paymasterMode: 'erc20',
        gasAmount: QUOTE,
      }),
    ).toBe(0n);
  });
  it('JPYC sponsorship: 0n (OpenPay 全額負担・無徴収)', () => {
    expect(
      gasReimbursementValue(ROUTES.gaslessPimlico, {
        isJpyc: true,
        paymasterMode: 'sponsorship',
        gasAmount: QUOTE,
      }),
    ).toBe(0n);
  });
  it('circle (USDC) は sponsorship 判定に入らない → 0n', () => {
    expect(
      gasReimbursementValue(ROUTES.gaslessCircle, {
        isJpyc: false,
        paymasterMode: 'sponsorship',
        gasAmount: QUOTE,
      }),
    ).toBe(0n);
  });
  it('sponsorship USDC で gasAmount 未取得: 0n (?? 0n)', () => {
    expect(
      gasReimbursementValue(ROUTES.gaslessPimlico, {
        isJpyc: false,
        paymasterMode: 'sponsorship',
        gasAmount: undefined,
      }),
    ).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// networkFeeEquivalentValue: !isStandard && !isCircle ? effectiveGasAmount??0n : null
// standard / circle は null、他は effectiveGasAmount を会計記録。
// ---------------------------------------------------------------------------
describe('networkFeeEquivalentValue — standard/circle は null・他は effectiveGasAmount', () => {
  const GASES: ReadonlyArray<bigint | undefined> = [undefined, 0n, 100_000n, 2n * JPYC];

  let count = 0;
  for (const [name, route] of ALL_ROUTES) {
    for (const gas of GASES) {
      count++;
      it(`route=${name} effectiveGasAmount=${gas ?? 'undefined'}`, () => {
        const got = networkFeeEquivalentValue(route, gas);
        const want =
          route.kind !== 'standard' &&
          !(route.kind === 'gasless' && route.provider === 'circle')
            ? (gas ?? 0n)
            : null;
        expect(got).toBe(want);
      });
    }
  }

  it('networkFeeEquivalent 直積を網羅 (5 routes × 4 gas = 20)', () => {
    expect(count).toBe(20);
  });

  it('standard: 常に null (会計記録しない)', () => {
    expect(networkFeeEquivalentValue(ROUTES.standard, 100_000n)).toBeNull();
  });
  it('circle: 常に null (receipt 由来額を別途使う)', () => {
    expect(networkFeeEquivalentValue(ROUTES.gaslessCircle, 100_000n)).toBeNull();
  });
  it('relay free: effectiveGasAmount=0n → 0n を記録', () => {
    expect(networkFeeEquivalentValue(ROUTES.relayFree, 0n)).toBe(0n);
  });
  it('relay recover: 回収額 (2 JPYC) を記録', () => {
    expect(networkFeeEquivalentValue(ROUTES.relayRecover, 2n * JPYC)).toBe(2n * JPYC);
  });
  it('gasless/pimlico USDC: gasAmount を記録 (undefined は 0n)', () => {
    expect(networkFeeEquivalentValue(ROUTES.gaslessPimlico, 100_000n)).toBe(100_000n);
    expect(networkFeeEquivalentValue(ROUTES.gaslessPimlico, undefined)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// minimumAmountWei: feeAmount + (isMerchantGas ? effectiveGasAmount??0n : 0n)
// ---------------------------------------------------------------------------
describe('minimumAmountWei — fee + (merchant 吸収なら gas)', () => {
  it('customer 負担: gas は最小額に乗らない (= feeAmount のみ)', () => {
    expect(
      minimumAmountWei({
        feeAmount: 0n,
        isMerchantGas: false,
        effectiveGasAmount: 100_000n,
      }),
    ).toBe(0n);
  });
  it('merchant 吸収: feeAmount + gas', () => {
    expect(
      minimumAmountWei({
        feeAmount: 0n,
        isMerchantGas: true,
        effectiveGasAmount: 100_000n,
      }),
    ).toBe(100_000n);
  });
  it('merchant 吸収 + gas 未取得 (undefined): feeAmount のみ (?? 0n)', () => {
    expect(
      minimumAmountWei({
        feeAmount: 0n,
        isMerchantGas: true,
        effectiveGasAmount: undefined,
      }),
    ).toBe(0n);
  });
  it('fee>0 (将来) + merchant 吸収: fee + gas を加算する', () => {
    expect(
      minimumAmountWei({
        feeAmount: 5n * USDC,
        isMerchantGas: true,
        effectiveGasAmount: 100_000n,
      }),
    ).toBe(5n * USDC + 100_000n);
  });
});

// ---------------------------------------------------------------------------
// 統合: CheckoutForm の代表 4 経路を「route → 各純関数」で一気通貫し、
// CheckoutForm.test.tsx が依存する具体額 (送信 mutate / 履歴 / 表示) を固定する。
// ---------------------------------------------------------------------------
describe('統合シナリオ — CheckoutForm の代表経路の wei 値を錨固定', () => {
  it('USDC sponsorship gas=customer (CheckoutForm 送信テスト相当: merchant=55, netFee=0.1, reimb=0.1)', () => {
    const route = ROUTES.gaslessPimlico;
    const totalWei = 55n * USDC;
    const gasAmount = 100_000n; // 0.1 USDC
    const gasMode = effectiveGasMode(route, 'customer'); // customer
    const payMode = effectivePayMode(route, 'gasless'); // gasless
    const ega = effectiveGasAmount(route, {
      isJpyc: false,
      relayGasEquiv: 0n,
      gasAmount,
    });
    const breakdown = paymentBreakdown({
      totalWei,
      token: 'usdc',
      payMode,
      gasMode,
      effectiveGasAmount: ega,
    });
    expect(breakdown.merchantReceives).toBe(55n * USDC);
    expect(breakdown.feeAmount).toBe(0n);
    expect(
      networkFeeEquivalentValue(route, ega),
    ).toBe(100_000n);
    expect(
      gasReimbursementValue(route, {
        isJpyc: false,
        paymasterMode: 'sponsorship',
        gasAmount,
      }),
    ).toBe(100_000n);
  });

  it('USDC erc20 gas=customer (CheckoutForm ERC20 テスト相当: merchant=55, fee=0, reimb=0)', () => {
    const route = ROUTES.gaslessPimlico;
    const gasAmount = 100_000n;
    const ega = effectiveGasAmount(route, {
      isJpyc: false,
      relayGasEquiv: 0n,
      gasAmount,
    });
    const breakdown = paymentBreakdown({
      totalWei: 55n * USDC,
      token: 'usdc',
      payMode: 'gasless',
      gasMode: effectiveGasMode(route, 'customer'),
      effectiveGasAmount: ega,
    });
    expect(breakdown.merchantReceives).toBe(55n * USDC);
    expect(breakdown.feeAmount).toBe(0n);
    // erc20 paymaster は顧客 USDC から直接徴収 → reimbursement 0。
    expect(
      gasReimbursementValue(route, {
        isJpyc: false,
        paymasterMode: 'erc20',
        gasAmount,
      }),
    ).toBe(0n);
  });

  it('JPYC relay free gas=customer (送信テスト相当: ega=0, merchant=3000, netFee=0)', () => {
    const route = ROUTES.relayFree;
    const totalWei = 3000n * JPYC;
    const gasMode = effectiveGasMode(route, 'customer'); // customer (free は URL 尊重)
    expect(gasMode).toBe('customer');
    const ega = effectiveGasAmount(route, {
      isJpyc: true,
      relayGasEquiv: 0n, // free
      gasAmount: undefined,
    });
    expect(ega).toBe(0n);
    const breakdown = paymentBreakdown({
      totalWei,
      token: 'jpyc',
      payMode: 'gasless',
      gasMode,
      effectiveGasAmount: ega,
    });
    expect(breakdown.merchantReceives).toBe(3000n * JPYC);
    expect(breakdown.customerPays).toBe(3000n * JPYC);
    expect(networkFeeEquivalentValue(route, ega)).toBe(0n);
    expect(
      gasReimbursementValue(route, {
        isJpyc: true,
        paymasterMode: 'sponsorship',
        gasAmount: undefined,
      }),
    ).toBe(0n);
  });

  it('JPYC relay recover (回収額 2 JPYC): gasMode=merchant 強制, merchant=2998, netFee=2', () => {
    const route = ROUTES.relayRecover;
    const totalWei = 3000n * JPYC;
    const relayGasEquiv = 2n * JPYC; // recover 回収額 (bps=0 フロア)
    // URL gas=customer でも recover は merchant 強制。
    const gasMode = effectiveGasMode(route, 'customer');
    expect(gasMode).toBe('merchant');
    const ega = effectiveGasAmount(route, {
      isJpyc: true,
      relayGasEquiv,
      gasAmount: undefined,
    });
    expect(ega).toBe(2n * JPYC);
    const breakdown = paymentBreakdown({
      totalWei,
      token: 'jpyc',
      payMode: 'gasless',
      gasMode,
      effectiveGasAmount: ega,
    });
    // merchant 吸収: merchant = value - 回収額、customer = value (満額)。
    expect(breakdown.merchantReceives).toBe((3000n - 2n) * JPYC);
    expect(breakdown.customerPays).toBe(3000n * JPYC);
    expect(networkFeeEquivalentValue(route, ega)).toBe(2n * JPYC);
  });

  it('JPYC recover 大口 + bps>0 相当 (relayGasEquiv=proportional): merchant=value-fee', () => {
    // recover で bps>0 のとき relayGasEquiv は recoverFeeValue が max(floor, value×bps/10000) を返す。
    // 純関数はその解決済み値をそのまま使う (式の検証は recoverFee.test.ts)。ここでは大口で
    // proportional が floor を超える値 (例: 1% = 100 JPYC > floor 2 JPYC) を与えて breakdown を固定。
    const route = ROUTES.relayRecover;
    const totalWei = 10_000n * JPYC;
    const relayGasEquiv = 100n * JPYC; // 10000 × 1% = 100 JPYC (> floor)
    const ega = effectiveGasAmount(route, {
      isJpyc: true,
      relayGasEquiv,
      gasAmount: undefined,
    });
    const breakdown = paymentBreakdown({
      totalWei,
      token: 'jpyc',
      payMode: 'gasless',
      gasMode: effectiveGasMode(route, 'merchant'),
      effectiveGasAmount: ega,
    });
    expect(breakdown.merchantReceives).toBe((10_000n - 100n) * JPYC);
    expect(networkFeeEquivalentValue(route, ega)).toBe(100n * JPYC);
  });

  it('USDC circle gas=customer (surcharge quote): netFee=null, reimb=0, merchant=55', () => {
    const route = ROUTES.gaslessCircle;
    const totalWei = 55n * USDC;
    // circle quote の gasAmount (surcharge 込み)。circle では breakdown gas は quote 由来。
    const gasAmount = 0n; // circle surcharge は permitAmount 側に乗り gasAmount=0 のケース (テスト相当)
    const ega = effectiveGasAmount(route, {
      isJpyc: false,
      relayGasEquiv: 0n,
      gasAmount,
    });
    const breakdown = paymentBreakdown({
      totalWei,
      token: 'usdc',
      payMode: 'gasless',
      gasMode: effectiveGasMode(route, 'customer'),
      effectiveGasAmount: ega,
    });
    expect(breakdown.merchantReceives).toBe(55n * USDC);
    // circle は networkFeeEquivalent / gasReimbursement とも別系統 (null / 0)。
    expect(networkFeeEquivalentValue(route, ega)).toBeNull();
    expect(
      gasReimbursementValue(route, {
        isJpyc: false,
        paymasterMode: 'erc20',
        gasAmount,
      }),
    ).toBe(0n);
  });

  it('standard USDC (送信テスト相当: gas は breakdown に乗らず merchant=55, fee=0)', () => {
    const route = ROUTES.standard;
    const totalWei = 55n * USDC;
    const payMode = effectivePayMode(route, undefined); // standard route → 'standard'
    expect(payMode).toBe('standard');
    // standard は !isStandard 系がすべて false: ega は gasAmount を無視せず route 分岐で
    // 「relay でも JPYC でもない」→ gasAmount を返すが、standard では gasAmount=undefined を渡す
    // (CheckoutForm: `gasAmount = !isStandard ? quote : undefined`)。
    const ega = effectiveGasAmount(route, {
      isJpyc: false,
      relayGasEquiv: 0n,
      gasAmount: undefined,
    });
    const breakdown = paymentBreakdown({
      totalWei,
      token: 'usdc',
      payMode,
      gasMode: effectiveGasMode(route, 'customer'),
      effectiveGasAmount: ega,
    });
    expect(breakdown.merchantReceives).toBe(55n * USDC);
    expect(breakdown.customerPays).toBe(55n * USDC);
    expect(breakdown.feeAmount).toBe(0n);
    // standard は networkFeeEquivalent=null。
    expect(networkFeeEquivalentValue(route, ega)).toBeNull();
  });
});
