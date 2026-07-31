import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStorePurchaseLauncher } from '@/components/CreatorStorePurchaseLauncher';

const { purchaseFlowSpy } = vi.hoisted(() => ({
  purchaseFlowSpy: vi.fn(),
}));

vi.mock('@/components/CreatorStorePurchaseFlow', () => ({
  CreatorStorePurchaseFlow: (props: { open: boolean }) => {
    purchaseFlowSpy(props);
    return props.open ? <div role="dialog">購入フロー</div> : null;
  },
}));

const PRODUCT = {
  id: `h_${'a'.repeat(32)}`,
  title: 'AI プロンプト集',
  description: '仕事で使えるテンプレート',
  imageUrl: 'https://cdn.example.com/product.png',
  galleryUrls: [
    'https://cdn.example.com/product-side.png',
    'https://cdn.example.com/product-back.png',
  ],
  priceJpyc: '1200',
  merchant: '0x2222222222222222222222222222222222222222' as const,
};

describe('CreatorStorePurchaseLauncher', () => {
  beforeEach(() => {
    purchaseFlowSpy.mockClear();
  });

  it('通常時は購入ボタンを押すまで購入フローを読み込まない', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <CreatorStorePurchaseLauncher
        product={PRODUCT}
        sellerDisclosureHref="/ja/store/seller/0x1234"
        inverted={false}
      />,
    );

    expect(purchaseFlowSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '購入する' }));

    await waitFor(() => {
      expect(purchaseFlowSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          open: true,
          product: PRODUCT,
        }),
      );
    });
  });

  it('autoOpen 時は mount で購入フローを開く', async () => {
    renderWithIntl(
      <CreatorStorePurchaseLauncher
        product={PRODUCT}
        sellerDisclosureHref="/ja/store/seller/0x1234"
        inverted={false}
        autoOpen
      />,
    );

    expect(await screen.findByRole('dialog')).toHaveTextContent('購入フロー');
    expect(purchaseFlowSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        open: true,
        product: PRODUCT,
      }),
    );
  });
});
