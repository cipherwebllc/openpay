import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InvoiceNumberInput } from '@/components/InvoiceNumberInput';

const text = { invalid: '形式が違います', lookup: '公表サイトで確かめる', needsStoreName: '店名が必要です' };

function renderInput(value: string, hasStoreName = true) {
  const onChange = vi.fn();
  render(
    <>
      <label htmlFor="inv">インボイス登録番号</label>
      <InvoiceNumberInput id="inv" value={value} onChange={onChange} hasStoreName={hasStoreName} className="" text={text} />
    </>,
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

  // G15: 画面の注意を入力欄に結び付ける (読み上げで「無効な入力・形式が違います」と分かる)。
  it('形式外なら入力欄を aria-invalid にし、注意を説明として結び付ける', () => {
    renderInput('T123');
    const input = screen.getByRole('textbox', { name: 'インボイス登録番号' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(text.invalid);
  });

  it.each(['', 'T1234567890123'])('空・形式どおり (%j) なら aria-invalid も説明も付けない', (value) => {
    renderInput(value);
    const input = screen.getByRole('textbox', { name: 'インボイス登録番号' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
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

  it('可視の見出しが入力のラベルになり、確認リンクの文言は名前に混ざらない', () => {
    renderInput('T1234567890123');
    expect(screen.getByRole('textbox', { name: 'インボイス登録番号' })).toBeTruthy();
  });

  it('入力は生の文字列のまま親へ渡す', () => {
    const onChange = renderInput('');
    fireEvent.change(screen.getByPlaceholderText('T1234567890123'), { target: { value: 'T-1' } });
    expect(onChange).toHaveBeenCalledWith('T-1');
  });
});
