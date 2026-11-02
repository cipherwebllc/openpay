// /create の「注文リンク」: 通販の注文ごとに、お客様へ送る /checkout のリンクを作る純ロジック。
// 何もサーバーへ送らず、氏名や住所の欄も持たない (住所は販売者が自分の注文フォームで持つ・2026-11-02 user 裁定)。
// 公開の文書 (docs/CHECKOUT.md) に載せたパラメーターだけを使い、内部用のパラメーターは足さない。
// 利用料は /checkout の実際の計算と同じ関数で出し、作った URL は parse で読み直す
// (お客様の画面で開けないリンクや、入力と違う内容のリンクを渡さないため)。

import { formatUnits, type Address } from 'viem';
import type { ChainSlug } from './chains';
import type { PayMode } from './fee';
import { jpycForwarderFor } from './relay/forwarderConfig';
import { recoverFeeValue } from './relay/recoverFee';
import { deploymentForSlug, isGaslessSupported } from './tokens';
import {
  buildCheckoutUrl,
  calcCheckoutTotal,
  CHECKOUT_MAX_ITEMS,
  CHECKOUT_QTY_MAX,
  parseCheckoutParams,
  type CheckoutItem,
} from './url/checkout';
import { DECIMAL_PATTERN } from './url/shared';

export const ORDER_LINK_ID_MAX = 64;
export const ORDER_LINK_NAME_MAX = 80;
export const ORDER_LINK_DESCRIPTION_MAX = 200;

/** 入力の 1 行。数量と単価は打っている途中の文字列のまま持つ。 */
export type OrderLinkLine = {
  name: string;
  qty: string;
  price: string;
};

export type OrderLinkInput = {
  origin: string;
  to: Address | null;
  chain: ChainSlug;
  mode: PayMode;
  orderId: string;
  description: string;
  lines: readonly OrderLinkLine[];
  shipping: string;
  /** 送料の行の名前 (表示言語の文字列)。 */
  shippingLabel: string;
};

export type OrderLinkError =
  | 'receiver'
  | 'orderId'
  | 'noItems'
  | 'item'
  | 'shipping'
  | 'tooManyLines'
  | 'tooSmall'
  | 'invalid';

export type OrderLinkResult =
  | { ok: true; url: string; total: string; fee: string; receive: string }
  | { ok: false; error: OrderLinkError; minimum?: string };

function isBlankLine(line: OrderLinkLine): boolean {
  return line.name.trim() === '' && line.price.trim() === '';
}

function isPositiveDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && !/^0*(\.0+)?$/.test(value);
}

function toCheckoutItem(line: OrderLinkLine): CheckoutItem | null {
  const name = line.name.trim();
  const qtyText = line.qty.trim();
  const price = line.price.trim();
  if (!name || !/^\d+$/.test(qtyText) || !isPositiveDecimal(price)) return null;
  const qty = Number(qtyText);
  if (qty < 1 || qty > CHECKOUT_QTY_MAX) return null;
  return { name, qty, price };
}

/** /checkout と同じ扱いの利用料。通常決済と、forwarder の無いチェーンのガスレスは 0。 */
export function orderLinkFeeWei(totalWei: bigint, chain: ChainSlug, mode: PayMode): bigint {
  const { chainId } = deploymentForSlug('jpyc', chain);
  if (mode === 'standard' || jpycForwarderFor(chainId) === null) return 0n;
  return recoverFeeValue(totalWei, 'merchant', chainId);
}

/** 注文リンクで選べる JPYC のチェーン (ガスレスが使えるもの)。 */
export function orderLinkChains(chains: readonly ChainSlug[]): ChainSlug[] {
  return chains.filter((slug) => isGaslessSupported(deploymentForSlug('jpyc', slug)));
}

export function buildOrderLink(input: OrderLinkInput): OrderLinkResult {
  if (input.to === null) return { ok: false, error: 'receiver' };
  const orderId = input.orderId.trim();
  if (!orderId || orderId.length > ORDER_LINK_ID_MAX) return { ok: false, error: 'orderId' };

  const filled = input.lines.filter((line) => !isBlankLine(line));
  if (filled.length === 0) return { ok: false, error: 'noItems' };
  const items: CheckoutItem[] = [];
  for (const line of filled) {
    const item = toCheckoutItem(line);
    if (item === null) return { ok: false, error: 'item' };
    items.push(item);
  }

  const shipping = input.shipping.trim();
  if (shipping !== '' && !DECIMAL_PATTERN.test(shipping)) return { ok: false, error: 'shipping' };
  // 送料 0 は行を出さない (/checkout は単価 0 の行を受け付けない)。
  if (isPositiveDecimal(shipping)) items.push({ name: input.shippingLabel, qty: 1, price: shipping });
  if (items.length > CHECKOUT_MAX_ITEMS) return { ok: false, error: 'tooManyLines' };

  const description = input.description.trim();
  const url = buildCheckoutUrl(input.origin, {
    to: input.to,
    token: 'jpyc',
    chain: input.chain,
    gas: 'customer',
    mode: input.mode,
    items,
    orderId,
    ...(description ? { description } : {}),
  });

  const parsed = parseCheckoutParams(new URL(url).searchParams);
  if (!parsed.ok) return { ok: false, error: 'invalid' };
  const sameItems =
    parsed.params.items.length === items.length &&
    parsed.params.items.every(
      (item, index) =>
        item.name === items[index].name &&
        item.qty === items[index].qty &&
        item.price === items[index].price,
    );
  if (!sameItems) return { ok: false, error: 'item' };
  if (parsed.params.orderId !== orderId) return { ok: false, error: 'orderId' };

  const { decimals } = deploymentForSlug('jpyc', input.chain);
  const totalWei = calcCheckoutTotal(parsed.params.items, decimals);
  const feeWei = orderLinkFeeWei(totalWei, input.chain, input.mode);
  // 利用料以下の支払いは /checkout が止める (お店の受取が 0 になる) ので、リンクを渡す前に知らせる。
  if (feeWei > 0n && totalWei <= feeWei) {
    return { ok: false, error: 'tooSmall', minimum: formatUnits(feeWei, decimals) };
  }
  return {
    ok: true,
    url,
    total: formatUnits(totalWei, decimals),
    fee: formatUnits(feeWei, decimals),
    receive: formatUnits(totalWei - feeWei, decimals),
  };
}
