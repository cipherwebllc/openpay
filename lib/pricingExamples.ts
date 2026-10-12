// 料金ページ (/pricing) の計算例。開示済みの料率と最低額 (lib/legal.ts の DISCLOSED_*) から、
// 実際の分け方と同じ式で 1 回の支払いの金額を出す純関数。
//
// 式と丸めは実装と同じ (wei の BigInt・床除算)。式そのものは lib/pricingMath.ts (料率を引数で受け取る・
// ブラウザの計算機と共用)。ここは DISCLOSED_* から料率を組み立てて渡すだけ:
//   ガスレス決済 (決済QR・レジ・JPYC) = lib/relay/recoverFee.ts recoverFeeValue (merchant) + lib/mobileOrderFee.ts feeSplit
//   モバイル注文                       = lib/mobileOrderFee.ts mobileOrderBreakdown (最低額なし)
//   デジタル商品 (x402・JPYC)          = lib/x402/fee.ts x402FeeBreakdown (買い手が上乗せ)
//   お店がガス代を肩代わり             = lib/storeDevicePayment.ts STORE_DEVICE_FEE_WEI をお客様の支払いに上乗せ
// 一致は tests/lib/pricingExamples.test.ts が本物の関数と照合して固定する (legal-check 5 の三面一致)。
//
// live env は読まない: CI は NEXT_PUBLIC_RECOVER_FEE_BPS が未設定 (= 0) なので、env から計算すると
// 1,000 JPYC の例が 2 JPYC と出て、規約に書いた料率とずれる。ページは開示した料率を出す。
// import は @/lib/legal だけにする (tests/app/pricingNoHardcode.test.tsx が @/lib/legal を差し替えて、
// ページの数字が全部追従することを確かめるため)。

import {
  DISCLOSED_MOBILE_ORDER_FEE,
  DISCLOSED_RECOVER_FEE,
  DISCLOSED_STORE_GAS_WALLET,
  DISCLOSED_X402_FEE,
} from '@/lib/legal';
import {
  digitalWith,
  formatJpycWei,
  gaslessUnavailableUpToWeiWith,
  gaslessWith,
  jpycToWei,
  mobileFeeWith,
  percentLabel,
  storeGasWith,
  type PricingExample,
  type PricingRates,
} from '@/lib/pricingMath';

export { formatJpycWei, percentLabel, type PricingExample, type PricingRates };

/**
 * 計算例の金額 (JPYC)。料率ではないので定数で持つ。
 * gasless・digital の先頭は「最低額が効く例」・2 つ目は「効かない例」(テストが両方あることを確かめる)。
 * デジタル商品は 100 JPYC だと 1% と最低額 1 JPYC がちょうど同じで「最低額が効く例」にならないので 50 JPYC。
 */
export const PRICING_EXAMPLE_AMOUNTS = {
  gasless: [100, 1_000, 10_000],
  mobile: [100, 1_000, 10_000],
  digital: [50, 1_000, 10_000],
  /** 事前注文の負担の分け方 (お客様の上乗せ / お店が払う) を文で示す額。 */
  preorderSplit: 1_000,
  /** お店がガス代を肩代わりする例の額。 */
  storeGas: 1_000,
} as const;

/** 開示した料率 (計算機へ props で渡す形)。呼ぶたびに DISCLOSED_* を読む (テストの差し替えが効くように)。 */
export function disclosedPricingRates(): PricingRates {
  return {
    recoverBps: DISCLOSED_RECOVER_FEE.percentFromJulyBps,
    recoverFloorJpyc: DISCLOSED_RECOVER_FEE.floorJpyc,
    storefrontBps: DISCLOSED_MOBILE_ORDER_FEE.storefrontBps,
    preorderBps: DISCLOSED_MOBILE_ORDER_FEE.preorderBps,
    x402Bps: DISCLOSED_X402_FEE.bps,
    x402FloorJpyc: DISCLOSED_X402_FEE.floorJpyc,
    storeGasFeeWei: Number(DISCLOSED_STORE_GAS_WALLET.feeWei),
  };
}

/** ガスレス決済 (決済QR・レジ・JPYC)。お店が払う: お客様は表示額だけ・お店の受け取り = 額 − 利用料。 */
export function gaslessExample(amountJpyc: number): PricingExample {
  return gaslessWith(disclosedPricingRates(), jpycToWei(amountJpyc));
}

/**
 * ガスレス決済を使えない決済額の上限 (この額以下は使えない)。お店の受け取りが 0 以下になる境界
 * (`buildRecoverFeeDisplay` の tooSmall = 決済額 ≤ 利用料) で、料率が 100% 未満なら最低額と同じ。
 */
export function gaslessUnavailableUpToWei(): bigint {
  return gaslessUnavailableUpToWeiWith(disclosedPricingRates());
}

/** モバイル注文 (お客様が注文ページで払う注文)。店内・券売機と事前注文を、どちらもお店が払う形で出す。 */
export function mobileExample(amountJpyc: number): {
  readonly storefront: PricingExample;
  readonly preorder: PricingExample;
} {
  const amountWei = jpycToWei(amountJpyc);
  const rates = disclosedPricingRates();
  return {
    storefront: mobileFeeWith(amountWei, rates.storefrontBps, 'shop'),
    preorder: mobileFeeWith(amountWei, rates.preorderBps, 'shop'),
  };
}

/** 事前注文の負担の分け方 (お店が選ぶ)。お客様の上乗せ / お店が払う。 */
export function preorderSplit(amountJpyc: number): {
  readonly customerAdds: PricingExample;
  readonly shopPays: PricingExample;
} {
  const amountWei = jpycToWei(amountJpyc);
  const { preorderBps } = disclosedPricingRates();
  return {
    customerAdds: mobileFeeWith(amountWei, preorderBps, 'customer'),
    shopPays: mobileFeeWith(amountWei, preorderBps, 'shop'),
  };
}

/** デジタル商品 (x402・JPYC)。買い手が上乗せ: 買い手の支払い = 価格 + x402 利用料・売り手 = 価格。 */
export function digitalExample(amountJpyc: number): PricingExample {
  return digitalWith(disclosedPricingRates(), jpycToWei(amountJpyc));
}

/** お店がガス代を肩代わりして送る。お客様の支払い = 額 + feeWei・お店の受け取り = 額 (ガス代はお店が別に払う)。 */
export function storeGasExample(amountJpyc: number): PricingExample {
  return storeGasWith(disclosedPricingRates(), jpycToWei(amountJpyc));
}
