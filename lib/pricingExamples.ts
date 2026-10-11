// 料金ページ (/pricing) の計算例。開示済みの料率と最低額 (lib/legal.ts の DISCLOSED_*) から、
// 実際の分け方と同じ式で 1 回の支払いの金額を出す純関数。
//
// 式と丸めは実装と同じ (wei の BigInt・床除算):
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

import { formatUnits } from 'viem';
import {
  DISCLOSED_MOBILE_ORDER_FEE,
  DISCLOSED_RECOVER_FEE,
  DISCLOSED_STORE_GAS_WALLET,
  DISCLOSED_X402_FEE,
} from '@/lib/legal';

const JPYC_DECIMALS = 18;
const WEI_PER_JPYC = 10n ** BigInt(JPYC_DECIMALS);
const BPS_DENOM = 10_000n;

/**
 * 計算例の金額 (JPYC)。料率ではないので定数で持つ。
 * 表 A・C の先頭は「最低額が効く例」・2 つ目は「効かない例」(テストが両方あることを確かめる)。
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

export type PricingExample = {
  /** 決済額・注文額・価格 */
  readonly amountWei: bigint;
  /** OpenPay に届く分 (利用料・x402 利用料・1 wei) */
  readonly feeWei: bigint;
  /** 料率をかけただけの額 (最低額を当てる前)。最低額の説明の文に使う。 */
  readonly percentPartWei: bigint;
  /** 払う人が払う額 */
  readonly payerPaysWei: bigint;
  /** 受け取る人 (お店・売り手) が受け取る額 */
  readonly receiverGetsWei: bigint;
  /** 料率をかけた額が最低額より小さく、最低額になったか */
  readonly floorApplied: boolean;
};

function jpycToWei(amountJpyc: number): bigint {
  return BigInt(amountJpyc) * WEI_PER_JPYC;
}

function percentOf(amountWei: bigint, bps: number): bigint {
  return (amountWei * BigInt(bps)) / BPS_DENOM;
}

/** 最低額つきの料率 (recover と x402 の共通の形): max(最低額, 額 × bps / 10000) */
function feeWithFloor(amountWei: bigint, bps: number, floorJpyc: number) {
  const percentPartWei = percentOf(amountWei, bps);
  const floorWei = jpycToWei(floorJpyc);
  return {
    percentPartWei,
    feeWei: percentPartWei > floorWei ? percentPartWei : floorWei,
    floorApplied: percentPartWei < floorWei,
  };
}

/** ガスレス決済 (決済QR・レジ・JPYC)。お店が払う: お客様は表示額だけ・お店の受け取り = 額 − 利用料。 */
export function gaslessExample(amountJpyc: number): PricingExample {
  const amountWei = jpycToWei(amountJpyc);
  const { percentPartWei, feeWei, floorApplied } = feeWithFloor(
    amountWei,
    DISCLOSED_RECOVER_FEE.percentFromJulyBps,
    DISCLOSED_RECOVER_FEE.floorJpyc,
  );
  return {
    amountWei,
    feeWei,
    percentPartWei,
    payerPaysWei: amountWei,
    receiverGetsWei: amountWei > feeWei ? amountWei - feeWei : 0n,
    floorApplied,
  };
}

/**
 * ガスレス決済を使えない決済額の上限 (この額以下は使えない)。お店の受け取りが 0 以下になる境界
 * (`buildRecoverFeeDisplay` の tooSmall = 決済額 ≤ 利用料) で、料率が 100% 未満なら最低額と同じ。
 */
export function gaslessUnavailableUpToWei(): bigint {
  return jpycToWei(DISCLOSED_RECOVER_FEE.floorJpyc);
}

function mobileFee(
  amountWei: bigint,
  bps: number,
  feePayer: 'shop' | 'customer',
): PricingExample {
  const feeWei = percentOf(amountWei, bps);
  return {
    amountWei,
    feeWei,
    percentPartWei: feeWei,
    payerPaysWei: feePayer === 'customer' ? amountWei + feeWei : amountWei,
    receiverGetsWei:
      feePayer === 'customer' ? amountWei : amountWei > feeWei ? amountWei - feeWei : 0n,
    // モバイル注文の利用料に最低額は無い。
    floorApplied: false,
  };
}

/** モバイル注文 (お客様が注文ページで払う注文)。店内・券売機と事前注文を、どちらもお店が払う形で出す。 */
export function mobileExample(amountJpyc: number): {
  readonly storefront: PricingExample;
  readonly preorder: PricingExample;
} {
  const amountWei = jpycToWei(amountJpyc);
  return {
    storefront: mobileFee(amountWei, DISCLOSED_MOBILE_ORDER_FEE.storefrontBps, 'shop'),
    preorder: mobileFee(amountWei, DISCLOSED_MOBILE_ORDER_FEE.preorderBps, 'shop'),
  };
}

/** 事前注文の負担の分け方 (お店が選ぶ)。お客様の上乗せ / お店が払う。 */
export function preorderSplit(amountJpyc: number): {
  readonly customerAdds: PricingExample;
  readonly shopPays: PricingExample;
} {
  const amountWei = jpycToWei(amountJpyc);
  return {
    customerAdds: mobileFee(amountWei, DISCLOSED_MOBILE_ORDER_FEE.preorderBps, 'customer'),
    shopPays: mobileFee(amountWei, DISCLOSED_MOBILE_ORDER_FEE.preorderBps, 'shop'),
  };
}

/** デジタル商品 (x402・JPYC)。買い手が上乗せ: 買い手の支払い = 価格 + x402 利用料・売り手 = 価格。 */
export function digitalExample(amountJpyc: number): PricingExample {
  const amountWei = jpycToWei(amountJpyc);
  const { percentPartWei, feeWei, floorApplied } = feeWithFloor(
    amountWei,
    DISCLOSED_X402_FEE.bps,
    DISCLOSED_X402_FEE.floorJpyc,
  );
  return {
    amountWei,
    feeWei,
    percentPartWei,
    payerPaysWei: amountWei + feeWei,
    receiverGetsWei: amountWei,
    floorApplied,
  };
}

/** お店がガス代を肩代わりして送る。お客様の支払い = 額 + feeWei・お店の受け取り = 額 (ガス代はお店が別に払う)。 */
export function storeGasExample(amountJpyc: number): PricingExample {
  const amountWei = jpycToWei(amountJpyc);
  const feeWei = BigInt(DISCLOSED_STORE_GAS_WALLET.feeWei);
  return {
    amountWei,
    feeWei,
    percentPartWei: feeWei,
    payerPaysWei: amountWei + feeWei,
    receiverGetsWei: amountWei,
    floorApplied: false,
  };
}

/** bps → 本文の「1%」「1.7%」 */
export function percentLabel(bps: number): string {
  return `${bps / 100}%`;
}

/** wei → JPYC の数字 (整数部だけ 3 桁区切り・小数はそのまま)。ja / en で同じ書き方。 */
export function formatJpycWei(wei: bigint): string {
  const [whole, fraction] = formatUnits(wei, JPYC_DECIMALS).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
