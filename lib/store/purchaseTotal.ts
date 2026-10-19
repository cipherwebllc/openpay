import { formatUnits } from 'viem';
import { hostedPurchaseFeeValue } from '@/lib/x402/hostedPurchaseWire';

/**
 * 買い手の支払総額 (価格 + 買い手負担 x402 手数料) の JPYC 表記。表示用。
 * 式は hostedPurchaseFeeValue (購入 hook が server quote を同式で検証する単一ソース) — 商品カード・公開一覧 API・
 * 商品ページの JSON-LD と同じ値になる。SNS に貼ったときの説明文と OG カードもこの総額で出す (2026-10-19 user 裁定)。
 */
export function hostedPurchaseTotalJpyc(priceJpyc: string): string {
  const merchantValue = BigInt(priceJpyc) * 10n ** 18n;
  return formatUnits(merchantValue + hostedPurchaseFeeValue(merchantValue), 18);
}
