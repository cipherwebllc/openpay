import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStorefrontSection } from '@/components/CreatorStorefrontSection';

const { purchaseFlowSpy } = vi.hoisted(() => ({
  purchaseFlowSpy: vi.fn(),
}));

vi.mock('@/components/CreatorStorePurchaseFlow', () => ({
  CreatorStorePurchaseFlow: (props: {
    open: boolean;
    product: { id: string };
  }) => {
    purchaseFlowSpy(props);
    return props.open ? <div role="dialog">購入フロー</div> : null;
  },
}));

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
  beforeEach(() => {
    purchaseFlowSpy.mockClear();
  });

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
    expect(screen.getByText(/1,212 JPYC · Polygon/)).toBeInTheDocument();
    expect(screen.getByText('🧠')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: '購入する' })).toBeEnabled();
  });

  it('商品画像を装飾表示し、読込失敗時は絵文字または ✦ へ戻す', () => {
    const imageUrl = 'https://cdn.example.com/product.png';
    const withEmoji = renderWithIntl(
      <CreatorStorefrontSection
        products={[{ ...PRODUCT, imageUrl }]}
        accent="#2563eb"
        theme="clean"
        sellerDisclosureHref="/ja/store/seller/0x1234"
      />,
    );
    const image = withEmoji.container.querySelector(`img[src="${imageUrl}"]`);
    // P2 ショーケース化: 画像あり商品は cover variant (image-top の大サムネイル)
    expect(image).toHaveClass('aspect-[4/3]', 'w-full', 'object-cover');
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByText('🧠')).not.toBeInTheDocument();

    fireEvent.error(image!);

    expect(
      withEmoji.container.querySelector(`img[src="${imageUrl}"]`),
    ).not.toBeInTheDocument();
    expect(screen.getByText('🧠')).toHaveAttribute('aria-hidden', 'true');
    withEmoji.unmount();

    const withoutEmoji = renderWithIntl(
      <CreatorStorefrontSection
        products={[{ ...PRODUCT, emoji: undefined, imageUrl }]}
        accent="#2563eb"
        theme="clean"
        sellerDisclosureHref="/ja/store/seller/0x1234"
      />,
    );
    fireEvent.error(
      withoutEmoji.container.querySelector(`img[src="${imageUrl}"]`)!,
    );
    expect(screen.getByText('✦')).toHaveAttribute('aria-hidden', 'true');
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

  it('autoOpenProductId が一致する商品の購入フローだけを開く', async () => {
    const secondProduct = {
      ...PRODUCT,
      id: `h_${'b'.repeat(32)}`,
      title: '第2の商品',
      imageUrl: 'https://cdn.example.com/product.png',
      galleryUrls: [
        'https://cdn.example.com/product-side.png',
        'https://cdn.example.com/product-back.png',
      ],
      usdcEnabled: true as const,
    };
    renderWithIntl(
      <CreatorStorefrontSection
        products={[PRODUCT, secondProduct]}
        accent="#2563eb"
        theme="clean"
        sellerDisclosureHref="/ja/store/seller/0x1234"
        autoOpenProductId={secondProduct.id}
      />,
    );

    await waitFor(() => {
      expect(purchaseFlowSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          open: true,
          product: expect.objectContaining({
            id: secondProduct.id,
            imageUrl: secondProduct.imageUrl,
            galleryUrls: secondProduct.galleryUrls,
            usdcEnabled: true,
          }),
        }),
      );
    });
    expect(purchaseFlowSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        product: expect.objectContaining({ id: PRODUCT.id }),
      }),
    );
  });
});
