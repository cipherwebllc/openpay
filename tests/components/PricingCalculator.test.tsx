// 料金ページの計算機 (components/PricingCalculator.tsx)。式そのものの一致は tests/lib/pricingExamples.test.ts
// (本物の分配の関数と照合)。ここは入力・例のボタン・使えない額・空の表示を見る。

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PricingCalculator } from '@/components/pricing/PricingCalculator';
import { PRICING } from '@/lib/pricing';
import { disclosedPricingRates } from '@/lib/pricingExamples';

const copy = PRICING.ja.calc;

function renderCalc(defaultAmount = 1_000) {
  render(
    <PricingCalculator copy={copy} rates={disclosedPricingRates()} presets={[100, 1_000, 10_000]} defaultAmount={defaultAmount} />,
  );
  return screen.getByLabelText(copy.amountLabel) as HTMLInputElement;
}

function modeText(index: number): string {
  const heading = screen.getByRole('heading', { level: 3, name: copy.modes[index].name });
  return heading.closest('li')?.textContent ?? '';
}

describe('PricingCalculator', () => {
  it('桁区切りで出し、数字以外と 9 桁目を捨てる', () => {
    const input = renderCalc();
    fireEvent.change(input, { target: { value: '12a345678999' } });
    expect(input.value).toBe('12,345,678');
    fireEvent.change(input, { target: { value: '007' } });
    expect(input.value).toBe('7');
  });

  it('お店が払う場面は引き算・買い手が払う場面は足し算 (今の正本: 1%・最低 2 / 1%・3% / 1%・最低 1)', () => {
    const input = renderCalc();
    fireEvent.change(input, { target: { value: '10000' } });
    expect(modeText(0)).toMatch(/10,000.*−.*100.*=.*9,900/);
    expect(modeText(1)).toMatch(/10,000.*−.*100.*=.*9,900/);
    expect(modeText(2)).toMatch(/10,000.*−.*300.*=.*9,700/);
    expect(modeText(2)).toMatch(/10,300.*10,000/);
    expect(modeText(3)).toMatch(/10,000.*\+.*100.*=.*10,100/);
  });

  it('最低額になった料金に印を付ける (文字で・色だけに頼らない)', () => {
    const input = renderCalc();
    fireEvent.change(input, { target: { value: '100' } });
    expect(modeText(0)).toContain(copy.floorMark);
    expect(modeText(0)).toMatch(/100.*−.*2.*=.*98/);
  });

  it('ガスレス決済を使えない額では式の代わりに理由を出す', () => {
    const input = renderCalc();
    fireEvent.change(input, { target: { value: '2' } });
    expect(modeText(0)).toContain(copy.unavailable);
    expect(modeText(0)).not.toContain('=');
    // ほかの場面は計算する。
    expect(modeText(1)).toContain('=');
  });

  it('例のボタンで金額が入り、押したボタンが aria-pressed になる', () => {
    renderCalc();
    const button = screen.getByRole('button', { name: '10,000' });
    fireEvent.click(button);
    expect((screen.getByLabelText(copy.amountLabel) as HTMLInputElement).value).toBe('10,000');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1,000' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('空のときは案内を出す・結果は読み上げの領域 (aria-live)', () => {
    const input = renderCalc();
    fireEvent.change(input, { target: { value: '' } });
    const live = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(within(live as HTMLElement).getByText(copy.emptyHint)).toBeInTheDocument();
  });
});
