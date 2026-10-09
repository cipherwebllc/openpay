import { describe, it, expect } from 'vitest';
import {
  TAX_CATEGORIES,
  TAX_OPTIONS,
  TAX_RATE_MAX,
  isTaxCategory,
  defaultRateForCategory,
  innerTaxUnits,
  lineItemsTax,
  taxByRate,
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

describe('innerTaxUnits (内税・表示の最小単位で 1 回だけ四捨五入)', () => {
  const yen = (n: number) => BigInt(n);
  it('JPYC (円): 1100@10% → 100 / 1080@8% → 80 / 1000@10% → 91 (90.9 を四捨五入)', () => {
    expect(innerTaxUnits(yen(1100), 1n, 10, 0)).toBe(100n);
    expect(innerTaxUnits(yen(1080), 1n, 8, 0)).toBe(80n);
    expect(innerTaxUnits(yen(1000), 1n, 10, 0)).toBe(91n);
  });
  it('0.5 は切り上げ (6.75@8% = 0.5 → 1・5.5@10% = 0.5 → 1)', () => {
    expect(innerTaxUnits(675n, 100n, 8, 0)).toBe(1n);
    expect(innerTaxUnits(55n, 10n, 10, 0)).toBe(1n);
  });
  it('USDC (セント): 6.40@10% → 58 セント / 11.00@10% → 100 セント', () => {
    expect(innerTaxUnits(6_400_000n, 1_000_000n, 10, 2)).toBe(58n); // 0.5818.. → 0.58
    expect(innerTaxUnits(11_000_000n, 1_000_000n, 10, 2)).toBe(100n);
  });
  it('任意税率の小数 (7.5%) も浮動小数の誤差なく (1075 → 75)', () => {
    expect(innerTaxUnits(yen(1075), 1n, 7.5, 0)).toBe(75n);
  });
  it('分数の額 (取引の円額を税率の比で配った額) を途中で丸めない', () => {
    // 1000 円 × 3/4 = 750 円 → 750 × 10/110 = 68.18 → 68
    expect(innerTaxUnits(3000n, 4n, 10, 0)).toBe(68n);
  });
  it('rate 0 以下 (非課税/対象外) → 0・null / 非有限 (未指定) → null', () => {
    expect(innerTaxUnits(yen(1000), 1n, 0, 0)).toBe(0n);
    expect(innerTaxUnits(yen(1000), 1n, -5, 0)).toBe(0n);
    expect(innerTaxUnits(yen(1000), 1n, null, 0)).toBeNull();
    expect(innerTaxUnits(yen(1000), 1n, Number.NaN, 0)).toBeNull();
  });
  it('taxDisplayDecimals: jpyc=0 / usdc=2', () => {
    expect(taxDisplayDecimals('jpyc')).toBe(0);
    expect(taxDisplayDecimals('usdc')).toBe(2);
  });
});

describe('taxByRate (税率ごとに 1 回の端数処理・第 7 回レビュー A8)', () => {
  const E18 = 10n ** 18n;
  const jpyc = (n: number) => BigInt(n) * E18;

  it('税率ごとに束ねて 1 回だけ丸める (行ごとに丸めて足さない)', () => {
    // 6 + 6 円 (10%): 行ごとなら 1 + 1 = 2・税率ごとなら 12 × 10/110 = 1.09 → 1。
    const { groups, lineTax } = taxByRate(
      [{ charged: jpyc(6), taxRate: 10 }, { charged: jpyc(6), taxRate: 10 }],
      18,
      0,
    );
    expect(groups).toEqual([{ rate: 10, charged: jpyc(12), tax: 1n }]);
    expect(lineTax).toEqual([1n, 0n]);
  });

  it('行へ配る額: 行ごとの端数を切り捨て、残りを端数の大きい順に 1 単位ずつ (合計 = 税率ごとの税額)', () => {
    // 500 → 45.45・2997 → 272.45・999 → 90.82: 切り捨て 45 + 272 + 90 = 407・税率ごと 4496/11 = 408.7 → 409。
    // 残り 2 円は端数の大きい 999 の行 (0.82) → 端数が同じ (0.45) 500 と 2997 は金額の大きい 2997 の行。
    const { groups, lineTax } = taxByRate(
      [{ charged: jpyc(500), taxRate: 10 }, { charged: jpyc(2997), taxRate: 10 }, { charged: jpyc(999), taxRate: 10 }],
      18,
      0,
    );
    expect(groups[0].tax).toBe(409n);
    expect(lineTax).toEqual([45n, 273n, 91n]);
  });

  it('端数が同じなら金額の大きい行 → 先の行', () => {
    const { lineTax } = taxByRate(
      [{ charged: jpyc(6), taxRate: 10 }, { charged: jpyc(17), taxRate: 10 }, { charged: jpyc(6), taxRate: 10 }],
      18,
      0,
    );
    // 6/11 = 0.545・17/11 = 1.545 (端数同じ)・合計 29/11 = 2.64 → 3: 切り捨て 0 + 1 + 0 = 1・残り 2 → 17 円の行 → 先の 6 円の行。
    expect(lineTax).toEqual([1n, 2n, 0n]);
  });

  it('税率が混ざれば税率ごと (登場順)・税率なしは null・0% は 0', () => {
    const { groups, lineTax } = taxByRate(
      [
        { charged: jpyc(1000), taxRate: 10 },
        { charged: jpyc(3000), taxRate: 8 },
        { charged: jpyc(300), taxRate: 0 },
        { charged: jpyc(50), taxRate: null },
      ],
      18,
      0,
    );
    expect(groups).toEqual([
      { rate: 10, charged: jpyc(1000), tax: 91n },
      { rate: 8, charged: jpyc(3000), tax: 222n },
      { rate: 0, charged: jpyc(300), tax: 0n },
      { rate: null, charged: jpyc(50), tax: null },
    ]);
    expect(lineTax).toEqual([91n, 222n, 0n, null]);
  });
});

describe('lineItemsTax (明細の消費税額・保存された taxAmount は読まない)', () => {
  it('値引き後の額から税率ごとに 1 回・行の税額は 10 進の文字列', () => {
    const r = lineItemsTax(
      [
        { amount: '7', discount: '1', taxRate: 10 },
        { amount: '7', discount: '1', taxRate: 10 },
      ],
      18,
      0,
    );
    expect(r.lineTax).toEqual(['1', '0']);
    expect(r.totalTax).toBe('1');
  });

  it('USDC はセントの 10 進 (0.14 USDC @10% → 0.01)', () => {
    const r = lineItemsTax(
      [
        { amount: '0.07', taxRate: 10 },
        { amount: '0.07', taxRate: 10 },
      ],
      6,
      2,
    );
    expect(r.lineTax).toEqual(['0.01', '0']);
    expect(r.totalTax).toBe('0.01');
  });

  it('金額や値引きが読めない行は税額 0 で、ほかの行の税額は変えない', () => {
    const r = lineItemsTax(
      [
        { amount: 'abc', taxRate: 10 },
        { amount: '1100', taxRate: 10 },
        { amount: '100', discount: '200', taxRate: 10 },
      ],
      18,
      0,
    );
    expect(r.lineTax).toEqual(['0', '100', '0']);
    expect(r.totalTax).toBe('100');
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
