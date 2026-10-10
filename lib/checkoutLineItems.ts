// /checkout の会計 (items + 値引き) から履歴・控えの売上明細 (HistoryLineItem) を組む。通常の支払い (CheckoutForm) と
// お店の端末で送る支払い (StoreDeviceCheckoutForm) が共有する単一情報源。値引きは税率ごと → 明細の順に按分して
// 行に固定し (lib/discount.ts)、行の税額は値引き後の税率ごとの合計から 1 回丸めた税額を行へ配った額
// (lib/tax.ts の taxByRate・インボイスと同じ)。値引きが無ければ値引きの欄を持たない明細になる。

import { formatUnits, parseUnits } from 'viem';
import { allocateDiscount, discountUnit } from './discount';
import type { HistoryLineItem } from './history';
import { taxByRate, taxDisplayDecimals, type TaxCategory } from './tax';
import type { TokenSymbol } from './tokens';
import { calcCheckoutTotal, type CheckoutItem } from './url/checkout';

export function buildCheckoutLineItems(args: {
  items: readonly CheckoutItem[];
  /** 値引き額 (token 単位の 10 進・parse 済み)。不在 = 値引きなし。 */
  discount?: string;
  token: TokenSymbol;
  decimals: number;
  /** checkout 単位の税 (行に税が無いときの fallback)。 */
  taxRate?: number | null;
  taxCategory?: TaxCategory | null;
}): HistoryLineItem[] {
  const { items, token, decimals } = args;
  const displayDecimals = taxDisplayDecimals(token);
  const lines = items.map((it) => ({
    amount: calcCheckoutTotal([it], decimals),
    // per-item 税を優先 (混在税率カート)、無ければ checkout 単位 (単一税率) に fallback。
    taxRate: it.taxRate ?? args.taxRate ?? null,
    taxCategory: it.taxCategory ?? args.taxCategory ?? null,
  }));
  const discounts = args.discount
    ? allocateDiscount(lines, parseUnits(args.discount, decimals), discountUnit(decimals, displayDecimals))
    : lines.map(() => 0n);
  const { lineTax } = taxByRate(
    lines.map((l, i) => ({ charged: l.amount - discounts[i], taxRate: l.taxRate })),
    decimals,
    displayDecimals,
  );
  return items.map((it, i) => {
    const { amount, taxRate, taxCategory } = lines[i];
    const lineDiscount = discounts[i];
    const taxAmt = lineTax[i];
    return {
      id: String(i),
      name: it.name,
      quantity: it.qty,
      unitPrice: it.price,
      // amount = price × qty (値引き前・人間可読 decimal)。
      amount: formatUnits(amount, decimals),
      currency: token,
      taxRate,
      taxCategory,
      taxAmount: taxAmt == null ? '0' : formatUnits(taxAmt, displayDecimals),
      memo: it.memo ?? null,
      ...(lineDiscount > 0n ? { discount: formatUnits(lineDiscount, decimals) } : {}),
    };
  });
}
