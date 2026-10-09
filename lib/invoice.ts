// インボイス (適格簡易請求書) の記載事項を顧客の支払い控え (PayerReceipt) に出すための純関数。
// React/DOM 非依存。控えの描画 (PayerReceiptDetail)・コピー文・JSON が共有する単一情報源。
//
// 記載事項 (国税庁 インボイス Q&A): ① 発行事業者の名称と登録番号 ② 取引年月日 ③ 取引内容 (軽減税率の
// 対象品目である旨) ④ 税率ごとに区分した対価の額の合計 ⑤ 税率ごとに区分した消費税額等 (又は適用税率)。
//   - 消費税額等は「1 枚につき税率ごとに 1 回」の端数処理 (問57)。商品ごとに丸めた税額の合計は不可。
//     端数処理の方法は任意なので、既存 lib/tax.ts と同じ四捨五入にする。
//   - 消費税額等は円で記載 (問68)。対象は JPYC (1 JPYC = 1 円) のみ。USDC は換算が要るので出さない。
//   - 登録番号は「T + 13 桁」(問18)。個人事業者の番号の検査用数字の算式は公表されていないので形式だけ見る。
// 店舗が設定した値をそのまま出すだけで、OpenPay は登録状況を確かめない (控えの免責文で明示)。

import { parseUnits } from 'viem';
import { lineDiscountWei } from './discount';
import type { HistoryLineItem } from './history';
import type { PayerReceipt } from './payerReceipt';

export const INVOICE_REGISTRATION_NUMBER_PATTERN = /^T\d{13}$/;
// 設定欄の生入力の上限 (区切りや空白を含む書き方を受けるため 14 字より長めに取る)。
export const INVOICE_REGISTRATION_INPUT_MAX = 32;

// 「T-1234-5678-90123」「Ｔ１２３…」のような書き方も受ける (問18 はハイフン区切りの表記例あり)。
const INVOICE_SEPARATOR_RE = /[\s\-‐‑‒–—―−ー]/g;

/** 登録番号を正規化 (全角→半角・区切り除去・大文字化)。形式に合わなければ null。 */
export function normalizeInvoiceRegistrationNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFKC').replace(INVOICE_SEPARATOR_RE, '').toUpperCase();
  return INVOICE_REGISTRATION_NUMBER_PATTERN.test(s) ? s : null;
}

/** 国税庁 適格請求書発行事業者公表サイトの個別ページ (番号の 13 桁で直接開ける・2026-10-07 実測)。 */
export function invoiceLookupUrl(registrationNumber: string): string {
  return `https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=${registrationNumber.replace(/^T/, '')}`;
}

export type InvoiceRate = 10 | 8 | 0;

export type InvoiceRateGroup = {
  /** 10 = 標準税率・8 = 軽減税率・0 = 非課税/対象外 (消費税なし)。 */
  rate: InvoiceRate;
  /** 税込合計 (token 単位の decimal 文字列)。 */
  total: string;
  /** 消費税額 (円・整数の文字列)。rate 0 は '0'。 */
  tax: string;
};

const JPYC_DECIMALS = 18;

function toMinor(amount: string): bigint | null {
  try {
    const v = parseUnits(amount, JPYC_DECIMALS);
    return v >= 0n ? v : null;
  } catch {
    return null;
  }
}

function minorToDecimal(v: bigint): string {
  const unit = 10n ** BigInt(JPYC_DECIMALS);
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(JPYC_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

// 内税額 (円) = 税込合計 × rate / (100 + rate) を 1 回だけ四捨五入。整数演算で丸め誤差を出さない。
function innerTaxYen(totalMinor: bigint, rate: InvoiceRate): bigint {
  if (rate === 0) return 0n;
  const num = totalMinor * BigInt(rate);
  const den = BigInt(100 + rate) * 10n ** BigInt(JPYC_DECIMALS);
  return (num * 2n + den) / (den * 2n);
}

// 税率と税区分の組み合わせ。税率が未指定 (null)・10/8/0 以外・税区分と食い違う (任意税率の 8% 等)
// 行は null。軽減税率は税区分 taxable_8 で明示された 8% だけ (※ の判定を税区分に揃える)。
function invoiceRateOf(li: HistoryLineItem): InvoiceRate | null {
  const { taxRate: rate, taxCategory: category } = li;
  if (rate === 10 && (category === 'taxable_10' || category == null)) return 10;
  if (rate === 8 && category === 'taxable_8') return 8;
  if (rate === 0 && (category === 'tax_free' || category === 'out_of_scope' || category == null)) {
    return 0;
  }
  return null;
}

/**
 * 明細を税率ごとに束ねる (JPYC 前提)。並びは 10% → 8% → 0%・空のグループは出さない。
 * invoiceRateOf が null の行が 1 つでもあれば null
 * (= 記載事項がそろわない、または存在しない税率の「インボイス」になる)。
 */
export function invoiceRateGroups(
  lineItems: readonly HistoryLineItem[] | undefined,
): InvoiceRateGroup[] | null {
  if (!lineItems || lineItems.length === 0) return null;
  const sums = new Map<InvoiceRate, bigint>();
  for (const li of lineItems) {
    const rate = invoiceRateOf(li);
    if (rate == null) return null;
    const minor = toMinor(li.amount);
    if (minor == null) return null;
    // レジの値引きは支払い時に税率ごと → 明細へ按分して行に固定してある。税率ごとの対価は値引き後の額
    // (一括値引きの按分)。壊れた値引き (形が不正・行の金額を超える) の控えにはインボイス欄を出さない。
    const discount = lineDiscountWei(li, JPYC_DECIMALS);
    if (discount == null) return null;
    sums.set(rate, (sums.get(rate) ?? 0n) + minor - discount);
  }
  const order: InvoiceRate[] = [10, 8, 0];
  return order
    .filter((rate) => sums.has(rate))
    .map((rate) => {
      const totalMinor = sums.get(rate) as bigint;
      return {
        rate,
        total: minorToDecimal(totalMinor),
        tax: String(innerTaxYen(totalMinor, rate)),
      };
    });
}

export type InvoiceReceiptView = {
  issuerName: string;
  registrationNumber: string;
  groups: InvoiceRateGroup[];
  /** 軽減税率 (8%) の行があるか (明細の ※ と脚注の表示要否)。 */
  hasReducedRate: boolean;
  /** 消費税額の合計 (円)。税率ごとに丸めた額の合計。 */
  totalTax: string;
};

/**
 * 控えにインボイス欄を出せるなら、その表示用の値を返す。出せなければ null (従来の控えのまま)。
 * 条件: 支払いが確定 (confirmed)・JPYC・登録番号が形式どおり・店名がある・全行の税率と税区分が
 * 10/8/0 で整合・課税の行が 1 つ以上・明細の合計が支払総額と一致。
 * @handle の代用名 (店が付けた名前ではない) の店は、公開設定を組む側 (lib/handle/record.ts) が
 * invoiceNo を載せないので、ここまで登録番号が来ない。店名の形 (「@」始まり) では判定しない
 * (店が「@」始まりの名前を付けたなら本物の名称)。
 */
export function invoiceReceiptView(r: PayerReceipt): InvoiceReceiptView | null {
  // 失敗・未確定の控えを「支払い済みのインボイス」として共有させない。
  if (r.status !== 'confirmed') return null;
  if (r.tokenSymbol !== 'JPYC' || r.currency !== 'JPYC') return null;
  const registrationNumber = normalizeInvoiceRegistrationNumber(r.merchantInvoiceNo);
  if (!registrationNumber) return null;
  const issuerName = typeof r.merchantName === 'string' ? r.merchantName.trim() : '';
  if (!issuerName) return null;
  const groups = invoiceRateGroups(r.lineItems);
  if (!groups || !groups.some((g) => g.rate !== 0)) return null;
  // 明細の合計と支払総額が食い違う控え (店主がガス代を負担した旧い控え等) に、もっともらしい
  // 税率別の金額を出さない。
  const lineTotal = groups.reduce((sum, g) => sum + (toMinor(g.total) ?? 0n), 0n);
  const paid = toMinor(r.totalAmount ?? r.amount);
  if (paid == null || lineTotal !== paid) return null;
  return {
    issuerName,
    registrationNumber,
    groups,
    hasReducedRate: groups.some((g) => g.rate === 8),
    totalTax: String(groups.reduce((sum, g) => sum + BigInt(g.tax), 0n)),
  };
}
