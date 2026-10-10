// 税区分 / 税率 / 税額 (内税) の単一情報源。記帳補助メタデータ用の純関数 (React/DOM 非依存)。
//
// OpenPay は会計ソフトではなく「記帳補助」なので、ここでの税区分ラベルは各社 CSV の取込
// ウィザードで再マッピング可能な初期値にすぎない。⚠️ 税区分の正式名称・コードは freee /
// マネーフォワード / 弥生 の実取込でのみ確定する (lib/accountingCsv.ts の注意書きと同じ姿勢)。
//
// 税率と税区分は別概念だが UI では 1 つの選択で両方を確定する:
//   課税10% → rate 10 / taxable_10、軽減8% → rate 8 / taxable_8、
//   非課税 → rate 0 / tax_free、対象外 → rate 0 / out_of_scope、カスタム → 任意 rate / custom。
// taxRate は税額算出の source (custom はユーザ入力値)。taxCategory は CSV/freee へのマッピング鍵。

import { formatUnits } from 'viem';
import { lineChargedWei } from './discount';
import type { TokenSymbol } from './tokens';

export const TAX_CATEGORIES = [
  'taxable_10',
  'taxable_8',
  'tax_free',
  'out_of_scope',
  'custom',
] as const;

export type TaxCategory = (typeof TAX_CATEGORIES)[number];

// 税率の許容上限 (custom 入力の sanity)。100% を超える内税は実務上ありえない。
export const TAX_RATE_MAX = 100;

export type TaxOption = {
  category: TaxCategory;
  /** 既定税率 (%)。custom はユーザ入力なので null。 */
  rate: number | null;
  /** messages の Tax namespace key。 */
  i18nKey: string;
};

// UI の税率/税区分 select 用 (順序が表示順)。
export const TAX_OPTIONS: readonly TaxOption[] = [
  { category: 'taxable_10', rate: 10, i18nKey: 'taxable10' },
  { category: 'taxable_8', rate: 8, i18nKey: 'taxable8' },
  { category: 'tax_free', rate: 0, i18nKey: 'taxFree' },
  { category: 'out_of_scope', rate: 0, i18nKey: 'outOfScope' },
  { category: 'custom', rate: null, i18nKey: 'custom' },
];

export function isTaxCategory(value: unknown): value is TaxCategory {
  return (
    typeof value === 'string' &&
    (TAX_CATEGORIES as readonly string[]).includes(value)
  );
}

/** category の既定税率。custom は null (= ユーザ入力に委ねる)。未知は null。 */
export function defaultRateForCategory(category: TaxCategory): number | null {
  return TAX_OPTIONS.find((o) => o.category === category)?.rate ?? null;
}

/** 税額の表示小数桁。JPYC=円 (0桁)、USDC=セント (2桁)。 */
export function taxDisplayDecimals(token: TokenSymbol): number {
  return token === 'jpyc' ? 0 : 2;
}

// --- 消費税額 (内税) の端数処理 ------------------------------------------------
// 1 件の会計の消費税額は「税率ごとに区分した対価 (値引き後) の合計」から、税率ごとに 1 回だけ四捨五入する
// (インボイスの記載事項・国税庁 Q&A 問57・lib/invoice.ts)。控え・店舗の履歴・明細 CSV・履歴 CSV・レジの
// 「うち税額」も同じ規則・同じ関数 (taxByRate) で出す。行ごとに丸めて足すと、面ごとに ±1 円ずれる
// (第 7 回レビュー A8)。会計ソフトではなく記帳補助の値 (端数処理の方法は任意なので四捨五入)。

// 正の有限な税率 (%) を 10 進の分数に (7.5 → 75/10・1e-7 → 1/10^7)。浮動小数の誤差を計算に持ち込まない。
function rateFraction(rate: number): { num: bigint; den: bigint } {
  // 正の有限値の String() は「整数部[.小数部][e±指数]」の形。
  const [mantissa, expPart = '0'] = String(rate).split('e');
  const [whole, frac = ''] = mantissa.split('.');
  const exp = Number(expPart) - frac.length;
  const digits = BigInt(whole + frac);
  return exp >= 0
    ? { num: digits * 10n ** BigInt(exp), den: 1n }
    : { num: digits, den: 10n ** BigInt(-exp) };
}

// 内税額 (表示の最小単位) を分子・分母で。amount (= amountNum / amountDen・トークン単位) × rate / (100 + rate) × 10^displayDecimals。
function innerTaxFraction(
  amountNum: bigint,
  amountDen: bigint,
  rate: number,
  displayDecimals: number,
): { num: bigint; den: bigint } {
  const r = rateFraction(rate);
  return {
    num: amountNum * r.num * 10n ** BigInt(displayDecimals),
    den: amountDen * (100n * r.den + r.num),
  };
}

// 四捨五入 (0 以上の分数・0.5 は切り上げ)。
function roundHalfUp(num: bigint, den: bigint): bigint {
  return (num * 2n + den) / (den * 2n);
}

/**
 * 内税額 = 税込額 × rate / (100 + rate) を、表示の最小単位 (displayDecimals 桁・JPYC は円 0 桁・USDC は
 * セント 2 桁) で 1 回だけ四捨五入する。税込額は分数 (amountNum / amountDen・トークン単位・0 以上) で受け、
 * 途中で丸めない。戻り値は最小単位の整数。rate が null・非有限 → null (税額不明)・0 以下 → 0 (非課税/対象外)。
 */
export function innerTaxUnits(
  amountNum: bigint,
  amountDen: bigint,
  rate: number | null,
  displayDecimals: number,
): bigint | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  if (rate <= 0) return 0n;
  const f = innerTaxFraction(amountNum, amountDen, rate, displayDecimals);
  return roundHalfUp(f.num, f.den);
}

export type TaxRateGroup = {
  /** 税率 (%)。未指定は null。 */
  rate: number | null;
  /** 税率ごとの対価 (値引き後・税込) の合計 (wei)。 */
  charged: bigint;
  /** 税率ごとに 1 回だけ四捨五入した消費税額 (表示の最小単位)。税率が未指定 (null)・非有限は null。 */
  tax: bigint | null;
};

/**
 * 明細を税率ごとに束ね、税率ごとに 1 回だけ四捨五入した消費税額を出す (消費税額の単一情報源)。
 *   - groups: 税率ごとの対価の合計と税額 (明細に出てきた順)。
 *   - lineTax: 税率ごとの税額を行へ配った額 (表示の最小単位)。行ごとの端数を切り捨て、残りの単位を端数の
 *     大きい順 (同じなら金額の大きい順 → 先の行) に 1 つずつ。税率ごとの合計 = その税率の税額。
 * charged は値引き後の行の額 (wei・0 以上)。decimals はトークンの桁 (JPYC 18・USDC 6)。
 */
export function taxByRate(
  lines: ReadonlyArray<{ charged: bigint; taxRate: number | null }>,
  decimals: number,
  displayDecimals: number,
): { groups: TaxRateGroup[]; lineTax: Array<bigint | null> } {
  const amountDen = 10n ** BigInt(decimals);
  const byRate = new Map<number | null, number[]>();
  lines.forEach((l, i) => {
    const idx = byRate.get(l.taxRate);
    if (idx) idx.push(i);
    else byRate.set(l.taxRate, [i]);
  });
  const lineTax: Array<bigint | null> = lines.map(() => null);
  const groups: TaxRateGroup[] = [];
  for (const [rate, idx] of byRate) {
    const charged = idx.reduce((s, i) => s + lines[i].charged, 0n);
    const tax = innerTaxUnits(charged, amountDen, rate, displayDecimals);
    groups.push({ rate, charged, tax });
    // 税額が無い (税率が未指定) か 0 の税率は、行もそのまま (配る端数が無い)。
    if (rate === null || tax === null || tax === 0n) {
      for (const i of idx) lineTax[i] = tax;
      continue;
    }
    const parts = idx.map((i) => {
      const f = innerTaxFraction(lines[i].charged, amountDen, rate, displayDecimals);
      return { i, floor: f.num / f.den, rem: f.num % f.den };
    });
    let left = tax - parts.reduce((s, p) => s + p.floor, 0n);
    parts.sort((a, b) =>
      a.rem !== b.rem
        ? (a.rem > b.rem ? -1 : 1)
        : lines[a.i].charged !== lines[b.i].charged
          ? (lines[a.i].charged > lines[b.i].charged ? -1 : 1)
          : a.i - b.i,
    );
    for (const p of parts) {
      lineTax[p.i] = p.floor + (left > 0n ? 1n : 0n);
      if (left > 0n) left -= 1n;
    }
  }
  return { groups, lineTax };
}

/**
 * 明細 (履歴・控えの HistoryLineItem・レジの会計) の消費税額。税率ごとに 1 回の端数処理 (taxByRate)。
 *   - lineTax[i]: 税率ごとの税額を行へ配った額 (10 進の文字列)。税率が未指定・金額が読めない行は '0'。
 *   - totalTax: 税率ごとの税額の合計 (= lineTax の合計)。
 *   - groups: 税率ごとの対価 (値引き後) の合計と税額。
 * 行に保存された taxAmount は読まない (旧い履歴・控えは行ごとに丸めた値で、合計がインボイスと食い違うため)。
 * 金額や値引きが読めない行 (壊れた保存値) は税率ごとの合計に入れない (ほかの行の税額は変えない)。
 */
export function lineItemsTax(
  items: ReadonlyArray<{ amount: string; discount?: string; taxRate: number | null }>,
  decimals: number,
  displayDecimals: number,
): { lineTax: string[]; totalTax: string; groups: TaxRateGroup[] } {
  const readable = items.flatMap((li, i) => {
    const charged = lineChargedWei(li, decimals);
    return charged === null ? [] : [{ i, charged, taxRate: li.taxRate }];
  });
  const { groups, lineTax } = taxByRate(readable, decimals, displayDecimals);
  const out = items.map(() => '0');
  readable.forEach(({ i }, j) => {
    const t = lineTax[j];
    if (t !== null) out[i] = formatUnits(t, displayDecimals);
  });
  const total = groups.reduce((s, g) => s + (g.tax ?? 0n), 0n);
  return { lineTax: out, totalTax: formatUnits(total, displayDecimals), groups };
}

// --- 会計 CSV の税区分ラベル -------------------------------------------------
// null (= 未指定 / legacy entry) は「既存デフォルト」を返し、旧データの CSV 出力を変えない。
// custom (任意税率) は会計上の区分が一意でないため安全側で「対象外」。
// ⚠️ ラベル文字列は実取込で要検証。

export function freeeTaxLabel(category: TaxCategory | null): string {
  switch (category) {
    case 'taxable_8':
      return '課税売上8%（軽）';
    case 'tax_free':
      return '非課税売上';
    case 'out_of_scope':
    case 'custom':
      return '対象外';
    case 'taxable_10':
    case null:
    default:
      return '課税売上10%';
  }
}

export function mfCreditTaxLabel(category: TaxCategory | null): string {
  switch (category) {
    case 'taxable_8':
      return '課税売上8%(軽)';
    case 'tax_free':
      return '非課税売上';
    case 'out_of_scope':
    case 'custom':
      return '対象外';
    case 'taxable_10':
    case null:
    default:
      return '課税売上10%';
  }
}

// 履歴 CSV (生) / UI 用の短い JP ラベル。null は空 (未指定)。
export function taxCategoryShortLabel(category: TaxCategory | null): string {
  switch (category) {
    case 'taxable_10':
      return '課税10%';
    case 'taxable_8':
      return '軽減8%';
    case 'tax_free':
      return '非課税';
    case 'out_of_scope':
      return '対象外';
    case 'custom':
      return 'カスタム';
    default:
      return '';
  }
}

// 弥生は税込経理の貸方税区分 (「込」表記)。
export function yayoiCreditTaxLabel(category: TaxCategory | null): string {
  switch (category) {
    case 'taxable_8':
      return '課税売上込8%(軽)';
    case 'tax_free':
      return '非課税売上';
    case 'out_of_scope':
    case 'custom':
      return '対象外';
    case 'taxable_10':
    case null:
    default:
      return '課税売上込10%';
  }
}

// --- URL param 用の parse (build 側は呼出元が String(rate)/category を直接 set) ----------

// 税率 query (`tax`): 正の decimal のみ、0〜TAX_RATE_MAX。不正/欠落は undefined (= 未指定)。
export function parseTaxRateParam(raw: string | null): number | undefined {
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > TAX_RATE_MAX) return undefined;
  return n;
}

// 税区分 query (`taxcat`): enum のみ。不正/欠落は undefined。
export function parseTaxCategoryParam(raw: string | null): TaxCategory | undefined {
  return isTaxCategory(raw) ? raw : undefined;
}

