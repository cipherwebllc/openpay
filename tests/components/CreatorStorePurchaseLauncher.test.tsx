import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStorePurchaseLauncher } from '@/components/CreatorStorePurchaseLauncher';

const { purchaseFlowSpy } = vi.hoisted(() => ({
  purchaseFlowSpy: vi.fn(),
}));

vi.mock('@/components/CreatorStorePurchaseFlow', () => ({
  CreatorStorePurchaseFlow: (props: { open: boolean; showProductDetails?: boolean }) => {
    purchaseFlowSpy(props);
    return props.open ? <div role="dialog">購入フロー</div> : null;
  },
}));

const PRODUCT = {
  id: `h_${'a'.repeat(32)}`,
  title: 'AI プロンプト集',
  description: '仕事で使えるテンプレート',
  details: '内容物\n使い方',
  specs: [{ label: '形式', value: 'GLB' }],
  demoUrl: 'https://example.com/demo',
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

  it('商品ページ (focus) の主ボタンは、詳しい説明を繰り返さない購入フローを開く', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <CreatorStorePurchaseLauncher
        product={PRODUCT}
        sellerDisclosureHref="/ja/store/seller/0x1234"
        inverted={false}
        variant="focus"
        totalLabel="1,212 JPYC"
      />,
    );
    expect(purchaseFlowSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '購入する' }));
    await waitFor(() => {
      expect(purchaseFlowSpy).toHaveBeenCalledWith(
        expect.objectContaining({ open: true, product: PRODUCT, showProductDetails: false }),
      );
    });
  });

  it('カードの購入ボタンは従来どおり詳しい説明つきの購入フローを開く', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <CreatorStorePurchaseLauncher
        product={PRODUCT}
        sellerDisclosureHref="/ja/store/seller/0x1234"
        inverted={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: '購入する' }));
    await waitFor(() => {
      expect(purchaseFlowSpy).toHaveBeenCalledWith(
        expect.objectContaining({ open: true, showProductDetails: true }),
      );
    });
  });

  describe('商品ページの画面下の固定購入バー', () => {
    let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    const disconnect = vi.fn();
    beforeEach(() => {
      observerCallback = null;
      disconnect.mockClear();
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
            observerCallback = callback;
          }
          observe() {}
          disconnect() {
            disconnect();
          }
        },
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('ページ内の購入ボタンが画面外の間だけ出し、押すと同じ購入フローを開く', async () => {
      const user = userEvent.setup();
      const { unmount } = renderWithIntl(
        <CreatorStorePurchaseLauncher
          product={PRODUCT}
          sellerDisclosureHref="/ja/store/seller/0x1234"
          inverted={false}
          variant="focus"
          totalLabel="1,212 JPYC"
        />,
      );
      // 初期 (画面内) は 1 つだけ。
      expect(screen.getAllByRole('button', { name: '購入する' })).toHaveLength(1);
      act(() => observerCallback?.([{ isIntersecting: false }]));
      expect(screen.getAllByRole('button', { name: '購入する' })).toHaveLength(2);
      expect(screen.getByText('1,212 JPYC')).toBeInTheDocument();
      act(() => observerCallback?.([{ isIntersecting: true }]));
      expect(screen.getAllByRole('button', { name: '購入する' })).toHaveLength(1);

      act(() => observerCallback?.([{ isIntersecting: false }]));
      await user.click(screen.getAllByRole('button', { name: '購入する' })[1]);
      await waitFor(() => {
        expect(purchaseFlowSpy).toHaveBeenCalledWith(
          expect.objectContaining({ open: true, showProductDetails: false }),
        );
      });
      // 購入画面を開いている間も固定バーのボタンは外さない (閉じたときの focus の戻し先)。
      const stickyButton = screen.getAllByRole('button', { name: '購入する' })[1];
      expect(stickyButton).toBeInTheDocument();
      act(() => observerCallback?.([{ isIntersecting: false }]));
      expect(screen.getAllByRole('button', { name: '購入する' })[1]).toBe(stickyButton);
      unmount();
      expect(disconnect).toHaveBeenCalled();
    });

    it('カードの launcher は観測しない (固定バーは商品ページだけ)', () => {
      renderWithIntl(
        <CreatorStorePurchaseLauncher
          product={PRODUCT}
          sellerDisclosureHref="/ja/store/seller/0x1234"
          inverted={false}
        />,
      );
      expect(observerCallback).toBeNull();
    });
  });
});
