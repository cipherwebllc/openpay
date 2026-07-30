import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStorefrontSection } from '@/components/CreatorStorefrontSection';

const PRODUCT = {
  id: `h_${'a'.repeat(32)}`,
  title: 'AI プロンプト集',
  desc: '仕事で使えるテンプレート',
  emoji: '🧠',
  priceJpyc: '1200',
  payTo: '0x2222222222222222222222222222222222222222' as const,
  contentKind: 'text' as const,
  label: 'prompt' as const,
};

describe('CreatorStorefrontSection', () => {
  it('販売中の商品カードと有効な購入ボタンを描画する', () => {
    renderWithIntl(
      <CreatorStorefrontSection
        products={[PRODUCT]}
        accent="#2563eb"
        theme="clean"
        sellerDisclosureHref="/ja/store/seller/0x1234"
      />,
    );

    expect(
      screen.getByRole('heading', { name: '販売中' }),
    ).toBeInTheDocument();
    expect(screen.getByText('AI プロンプト集')).toBeInTheDocument();
    expect(screen.getByText('仕事で使えるテンプレート')).toBeInTheDocument();
    expect(screen.getByText('1,200 JPYC')).toBeInTheDocument();
    expect(screen.getByText('🧠')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: '購入する' })).toBeEnabled();
  });

  it('商品ゼロは wrapper を描画せず、night は可読色を使う', () => {
    const empty = renderWithIntl(
      <CreatorStorefrontSection
        products={[]}
        accent="#2563eb"
        theme="clean"
        sellerDisclosureHref="/ja/store/seller/0x1234"
      />,
    );
    expect(empty.container).toBeEmptyDOMElement();
    empty.unmount();

    renderWithIntl(
      <CreatorStorefrontSection
        products={[PRODUCT]}
        accent="#2563eb"
        theme="night"
        sellerDisclosureHref="/ja/store/seller/0x1234"
      />,
    );
    expect(screen.getByRole('heading', { name: '販売中' })).toHaveClass(
      'text-slate-100',
    );
  });

  it('英語の placeholder と label を描画する', () => {
    renderWithIntl(
      <CreatorStorefrontSection
        products={[PRODUCT]}
        accent="#2563eb"
        theme="soft"
        sellerDisclosureHref="/en/store/seller/0x1234"
      />,
      { locale: 'en' },
    );
    expect(screen.getByRole('button', { name: 'Purchase' })).toBeEnabled();
    expect(screen.getByText('Prompt')).toBeInTheDocument();
  });
});
