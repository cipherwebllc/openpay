// components/guide/GuideHeader.tsx の GuideTitle: 末尾の括弧書きは小さな補足にするが、前の空白は残す
// (落とすと「注文(訪日客向け)」「AI(for …)」とくっつく)・数字と単位は改行しない空白でつなぐ。

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GuideTitle } from '@/components/guide/GuideHeader';

describe('GuideTitle', () => {
  it.each([
    ['AI に頼んで注文 (訪日客向け)', '(訪日客向け)'],
    ['Order with your AI (for visitors to Japan)', '(for visitors to Japan)'],
  ])('%s: 末尾の括弧書きを補足にし、前の空白は残す', (title, qualifier) => {
    render(<GuideTitle>{title}</GuideTitle>);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe(title);
    expect(heading.querySelector('span')?.textContent).toBe(qualifier);
  });

  it('括弧書きの無い題はそのまま (数字と単位は改行しない空白でつなぐ)', () => {
    render(<GuideTitle>確認しておきたい 8 つのこと</GuideTitle>);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.querySelector('span')).toBeNull();
    expect(heading.textContent).toBe('確認しておきたい 8 つのこと');
  });
});
