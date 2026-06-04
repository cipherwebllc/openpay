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

/**
 * 内税 (税込) からの税額を decimals 桁に丸めて返す (token 単位汎用)。
 *   rate>0  → round(amount * rate / (100 + rate), decimals)
 *   rate<=0 → 0 (非課税 / 対象外)
 *   rate=null (未指定) → null (= 税額不明、CSV/表示は空欄)
 *   amount が非有限 → null
 * 丸めは既存 taxAmountYen と同じ Math.round 方針 (decimals 桁スケール)。会計ソフトでは
 * なく記帳補助の参考値。JPYC は decimals=0 (円)、USDC は decimals=2 (セント) を想定。
 */
export function taxAmountDecimal(
  amount: number,
  rate: number | null,
  decimals: number,
): number | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  if (rate <= 0) return 0;
  if (!Number.isFinite(amount)) return null;
  const factor = 10 ** Math.max(0, Math.floor(decimals));
  return Math.round((amount * rate) / (100 + rate) * factor) / factor;
}

/** 税額の表示小数桁。JPYC=円 (0桁)、USDC=セント (2桁)。 */
export function taxDisplayDecimals(token: TokenSymbol): number {
  return token === 'jpyc' ? 0 : 2;
}

/**
 * 内税 (税込) からの税額 (円・整数)。JPYC 用の薄いラッパ (decimals=0)。
 *   rate>0 → round(yen * rate / (100 + rate))、rate<=0 → 0、rate=null/非有限 yen → null。
 */
export function taxAmountYen(yen: number, rate: number | null): number | null {
  return taxAmountDecimal(yen, rate, 0);
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
