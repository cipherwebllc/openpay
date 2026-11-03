// /create の「注文リンク」: 通販の注文ごとに、お客様へ送る /checkout のリンクを作る純ロジック。
// 何もサーバーへ送らず、氏名や住所の欄も持たない (住所は販売者が自分の注文フォームで持つ・2026-11-02 user 裁定)。
// 「何度でも使える」リンク (reusable) は番号を持たず ship=ask を付ける: お客様は払った後、完了画面から
// お名前とお届け先を自分の LINE やメールでお店へ送る (plans/order-link-reusable.md・2026-11-03 user「進めて」)。
// 公開の文書 (docs/CHECKOUT.md) に載せたパラメーターだけを使う。例外は消費税 (明細の税率) とインボイス登録番号 (inv) で、
// レジと同じ OpenPay 自身のリンクの値 (お客様の控えに出す表示だけ・金額・受取先・利用料には関わらない)。
// 税率と登録番号が効くのはお客様の控えだけで、お店の履歴には残らない (/checkout の履歴は払った人の端末に残る)。
// 利用料は /checkout の実際の計算と同じ関数で出し、作った URL は parse で読み直す
// (お客様の画面で開けないリンクや、入力と違う内容のリンクを渡さないため)。

import { formatUnits, parseUnits, type Address } from 'viem';
import type { ChainSlug } from './chains';
import type { PayMode } from './fee';
import { resolveUsdcGaslessProvider } from './circlePaymaster';
import { resolveJpycGaslessProvider } from './jpycGaslessProvider';
import { isRecoverRoute, resolvePaymentRoute } from './paymentRoute';
import { jpycForwarderFor } from './relay/forwarderConfig';
import { recoverFeeValue } from './relay/recoverFee';
import { buildCheckoutLineItems } from './checkoutLineItems';
import { parseDiscountAmount } from './discount';
import { normalizeInvoiceRegistrationNumber } from './invoice';
import { sameShopContact, type ShopContact } from './shopContact';
import { defaultRateForCategory, lineItemsTax, taxDisplayDecimals } from './tax';
import { deploymentForSlug, isGaslessSupported } from './tokens';
import {
  buildCheckoutUrl,
  calcCheckoutPayable,
  calcCheckoutTotal,
  CHECKOUT_MAX_ITEMS,
  CHECKOUT_QTY_MAX,
  CHECKOUT_STORE_NAME_MAX,
  parseCheckoutParams,
  type CheckoutItem,
} from './url/checkout';
import { DECIMAL_PATTERN, sanitizeText } from './url/shared';

export const ORDER_LINK_ID_MAX = 64;
export const ORDER_LINK_FIRST_ID = 'A-001';
export const ORDER_LINK_NAME_MAX = 80;
export const ORDER_LINK_DESCRIPTION_MAX = 200;
// 店名は /checkout の store (お客様の画面の頭と控えに出る) と同じ上限。
export const ORDER_LINK_STORE_NAME_MAX = CHECKOUT_STORE_NAME_MAX;
// ガスレスの 1 回の上限。サーバーの RELAY_MAX_JPYC の既定値と同じ (tests/lib/orderLink.test.ts が照合する)。
// 超えるリンクは /checkout で開けても relay が断る。
export const ORDER_LINK_GASLESS_MAX_JPYC = 50_000n;
// 通常決済の上限。手入力の桁の間違いを止めるための値で、Store の出品上限に揃えた。
export const ORDER_LINK_STANDARD_MAX_JPYC = 1_000_000n;

/**
 * 次の注文番号。末尾の数字に 1 を足し、桁数は保つ (A-001→A-002・ORD-105→ORD-106・A-999→A-1000)。
 * 末尾が数字でない独自の番号は続きを決められないので空にする (使う人が入れる)。
 */
export function nextOrderLinkId(last: string): string {
  const match = /^(.*?)(\d+)$/.exec(last.trim());
  if (match === null) return '';
  const [, prefix, digits] = match;
  const next = `${prefix}${(BigInt(digits) + 1n).toString().padStart(digits.length, '0')}`;
  return next.length > ORDER_LINK_ID_MAX ? '' : next;
}

/** 注文リンクで選べる消費税の区分 (表示の順)。対象外・任意の率は通販の商品では使わないので出さない。 */
export const ORDER_LINK_TAX_CATEGORIES = ['taxable_10', 'taxable_8', 'tax_free'] as const;
export type OrderLinkTax = (typeof ORDER_LINK_TAX_CATEGORIES)[number];

export function isOrderLinkTax(value: unknown): value is OrderLinkTax {
  return typeof value === 'string' && (ORDER_LINK_TAX_CATEGORIES as readonly string[]).includes(value);
}

/** 入力の 1 行。数量と単価は打っている途中の文字列のまま持つ。 */
export type OrderLinkLine = {
  name: string;
  qty: string;
  price: string;
  /** この商品の消費税。無い・null = 設定の税率に従う。 */
  tax?: OrderLinkTax | null;
};

export type OrderLinkInput = {
  origin: string;
  to: Address | null;
  /**
   * 受け付けるチェーン (1 つ以上・先頭が主)。2 つ以上ならリンクに chains を入れ、お客様が払う前に選ぶ
   * (plans/order-link-multichain.md)。受取先は全チェーンで同じアドレス。
   */
  chains: readonly ChainSlug[];
  mode: PayMode;
  /** 番号なしで何度でも使えるリンク (ship=ask)。true なら orderId は使わない。 */
  reusable: boolean;
  orderId: string;
  /** 注文の送り先。'invalid' = 打った値の形が合わない (リンクを作らせない)。 */
  contact: ShopContact | null | 'invalid';
  description: string;
  /** お客様の画面の頭と控えに出す店名 (空なら付けない)。 */
  storeName: string;
  lines: readonly OrderLinkLine[];
  shipping: string;
  /** 送料の行の名前 (表示言語の文字列)。 */
  shippingLabel: string;
  /**
   * 値引き (任意・JPYC の 10 進・リンクの disc)。商品の合計 (送料を除く) より小さい 1 JPYC 単位の額。
   * 'invalid' = 打った値引きが使えない (リンクを作らせない・理由は値引きの欄が出す)。
   */
  discount?: string | 'invalid';
  /**
   * 消費税 (任意)。商品の税率の既定 (行の tax が無ければこれ)。null = 税の情報を入れない (今までのリンク)。
   * 入れると送料は課税 10% (別に請求する送料は、軽減税率の商品の送料でも標準税率)。
   */
  tax?: OrderLinkTax | null;
  /** インボイス登録番号 (打ったままの文字列)。消費税を入れるときだけ、形の合う番号をリンクに入れる。 */
  invoiceNo?: string;
};

export type OrderLinkError =
  | 'receiver'
  | 'receiverResolving'
  | 'orderId'
  | 'contact'
  // 受取チェーンが 2 つ以上のときの受取ウォレットの確認 (画面が足す・buildOrderLink は返さない)。
  | 'chainChecking'
  | 'chainContract'
  | 'chainCheckFailed'
  | 'noItems'
  | 'item'
  | 'shipping'
  | 'discount'
  | 'tooManyLines'
  | 'tooSmall'
  | 'tooLarge'
  | 'invalid';

/** チェーンごとの利用料と届く額 (最低額がチェーンで違うことがある)。 */
export type OrderLinkChainAmount = { chain: ChainSlug; fee: string; receive: string };

export type OrderLinkResult =
  | {
      ok: true;
      url: string;
      total: string;
      fee: string;
      receive: string;
      byChain: OrderLinkChainAmount[];
      /** うち消費税 (JPYC・税率ごとに 1 回丸めた合計・控えと同じ計算)。消費税を入れないリンクは無し。 */
      tax?: string;
    }
  | { ok: false; error: OrderLinkError; minimum?: string; maximum?: string; total?: string };

function isBlankLine(line: OrderLinkLine): boolean {
  return line.name.trim() === '' && line.price.trim() === '';
}

function isPositiveDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && !/^0*(\.0+)?$/.test(value);
}

export type OrderLinkLineIssue = 'name' | 'qty' | 'price';

/**
 * 直してほしい欄。打っている途中で赤くしないよう、まだ空の単価は問題にしない。
 * 単価が入っているのに商品名が無いときは商品名を示す。
 */
export function orderLinkLineIssues(line: OrderLinkLine): OrderLinkLineIssue[] {
  if (isBlankLine(line)) return [];
  const issues: OrderLinkLineIssue[] = [];
  const price = line.price.trim();
  const qtyText = line.qty.trim();
  if (!line.name.trim() && price) issues.push('name');
  const qty = Number(qtyText);
  if (!/^\d+$/.test(qtyText) || qty < 1 || qty > CHECKOUT_QTY_MAX) issues.push('qty');
  if (price && !isPositiveDecimal(price)) issues.push('price');
  return issues;
}

function toCheckoutItem(line: OrderLinkLine, tax: OrderLinkTax | null): CheckoutItem {
  const item: CheckoutItem = { name: line.name.trim(), qty: Number(line.qty.trim()), price: line.price.trim() };
  const category = tax === null ? null : line.tax ?? tax;
  return category === null ? item : { ...item, ...orderLinkTaxFields(category) };
}

/** 明細に入れる税率と区分 (lib/tax の区分の既定の率)。 */
function orderLinkTaxFields(category: OrderLinkTax): { taxRate: number; taxCategory: OrderLinkTax } {
  return { taxRate: defaultRateForCategory(category) ?? 0, taxCategory: category };
}

/**
 * /checkout と同じ経路の判定で利用料を出す。回収の経路 (relay + forwarder) だけが利用料を取り、
 * 通常決済・forwarder の無いチェーン・relay が無効の設定では 0。
 * お客様が /checkout で通常決済に切り替えた場合は 0 になる (呼び出し側の案内を参照)。
 */
export function orderLinkFeeWei(totalWei: bigint, chain: ChainSlug, mode: PayMode): bigint {
  const deployment = deploymentForSlug('jpyc', chain);
  const { chainId } = deployment;
  const route = resolvePaymentRoute({
    isStandard: mode === 'standard',
    jpycGaslessProvider: resolveJpycGaslessProvider(deployment, chainId),
    usdcGaslessProvider: resolveUsdcGaslessProvider(deployment, chainId),
    hasJpycForwarder: jpycForwarderFor(chainId) !== null,
  });
  return isRecoverRoute(route) ? recoverFeeValue(totalWei, 'merchant', chainId) : 0n;
}

/** 注文リンクで選べる JPYC のチェーン (ガスレスが使えるもの)。 */
export function orderLinkChains(chains: readonly ChainSlug[]): ChainSlug[] {
  return chains.filter((slug) => isGaslessSupported(deploymentForSlug('jpyc', slug)));
}

/** 1 行の小計 (数量 × 単価)。読めない行と、まだ単価がない行は null。 */
export function orderLinkLineAmount(line: OrderLinkLine): string | null {
  const price = line.price.trim();
  if (!price || orderLinkLineIssues(line).length > 0) return null;
  return formatUnits(parseUnits(price, 18) * BigInt(line.qty.trim()), 18);
}

/**
 * 値引きをかける額 = 商品の合計 (wei・送料を除く)。読める行だけを足す (打っている途中でも割引率の額を見せる)。
 * 送料を除くのは、通販の「◯% 引き」は商品にかけるのが普通で、送料まで割り引くと店が思ったより多く引くため。
 */
export function orderLinkGoodsWei(lines: readonly OrderLinkLine[]): bigint {
  return lines.reduce((sum, line) => {
    const amount = orderLinkLineAmount(line);
    return amount === null ? sum : sum + parseUnits(amount, 18);
  }, 0n);
}

/** ガス代不要の上限を超えた注文を、通常決済に切り替えれば作れるか。 */
export function orderLinkFitsStandard(total: string): boolean {
  return parseUnits(total, 18) <= ORDER_LINK_STANDARD_MAX_JPYC * 10n ** 18n;
}

/** 見本の 1 行。 */
export type OrderLinkPreviewLine = { name: string; qty: number; amount: string };

/**
 * お客様の画面の見本に出す行。打っている途中でも分かる範囲で見せる (読めない行は飛ばす)。
 * 金額は表示用の 10 進の文字列。
 */
export function orderLinkPreviewLines(
  lines: readonly OrderLinkLine[],
  shipping: string,
  shippingLabel: string,
): OrderLinkPreviewLine[] {
  const preview: OrderLinkPreviewLine[] = [];
  for (const line of lines) {
    const name = line.name.trim();
    const amount = orderLinkLineAmount(line);
    if (!name || amount === null) continue;
    preview.push({ name, qty: Number(line.qty.trim()), amount });
  }
  const fee = shipping.trim();
  if (preview.length > 0 && isPositiveDecimal(fee)) {
    preview.push({ name: shippingLabel, qty: 1, amount: fee });
  }
  return preview;
}

export function buildOrderLink(input: OrderLinkInput): OrderLinkResult {
  if (input.to === null) return { ok: false, error: 'receiver' };
  if (input.contact === 'invalid') return { ok: false, error: 'contact' };
  const contact = input.contact;
  const orderId = input.reusable ? '' : input.orderId.trim();
  if (!input.reusable && (!orderId || orderId.length > ORDER_LINK_ID_MAX)) return { ok: false, error: 'orderId' };

  const filled = input.lines.filter((line) => !isBlankLine(line));
  if (filled.length === 0) return { ok: false, error: 'noItems' };
  if (filled.some((line) => orderLinkLineIssues(line).length > 0)) return { ok: false, error: 'item' };
  // 打っている途中 (商品名か単価のどちらかがまだ空) は誤りとして扱わない。
  if (filled.some((line) => !line.name.trim() || !line.price.trim())) return { ok: false, error: 'noItems' };
  const tax = input.tax ?? null;
  const items = filled.map((line) => toCheckoutItem(line, tax));

  // 値引きは商品の合計 (送料を除く) より小さい 1 JPYC 単位の額だけ (/checkout は送料を含めた小計と比べるので、これで必ず通る)。
  const discount = input.discount ?? '';
  if (
    discount === 'invalid' ||
    (discount !== '' &&
      parseDiscountAmount(discount, calcCheckoutTotal(items, 18), 18, taxDisplayDecimals('jpyc')) === null)
  ) {
    return { ok: false, error: 'discount' };
  }

  const shipping = input.shipping.trim();
  if (shipping !== '' && !DECIMAL_PATTERN.test(shipping)) return { ok: false, error: 'shipping' };
  // 送料 0 は行を出さない (/checkout は単価 0 の行を受け付けない)。消費税を入れるリンクの送料は課税 10%。
  if (isPositiveDecimal(shipping)) {
    items.push({
      name: input.shippingLabel,
      qty: 1,
      price: shipping,
      ...(tax === null ? {} : orderLinkTaxFields('taxable_10')),
    });
  }
  if (items.length > CHECKOUT_MAX_ITEMS) return { ok: false, error: 'tooManyLines' };
  // 登録番号は消費税を入れるリンクだけ (税率の無い控えはインボイスにならない)。形の合わない番号は入れない
  // (欄が注意を出す・QR と同じ)。
  const invoiceNo = tax === null ? '' : normalizeInvoiceRegistrationNumber(input.invoiceNo ?? '') ?? '';

  const description = input.description.trim();
  // /checkout の parse と同じ整え方 (制御文字を除き上限で切る) をしてから入れ、読み直した値と比べる。
  const storeName = sanitizeText(input.storeName.trim(), ORDER_LINK_STORE_NAME_MAX) ?? '';
  const chains = input.chains.filter((chain, index) => input.chains.indexOf(chain) === index);
  if (chains.length === 0) return { ok: false, error: 'invalid' };
  const primary = chains[0];
  const url = buildCheckoutUrl(input.origin, {
    to: input.to,
    token: 'jpyc',
    chain: primary,
    ...(chains.length >= 2 ? { chains: [...chains] } : {}),
    gas: 'customer',
    mode: input.mode,
    items,
    ...(input.reusable ? { ship: 'ask' as const } : { orderId }),
    ...(description ? { description } : {}),
    ...(storeName ? { storeName } : {}),
    ...(contact ? { contact } : {}),
    ...(discount ? { discount } : {}),
    ...(invoiceNo ? { invoiceNo } : {}),
  });

  const parsed = parseCheckoutParams(new URL(url).searchParams);
  if (!parsed.ok) return { ok: false, error: 'invalid' };
  const sameItems =
    parsed.params.items.length === items.length &&
    parsed.params.items.every(
      (item, index) =>
        item.name === items[index].name &&
        item.qty === items[index].qty &&
        item.price === items[index].price &&
        item.taxRate === items[index].taxRate &&
        item.taxCategory === items[index].taxCategory,
    );
  if (!sameItems) return { ok: false, error: 'item' };
  if ((parsed.params.invoiceNo ?? '') !== invoiceNo) return { ok: false, error: 'invalid' };
  if ((parsed.params.orderId ?? '') !== orderId) return { ok: false, error: 'orderId' };
  if ((parsed.params.ship === 'ask') !== input.reusable) return { ok: false, error: 'invalid' };
  if (!sameShopContact(parsed.params.contact, contact)) return { ok: false, error: 'invalid' };
  if ((parsed.params.description ?? '') !== description) return { ok: false, error: 'invalid' };
  if ((parsed.params.storeName ?? '') !== storeName) return { ok: false, error: 'invalid' };
  if ((parsed.params.discount ?? '') !== discount) return { ok: false, error: 'discount' };
  // 受け付けるチェーンを読み直しで確かめる (使えないチェーンは /checkout が黙って外すので、ここで食い違いを止める)。
  const parsedChains = parsed.params.chains ?? [parsed.params.chain];
  if (parsedChains.length !== chains.length || parsedChains.some((chain, index) => chain !== chains[index])) {
    return { ok: false, error: 'invalid' };
  }

  const { decimals } = deploymentForSlug('jpyc', primary);
  // お客様が払う額 = 小計 − 値引き (/checkout と同じ関数)。上限・利用料・届く額はこの額で出す。
  const totalWei = calcCheckoutPayable(parsed.params, decimals);
  const maximum = input.mode === 'standard' ? ORDER_LINK_STANDARD_MAX_JPYC : ORDER_LINK_GASLESS_MAX_JPYC;
  if (totalWei > maximum * 10n ** BigInt(decimals)) {
    return { ok: false, error: 'tooLarge', maximum: maximum.toString(), total: formatUnits(totalWei, decimals) };
  }
  // 利用料はチェーンごと (最低額がチェーンで違うことがある)。どれかのチェーンで利用料以下なら /checkout がそのチェーンで
  // 止める (お店の受取が 0 になる) ので、リンクを渡す前に知らせる (いちばん高い最低額を出す)。
  const fees = chains.map((chain) => ({ chain, feeWei: orderLinkFeeWei(totalWei, chain, input.mode) }));
  const highest = fees.reduce((max, entry) => (entry.feeWei > max ? entry.feeWei : max), 0n);
  if (highest > 0n && totalWei <= highest) {
    return { ok: false, error: 'tooSmall', minimum: formatUnits(highest, decimals), total: formatUnits(totalWei, decimals) };
  }
  const byChain = fees.map(({ chain, feeWei }) => ({
    chain,
    fee: formatUnits(feeWei, decimals),
    receive: formatUnits(totalWei - feeWei, decimals),
  }));
  return {
    ok: true,
    url,
    total: formatUnits(totalWei, decimals),
    fee: byChain[0].fee,
    receive: byChain[0].receive,
    byChain,
    // うち消費税: お客様の控えと同じ関数 (値引きを税率ごと → 明細へ按分し、税率ごとに 1 回丸める)。
    ...(tax === null
      ? {}
      : {
          tax: lineItemsTax(
            buildCheckoutLineItems({
              items: parsed.params.items,
              ...(parsed.params.discount ? { discount: parsed.params.discount } : {}),
              token: 'jpyc',
              decimals,
            }),
            decimals,
            taxDisplayDecimals('jpyc'),
          ).totalTax,
        }),
  };
}
