import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InvoiceNumberInput } from '@/components/InvoiceNumberInput';

const text = { invalid: '形式が違います', lookup: '公表サイトで確かめる', needsStoreName: '店名が必要です' };

function renderInput(value: string, hasStoreName = true) {
  const onChange = vi.fn();
  render(
    <InvoiceNumberInput value={value} onChange={onChange} hasStoreName={hasStoreName} className="" text={text} />,
  );
  return onChange;
}

describe('InvoiceNumberInput', () => {
  it('空なら注意もリンクも出さない', () => {
    renderInput('');
    expect(screen.queryByText(text.invalid)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('形式外なら注意を出す', () => {
    renderInput('T123');
    expect(screen.getByText(text.invalid)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('形式どおりなら公表サイトのリンク (正規化した番号) を出す', () => {
    renderInput('t-1234-5678-90123');
    expect(screen.queryByText(text.invalid)).toBeNull();
    expect(screen.getByRole('link', { name: text.lookup }).getAttribute('href')).toBe(
      'https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=1234567890123',
    );
    expect(screen.queryByText(text.needsStoreName)).toBeNull();
  });

  it('店名が空なら、控えに出ない注意を添える', () => {
    renderInput('T1234567890123', false);
    expect(screen.getByText(text.needsStoreName)).toBeTruthy();
  });

  it('入力は生の文字列のまま親へ渡す', () => {
    const onChange = renderInput('');
    fireEvent.change(screen.getByPlaceholderText('T1234567890123'), { target: { value: 'T-1' } });
    expect(onChange).toHaveBeenCalledWith('T-1');
  });
});
