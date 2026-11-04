// components/guide/GuideUiNames.tsx: 本文の「…」/ “…” (画面の名前) だけを太くし、短い名前は改行させない。
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { withUiNames } from '@/components/guide/GuideUiNames';

describe('withUiNames', () => {
  it('引用符のない文はそのまま返す', () => {
    expect(withUiNames('リンクを作ります。')).toBe('リンクを作ります。');
  });

  it('「…」と “…” を span で包み、文の残りはそのまま', () => {
    const { container } = render(<p>{withUiNames('「設定」で決め、“Copy link” を押します。')}</p>);
    const names = [...container.querySelectorAll('span')].map((s) => s.textContent);
    expect(names).toEqual(['「設定」', '“Copy link”']);
    expect(container.textContent).toBe('「設定」で決め、“Copy link” を押します。');
  });

  it('14 字までの名前は改行させず、長い名前は折り返しを許す (320px ではみ出さない)', () => {
    const { container } = render(<p>{withUiNames('「リンクをコピー」と「ウォレットに … JPYC 届いてから発送」')}</p>);
    const [short, long] = [...container.querySelectorAll('span')];
    expect(short.className).toContain('whitespace-nowrap');
    expect(long.className).not.toContain('whitespace-nowrap');
  });
});
