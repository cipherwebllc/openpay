import { describe, it, expect } from 'vitest';
import {
  TAX_CATEGORIES,
  TAX_OPTIONS,
  TAX_RATE_MAX,
  isTaxCategory,
  defaultRateForCategory,
  taxAmountYen,
  taxAmountDecimal,
  taxDisplayDecimals,
  freeeTaxLabel,
  mfCreditTaxLabel,
  yayoiCreditTaxLabel,
  taxCategoryShortLabel,
  parseTaxRateParam,
  parseTaxCategoryParam,
} from '@/lib/tax';

describe('TAX_OPTIONS / isTaxCategory', () => {
  it('TAX_OPTIONS は全 TaxCategory を網羅し順序通り', () => {
    expect(TAX_OPTIONS.map((o) => o.category)).toEqual([
      'taxable_10',
      'taxable_8',
      'tax_free',
      'out_of_scope',
      'custom',
    ]);
  });
  it('isTaxCategory は enum のみ true', () => {
    for (const c of TAX_CATEGORIES) expect(isTaxCategory(c)).toBe(true);
    expect(isTaxCategory('taxable_5')).toBe(false);
    expect(isTaxCategory('')).toBe(false);
    expect(isTaxCategory(null)).toBe(false);
    expect(isTaxCategory(10)).toBe(false);
  });
  it('defaultRateForCategory: 標準は固定・custom は null', () => {
    expect(defaultRateForCategory('taxable_10')).toBe(10);
    expect(defaultRateForCategory('taxable_8')).toBe(8);
    expect(defaultRateForCategory('tax_free')).toBe(0);
    expect(defaultRateForCategory('out_of_scope')).toBe(0);
    expect(defaultRateForCategory('custom')).toBeNull();
  });
});

describe('taxAmountYen (内税)', () => {
  it('税込 1100・10% → 100', () => {
    expect(taxAmountYen(1100, 10)).toBe(100);
  });
  it('税込 1080・8% → 80', () => {
    expect(taxAmountYen(1080, 8)).toBe(80);
  });
  it('端数は round (税込 1000・10% → 91)', () => {
    expect(taxAmountYen(1000, 10)).toBe(91); // 1000*10/110 = 90.9..
  });
  it('rate 0 (非課税/対象外) → 0', () => {
    expect(taxAmountYen(1000, 0)).toBe(0);
  });
  it('rate null (未指定) → null', () => {
    expect(taxAmountYen(1000, null)).toBeNull();
  });
  it('yen 非有限 (USDC レート無) → null', () => {
    expect(taxAmountYen(Number.NaN, 10)).toBeNull();
    expect(taxAmountYen(Number.POSITIVE_INFINITY, 10)).toBeNull();
  });
});

describe('taxAmountDecimal / taxDisplayDecimals (token 単位)', () => {
  it('JPYC (0桁): 1100@10% → 100 / 1080@8% → 80 / 1000@10% → 91(round)', () => {
    expect(taxAmountDecimal(1100, 10, 0)).toBe(100);
    expect(taxAmountDecimal(1080, 8, 0)).toBe(80);
    expect(taxAmountDecimal(1000, 10, 0)).toBe(91);
  });
  it('USDC (2桁): 6.40@10% → 0.58 / 11.00@10% → 1.0', () => {
    expect(taxAmountDecimal(6.4, 10, 2)).toBe(0.58); // 0.58181.. → 0.58
    expect(taxAmountDecimal(11, 10, 2)).toBe(1);
  });
  it('rate 0/null/非有限 amount', () => {
    expect(taxAmountDecimal(1000, 0, 0)).toBe(0);
    expect(taxAmountDecimal(1000, null, 0)).toBeNull();
    expect(taxAmountDecimal(Number.NaN, 10, 0)).toBeNull();
  });
  it('taxDisplayDecimals: jpyc=0 / usdc=2', () => {
    expect(taxDisplayDecimals('jpyc')).toBe(0);
    expect(taxDisplayDecimals('usdc')).toBe(2);
  });
  it('taxAmountYen は decimals=0 版 (委譲)', () => {
    expect(taxAmountYen(1100, 10)).toBe(taxAmountDecimal(1100, 10, 0));
  });
});

describe('CSV 税区分ラベル (null=既存デフォルト・custom=対象外)', () => {
  it('freee', () => {
    expect(freeeTaxLabel('taxable_10')).toBe('課税売上10%');
    expect(freeeTaxLabel('taxable_8')).toBe('課税売上8%（軽）');
    expect(freeeTaxLabel('tax_free')).toBe('非課税売上');
    expect(freeeTaxLabel('out_of_scope')).toBe('対象外');
    expect(freeeTaxLabel('custom')).toBe('対象外');
    expect(freeeTaxLabel(null)).toBe('課税売上10%'); // legacy/未指定は従来どおり
  });
  it('MF', () => {
    expect(mfCreditTaxLabel('taxable_10')).toBe('課税売上10%');
    expect(mfCreditTaxLabel('taxable_8')).toBe('課税売上8%(軽)');
    expect(mfCreditTaxLabel('tax_free')).toBe('非課税売上');
    expect(mfCreditTaxLabel('custom')).toBe('対象外');
    expect(mfCreditTaxLabel(null)).toBe('課税売上10%');
  });
  it('弥生 (税込表記)', () => {
    expect(yayoiCreditTaxLabel('taxable_10')).toBe('課税売上込10%');
    expect(yayoiCreditTaxLabel('taxable_8')).toBe('課税売上込8%(軽)');
    expect(yayoiCreditTaxLabel('out_of_scope')).toBe('対象外');
    expect(yayoiCreditTaxLabel(null)).toBe('課税売上込10%');
  });
});

describe('taxCategoryShortLabel (履歴CSV/UI 用・全区分)', () => {
  it.each([
    ['taxable_10', '課税10%'],
    ['taxable_8', '軽減8%'],
    ['tax_free', '非課税'],
    ['out_of_scope', '対象外'],
    ['custom', 'カスタム'],
  ] as const)('%s → %s', (cat, label) => {
    expect(taxCategoryShortLabel(cat)).toBe(label);
  });
  it('null は空文字', () => {
    expect(taxCategoryShortLabel(null)).toBe('');
  });
});

describe('URL param parse', () => {
  it('parseTaxRateParam: 正の decimal のみ・範囲外/不正は undefined', () => {
    expect(parseTaxRateParam('10')).toBe(10);
    expect(parseTaxRateParam('8')).toBe(8);
    expect(parseTaxRateParam('0')).toBe(0);
    expect(parseTaxRateParam('5.5')).toBe(5.5);
    expect(parseTaxRateParam(String(TAX_RATE_MAX))).toBe(TAX_RATE_MAX);
    expect(parseTaxRateParam(String(TAX_RATE_MAX + 1))).toBeUndefined();
    expect(parseTaxRateParam('-1')).toBeUndefined();
    expect(parseTaxRateParam('abc')).toBeUndefined();
    expect(parseTaxRateParam('')).toBeUndefined();
    expect(parseTaxRateParam(null)).toBeUndefined();
  });
  it('parseTaxCategoryParam: enum のみ', () => {
    expect(parseTaxCategoryParam('taxable_10')).toBe('taxable_10');
    expect(parseTaxCategoryParam('custom')).toBe('custom');
    expect(parseTaxCategoryParam('nope')).toBeUndefined();
    expect(parseTaxCategoryParam(null)).toBeUndefined();
  });
});
