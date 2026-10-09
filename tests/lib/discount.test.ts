import { describe, it, expect } from 'vitest';
import { parseUnits } from 'viem';
import {
  allocateDiscount,
  discountFromPercent,
  discountUnit,
  parseDiscountAmount,
} from '@/lib/discount';

const J = (v: string) => parseUnits(v, 18); // JPYC (1 JPYC = 1 円)
const U = (v: string) => parseUnits(v, 6); // USDC
const JPYC_UNIT = discountUnit(18, 0);
const USDC_UNIT = discountUnit(6, 2);

describe('discountUnit', () => {
  it('JPYC は 1 円・USDC は 0.01', () => {
    expect(JPYC_UNIT).toBe(J('1'));
    expect(USDC_UNIT).toBe(U('0.01'));
  });
});

describe('parseDiscountAmount (金額指定)', () => {
  it('1,000 円から 20 円引き → 20 円', () => {
    expect(parseDiscountAmount('20', J('1000'), 18, 0)).toBe(J('20'));
  });
  it.each(['0', '-1', 'abc', '', '20.5', '1e3', ' '])('不正・0・最小単位の倍数でない (%s) は null', (raw) => {
    expect(parseDiscountAmount(raw, J('1000'), 18, 0)).toBeNull();
  });
  it('小計以上 (100% 値引き・過大値引き) は null (支払額が 0 以下になる)', () => {
    expect(parseDiscountAmount('1000', J('1000'), 18, 0)).toBeNull();
    expect(parseDiscountAmount('1001', J('1000'), 18, 0)).toBeNull();
    expect(parseDiscountAmount('999', J('1000'), 18, 0)).toBe(J('999'));
  });
  it('USDC は 0.01 単位', () => {
    expect(parseDiscountAmount('0.01', U('1'), 6, 2)).toBe(U('0.01'));
    expect(parseDiscountAmount('0.005', U('1'), 6, 2)).toBeNull();
  });
});

describe('discountFromPercent (割引率指定)', () => {
  it('1,000 円の 2% → 20 円', () => {
    expect(discountFromPercent(J('1000'), '2', 18, 0)).toBe(J('20'));
  });
  it('円未満は切り捨て (1,234 円の 2% = 24.68 → 24 円)', () => {
    expect(discountFromPercent(J('1234'), '2', 18, 0)).toBe(J('24'));
  });
  it('小数 2 桁まで (2.5%)', () => {
    expect(discountFromPercent(J('1000'), '2.5', 18, 0)).toBe(J('25'));
    expect(discountFromPercent(J('1000'), '2.555', 18, 0)).toBeNull();
  });
  it.each(['0', '0.00', '100', '100.00', '150', '-2', 'abc'])('0% 以下・100% 以上・不正 (%s) は null', (pct) => {
    expect(discountFromPercent(J('1000'), pct, 18, 0)).toBeNull();
  });
  it('切り捨てて 0 になる率は null (50 円の 1% = 0.5 円)', () => {
    expect(discountFromPercent(J('50'), '1', 18, 0)).toBeNull();
  });
  it('USDC は 0.01 未満を切り捨て (1 USDC の 2.5% = 0.025 → 0.02)', () => {
    expect(discountFromPercent(U('1'), '2.5', 6, 2)).toBe(U('0.02'));
  });
});

describe('allocateDiscount (税率ごと → 明細へ按分)', () => {
  it('同じ税率の 2 商品へ金額の比で配る (600・400 から 20 → 12・8)', () => {
    const out = allocateDiscount(
      [{ amount: J('600'), taxRate: 10 }, { amount: J('400'), taxRate: 10 }],
      J('20'),
      JPYC_UNIT,
    );
    expect(out).toEqual([J('12'), J('8')]);
  });

  it('8%・10% 混在: 値引き前の税率ごとの合計の比で配る (10% 600・8% 400 から 20 → 12・8)', () => {
    const out = allocateDiscount(
      [{ amount: J('600'), taxRate: 10 }, { amount: J('400'), taxRate: 8 }],
      J('20'),
      JPYC_UNIT,
    );
    expect(out).toEqual([J('12'), J('8')]);
  });

  it('端数は大きい順に 1 円ずつ (100・100・100 から 10 → 4・3・3)', () => {
    const lines = [100, 100, 100].map((v) => ({ amount: J(String(v)), taxRate: 10 }));
    expect(allocateDiscount(lines, J('10'), JPYC_UNIT)).toEqual([J('4'), J('3'), J('3')]);
  });

  it('税率グループの端数 → グループ内の端数 (10% 333・8% 333・8% 334 から 10 → 3・3・4)', () => {
    const out = allocateDiscount(
      [
        { amount: J('333'), taxRate: 10 },
        { amount: J('333'), taxRate: 8 },
        { amount: J('334'), taxRate: 8 },
      ],
      J('10'),
      JPYC_UNIT,
    );
    // 税率ごと: 10% = 3.33 → 3・8% = 6.67 → 7 (端数の大きい方に 1 円)。8% の中: 333・334 の比で 7 → 3・4。
    expect(out).toEqual([J('3'), J('3'), J('4')]);
  });

  it('1 円未満の行には円単位で置けないので、置ける行に配る (0.5 円・100 円から 1 → 0・1)', () => {
    const out = allocateDiscount(
      [{ amount: J('0.5'), taxRate: 10 }, { amount: J('100'), taxRate: 10 }],
      J('1'),
      JPYC_UNIT,
    );
    expect(out).toEqual([0n, J('1')]);
  });

  it('値引きが 0 以下・小計以上なら配らない', () => {
    const lines = [{ amount: J('100'), taxRate: 10 }];
    expect(allocateDiscount(lines, 0n, JPYC_UNIT)).toEqual([0n]);
    expect(allocateDiscount(lines, J('100'), JPYC_UNIT)).toEqual([0n]);
  });

  it('どんな組み合わせでも、配った合計 = 値引き・各行は自分の金額を超えない', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const rates = [10, 8, 0, null];
    for (let round = 0; round < 300; round++) {
      const lines = Array.from({ length: 1 + rand(10) }, () => ({
        amount: J(String(1 + rand(5000))) + (rand(3) === 0 ? J('0.5') : 0n),
        taxRate: rates[rand(rates.length)],
      }));
      const subtotal = lines.reduce((a, l) => a + l.amount, 0n);
      const maxYen = subtotal / JPYC_UNIT - 1n;
      if (maxYen < 1n) continue;
      const discount = (1n + BigInt(rand(Number(maxYen)))) * JPYC_UNIT;
      const out = allocateDiscount(lines, discount, JPYC_UNIT);
      expect(out.reduce((a, v) => a + v, 0n)).toBe(discount);
      out.forEach((d, i) => {
        expect(d >= 0n).toBe(true);
        expect(d <= lines[i].amount).toBe(true);
      });
    }
  });
});
