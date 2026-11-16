// 料金の数字の色 (components/pricing/PayerPill.tsx の PAYER_TONE.focal)。「誰が払うか」の意味の色: お店 = 緑・お客様側 = 青・
// どちらもあり得る = 灰。トップの導入メリット・料金のカード・料金ページの計算機が同じ値を使う。
// 数字は白い面の上で 16px (計算機) まで小さくなるので、「大きい文字」の 3:1 でなく 4.5:1 が要る (WCAG 1.4.3)。
// emerald-600 は白の上で 3.76:1 で、/pricing の計算機 (全幅) とトップの導入メリット (狭い幅で数字が縮むとき) が axe の
// color-contrast に掛かっていた (plans/lp-polish-2026-11.md P7)。色はパレット (node_modules の tailwindcss) から読んで計算する。

import tailwindColors from 'tailwindcss/colors';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PAYER_TONE } from '@/components/pricing/PayerPill';
import { PricingCalculator } from '@/components/pricing/PricingCalculator';
import { SummaryCard } from '@/components/pricing/PricingPieces';
import { PRICING, type PricingPayerTone } from '@/lib/pricing';
import { disclosedPricingRates } from '@/lib/pricingExamples';
import { contrastRatio } from '../_helpers/tailwindContrast';

type RGB = [number, number, number];
const WHITE: RGB = [255, 255, 255];
const palette = tailwindColors as unknown as Record<string, Record<string, string>>;

/** `text-<色>-<濃さ>` (パレットの色) を RGB に。それ以外の書き方は落とす (読めない色を黙って通さない)。 */
function rgbOf(token: string): RGB {
  const m = token.match(/^text-([a-z]+)-(\d{2,3})$/);
  const hex = m ? palette[m[1]]?.[m[2]] : undefined;
  if (!m || !/^#[0-9a-f]{6}$/i.test(hex ?? '')) throw new Error(`パレットの色でない: ${token}`);
  return [1, 3, 5].map((i) => parseInt(hex!.slice(i, i + 2), 16)) as RGB;
}
const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
/** variant なしの文字の色 (`text-<色>-<濃さ>`) の指定。 */
const textColors = (el: Element) => tokens(el).filter((t) => /^text-[a-z]+-\d{2,3}$/.test(t));

const TONES = Object.keys(PAYER_TONE) as PricingPayerTone[];

describe('料金の数字の色 (PAYER_TONE.focal)', () => {
  it.each(TONES)('%s: 白の上で 4.5:1 以上 (小さい数字でも読める)', (tone) => {
    const ratio = contrastRatio(rgbOf(PAYER_TONE[tone].focal), WHITE);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('色の意味はそのまま: お店 = 緑・お客様側 = 青・どちらもあり得る = 灰', () => {
    expect(PAYER_TONE.shop.focal).toMatch(/^text-emerald-\d{3}$/);
    expect(PAYER_TONE.customer.focal).toMatch(/^text-blue-\d{3}$/);
    expect(PAYER_TONE.either.focal).toMatch(/^text-slate-\d{3}$/);
  });

  it('この検査は足りない色を落とす (emerald-600 は白の上で 4.5:1 に届かない)', () => {
    expect(contrastRatio(rgbOf('text-emerald-600'), WHITE)).toBeLessThan(4.5);
    expect(() => rgbOf('text-[#059669]')).toThrow();
  });

  it.each(['ja', 'en'] as const)('%s 料金のカード: 大きい数字の色は、払う人の色ただ 1 つ', (locale) => {
    for (const item of PRICING[locale].summary) {
      const { container, unmount } = render(
        <ul>
          <SummaryCard item={item} />
        </ul>,
      );
      const focal = within(container).getByText(item.focal, { selector: 'span.font-extrabold' });
      expect(textColors(focal), item.id).toEqual([PAYER_TONE[item.payer.tone].focal]);
      unmount();
    }
  });

  it.each(['ja', 'en'] as const)('%s 計算機: 利用料の数字の色は、その場面で払う人の色ただ 1 つ。ほかの項は払う人の色を使わない', (locale) => {
    const copy = PRICING[locale].calc;
    render(<PricingCalculator copy={copy} rates={disclosedPricingRates()} presets={[100, 1_000, 10_000]} defaultAmount={1_000} />);
    const tones = new Set<string>();
    for (const mode of copy.modes) {
      const row = screen.getByRole('heading', { level: 3, name: mode.name }).closest('li')!;
      // 式の 3 項 (左の額・利用料・結果) の数字。
      const values = [...row.querySelectorAll('span.tabular-nums.whitespace-nowrap')];
      expect(values, mode.id).toHaveLength(3);
      const want = PAYER_TONE[mode.payer.tone].focal;
      expect(textColors(values[1]), mode.id).toEqual([want]);
      for (const other of [values[0], values[2]]) {
        expect(textColors(other), mode.id).toHaveLength(1);
        expect(contrastRatio(rgbOf(textColors(other)[0]), WHITE)).toBeGreaterThanOrEqual(4.5);
      }
      tones.add(mode.payer.tone);
    }
    // お店が払う場面と買い手が払う場面の両方を見ている (このテストが片方だけで通らない)。
    expect([...tones]).toEqual(expect.arrayContaining(['customer', 'shop']));
  });
});
