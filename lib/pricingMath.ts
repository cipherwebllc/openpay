// 料金の計算 (料率を引数で受け取る純関数)。料金ページの計算例 (lib/pricingExamples.ts) と、
// ブラウザで動く計算機 (components/pricing/PricingCalculator.tsx) が同じ式を使うための置き場。
//
// import を持たない: lib/legal.ts は viem と env を読み込むので client の部品からは import できない。
// 料率は server 側で lib/legal.ts の DISCLOSED_* から組み立てて渡す (直書きしない)。
// 式と丸めは実装と同じ (wei の BigInt・床除算)。本物の関数との一致は tests/lib/pricingExamples.test.ts が固定する。

export const JPYC_DECIMALS = 18;
const WEI_PER_JPYC = 10n ** BigInt(JPYC_DECIMALS);
const BPS_DENOM = 10_000n;

/** 開示した料率 (lib/legal.ts の DISCLOSED_* から組み立てる・client へ props で渡せる形)。 */
export type PricingRates = {
  /** ガスレス決済 (決済QR・レジ・JPYC) の料率と最低額 */
  readonly recoverBps: number;
  readonly recoverFloorJpyc: number;
  /** モバイル注文 (店内・券売機 / 時間指定の事前注文) */
  readonly storefrontBps: number;
  readonly preorderBps: number;
  /** x402 (デジタル商品・JPYC) の料率と最低額 */
  readonly x402Bps: number;
  readonly x402FloorJpyc: number;
  /** お店がガス代を肩代わりして送るときの上乗せ (wei) */
  readonly storeGasFeeWei: number;
};

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

export function jpycToWei(amountJpyc: number): bigint {
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
export function gaslessWith(rates: PricingRates, amountWei: bigint): PricingExample {
  const { percentPartWei, feeWei, floorApplied } = feeWithFloor(amountWei, rates.recoverBps, rates.recoverFloorJpyc);
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
export function gaslessUnavailableUpToWeiWith(rates: PricingRates): bigint {
  return jpycToWei(rates.recoverFloorJpyc);
}

/** モバイル注文の利用料 (最低額なし)。feePayer = customer はお客様の上乗せ (時間指定の事前注文でお店が選べる)。 */
export function mobileFeeWith(amountWei: bigint, bps: number, feePayer: 'shop' | 'customer'): PricingExample {
  const feeWei = percentOf(amountWei, bps);
  return {
    amountWei,
    feeWei,
    percentPartWei: feeWei,
    payerPaysWei: feePayer === 'customer' ? amountWei + feeWei : amountWei,
    receiverGetsWei: feePayer === 'customer' ? amountWei : amountWei > feeWei ? amountWei - feeWei : 0n,
    floorApplied: false,
  };
}

/** デジタル商品 (x402・JPYC)。買い手が上乗せ: 買い手の支払い = 価格 + x402 利用料・売り手 = 価格。 */
export function digitalWith(rates: PricingRates, amountWei: bigint): PricingExample {
  const { percentPartWei, feeWei, floorApplied } = feeWithFloor(amountWei, rates.x402Bps, rates.x402FloorJpyc);
  return {
    amountWei,
    feeWei,
    percentPartWei,
    payerPaysWei: amountWei + feeWei,
    receiverGetsWei: amountWei,
    floorApplied,
  };
}

/** お店がガス代を肩代わりして送る。お客様の支払い = 額 + 上乗せ・お店の受け取り = 額 (ガス代はお店が別に払う)。 */
export function storeGasWith(rates: PricingRates, amountWei: bigint): PricingExample {
  const feeWei = BigInt(rates.storeGasFeeWei);
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

/** wei → JPYC の数字 (整数部だけ 3 桁区切り・小数は末尾の 0 を落としてそのまま)。ja / en で同じ書き方。 */
export function formatJpycWei(wei: bigint): string {
  const whole = (wei / WEI_PER_JPYC).toString();
  const fraction = (wei % WEI_PER_JPYC).toString().padStart(JPYC_DECIMALS, '0').replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
