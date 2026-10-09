// モバイル注文の店舗の値引き (任意・plans/discount-common.md)。公開した店舗設定 (KV の storefront) が正本で、
// 注文画面・署名前の確認 (admission)・受注 (notify)・人が払う見積もり (agent-order summary) が、この 1 か所の
// 関数で値引き額を出す (URL の値引きは信じない)。全品・条件なし・1 注文に 1 つ。モバイル注文は JPYC だけなので、
// 額は整数円・率は小数 2 桁まで (レジの値引きと同じ)。AI エージェントが x402 で払う注文には付けない (定価)。

import { discountFromPercent, discountPercentBps, parseDiscountAmount } from './discount';
import { ORDER_DUST_FLOOR_WEI } from './orderRelay';

export type StorefrontDiscount =
  | { kind: 'percent'; value: string }
  | { kind: 'amount'; value: string };

/** 1 注文の値引き額の上限 (円)。打ち間違いで桁を増やした設定を公開させない。 */
export const STOREFRONT_DISCOUNT_AMOUNT_MAX = 100_000;

/**
 * 値引き後に残す支払額の下限 (JPYC wei = 10 JPYC)。受注 (notify) は店舗の着金が 1 JPYC (ORDER_DUST_FLOOR_WEI) 未満の
 * 注文を受け付けない。店舗負担の利用料 (モバイル注文の 1〜3%・利用料 flag OFF の recover では固定 2 JPYC のフロア) を
 * 引かれても着金が 1 JPYC を割らないよう、値引きで支払額を 10 JPYC 未満にしない (払ったのに受注が残らない注文を
 * 値引きで作らない)。
 */
export const STOREFRONT_DISCOUNT_MIN_PAYABLE_WEI = 10n * ORDER_DUST_FLOOR_WEI;

/** untrusted な値 (POST /api/handle・KV) を店舗の値引きへ。形が正しければ正規化した値、それ以外は null。 */
export function validStorefrontDiscount(raw: unknown): StorefrontDiscount | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.value !== 'string') return null;
  if (o.kind === 'percent') {
    const bps = discountPercentBps(o.value);
    if (bps === null) return null;
    // 正規化 ("05" → "5"・"2.50" → "2.5")。同じ率は同じ文字列にする (公開済みとの比較・URL の照合がぶれない)。
    const whole = bps / 100n;
    const frac = (bps % 100n).toString().padStart(2, '0').replace(/0+$/, '');
    return { kind: 'percent', value: frac ? `${whole}.${frac}` : String(whole) };
  }
  if (o.kind === 'amount') {
    if (!/^\d{1,6}$/.test(o.value)) return null;
    const yen = Number(o.value);
    if (yen < 1 || yen > STOREFRONT_DISCOUNT_AMOUNT_MAX) return null;
    return { kind: 'amount', value: String(yen) };
  }
  return null;
}

/**
 * 小計 (wei) に店舗の値引きを当てた額 (wei)。率は円未満切り捨て・額は小計を下回るときだけ。値引き後の支払額が
 * 10 JPYC (STOREFRONT_DISCOUNT_MIN_PAYABLE_WEI) 未満になるなら当てない。値引きが無い・当てられないときは 0n (= 定価)。
 * モバイル注文は JPYC (18 桁) だけ。
 */
export function storefrontDiscountWei(
  discount: StorefrontDiscount | undefined,
  subtotalWei: bigint,
  decimals: number,
): bigint {
  if (!discount || subtotalWei <= 0n) return 0n;
  const wei =
    discount.kind === 'percent'
      ? discountFromPercent(subtotalWei, discount.value, decimals, 0)
      : parseDiscountAmount(discount.value, subtotalWei, decimals, 0);
  if (wei === null || subtotalWei - wei < STOREFRONT_DISCOUNT_MIN_PAYABLE_WEI) return 0n;
  return wei;
}
