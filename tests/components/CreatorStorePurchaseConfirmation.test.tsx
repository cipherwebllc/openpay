import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { getAddress } from 'viem';
import { renderWithIntl as render } from '../_helpers/i18n';
import { CreatorStorePurchaseConfirmation } from '@/components/CreatorStorePurchaseConfirmation';
import type { JpycRecoverSignPreview } from '@/lib/signPreview';

const preview: JpycRecoverSignPreview & { gasMode: 'customer' } = {
  kind: 'jpyc-recover',
  amountHuman: '100',
  feeHuman: '1',
  totalHuman: '101',
  totalAtomic: '101000000000000000000',
  merchant: getAddress('0x1234567890123456789012345678901234567890'),
  forwarder: getAddress('0x0f4560a777415580f0680f8b56a79b0022c6b848'),
  storeName: 'テスト販売者',
  gasMode: 'customer',
  expiresInMin: 10,
  decimals: 18,
  symbol: 'JPYC',
};

function renderConfirmation(over?: {
  isSubmitting?: boolean;
  onBack?: () => void;
  onConfirm?: () => void;
}) {
  return render(
    <CreatorStorePurchaseConfirmation
      product={{
        title: '旅の写真 ZIP',
        description: '高解像度 JPEG 10 枚',
      }}
      priceJpyc="100"
      feeJpyc="1"
      totalJpyc="101"
      sellerDisclosureHref="/ja/store/seller/0x1234"
      supportHref="mailto:seller@example.com"
      signPreview={preview}
      isSubmitting={over?.isSubmitting ?? false}
      onBack={over?.onBack ?? vi.fn()}
      onConfirm={over?.onConfirm ?? vi.fn()}
    />,
  );
}

describe('CreatorStorePurchaseConfirmation — 特商法 12 条の 6 fence', () => {
  it('USDC rail は Base 実払額・JPYC 商品価格・quote snapshot を両記する', () => {
    render(
      <CreatorStorePurchaseConfirmation
        rail="usdc"
        product={{ title: '旅の写真 ZIP' }}
        priceJpyc="300"
        paidUsdc="2"
        merchant="0x1234567890123456789012345678901234567890"
        quoteRate="150"
        quoteFetchedAt={1_800_000_000_000}
        quoteExpiresAt={1_800_000_180_000}
        sellerDisclosureHref="/ja/store/seller/0x1234"
        supportHref="mailto:seller@example.com"
        isSubmitting={false}
        onBack={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText('USDC · Base')).toBeInTheDocument();
    expect(screen.getByText('300 JPYC')).toBeInTheDocument();
    expect(screen.getByText('2 USDC')).toBeInTheDocument();
    expect(screen.getByText('1 USDC = 150 JPYC')).toBeInTheDocument();
    expect(screen.getByText('USDC 支払い署名の内容')).toBeInTheDocument();
    expect(
      screen.getByText(/nonce はサーバー発行値/),
    ).toHaveTextContent('transferWithAuthorization');
    expect(screen.queryByText(/求められるのは「署名」1回だけ/)).toBeNull();
  });

  it('署名前の最終確認に必須事項と数値の総額をすべて表示する', () => {
    renderConfirmation();

    expect(screen.getByRole('heading', { name: '購入内容の最終確認' }))
      .toBeInTheDocument();
    expect(screen.getByText('旅の写真 ZIP')).toBeInTheDocument();
    expect(
      screen.getByText(/1 回の購入で「旅の写真 ZIP」1 点を取得/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/購入記録はライブラリに恒久保存され/),
    ).toBeInTheDocument();
    expect(screen.getByText(/ライブラリから何度でも再ダウンロード/))
      .toBeInTheDocument();

    const priceRow = screen.getByText('商品価格').parentElement;
    const feeRow = screen.getByText('買い手負担 x402 手数料').parentElement;
    const totalRow = screen.getByText('支払総額（価格 + 手数料）').parentElement;
    expect(priceRow).not.toBeNull();
    expect(feeRow).not.toBeNull();
    expect(totalRow).not.toBeNull();
    expect(within(priceRow as HTMLElement).getByText('100 JPYC'))
      .toBeInTheDocument();
    expect(within(feeRow as HTMLElement).getByText('1 JPYC'))
      .toBeInTheDocument();
    expect(
      within(feeRow as HTMLElement).getByText(/価格の 1%（最低 1 JPYC）/),
    ).toBeInTheDocument();
    expect(within(totalRow as HTMLElement).getByText('101 JPYC'))
      .toBeInTheDocument();

    expect(screen.getByText(/署名すると、オンチェーンで精算/))
      .toHaveTextContent('JPYC を Polygon 上で支払います');
    expect(screen.getByText(/決済成立後、即時に提供/)).toBeInTheDocument();
    expect(screen.getByText(/自己都合による申込みの撤回・契約解除はできません/))
      .toHaveTextContent('オンチェーン送金は技術上取消不能です');
    expect(screen.getByText(/契約上の救済を妨げません/)).toBeInTheDocument();
    expect(screen.getByText(/購入者本人の私的利用/))
      .toHaveTextContent('再配布はできません');
    expect(screen.getByText(/技術的なコピー防止（DRM）はありません/))
      .toHaveTextContent('提供終了');

    expect(
      screen.getByRole('link', { name: /出品者の販売者情報を確認/ }),
    ).toHaveAttribute('href', '/ja/store/seller/0x1234');
    expect(
      screen.getByRole('link', { name: /販売者への連絡先を確認/ }),
    ).toHaveAttribute('href', 'mailto:seller@example.com');
    expect(screen.getByText(/商品が提供されない場合や説明と異なる場合/))
      .toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: '戻って内容を訂正する' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '支払って購入を確定する' }),
    ).toBeInTheDocument();
  });

  it('署名 wire と同じ preview を SignReassurance に表示する', () => {
    renderConfirmation();

    expect(
      screen.getByText(/求められるのは「署名」1回だけ/),
    ).toBeInTheDocument();
    expect(screen.getByText('101000000000000000000')).toBeInTheDocument();
    expect(screen.getByText(preview.forwarder)).toBeInTheDocument();
    expect(
      screen.getByText(/お支払い 100 \+ 手数料 1 = 101 JPYC/),
    ).toBeInTheDocument();
  });

  it('戻る・確定 callback を呼び、署名中は操作を無効化する', () => {
    const onBack = vi.fn();
    const onConfirm = vi.fn();
    const view = renderConfirmation({ onBack, onConfirm });

    fireEvent.click(
      screen.getByRole('button', { name: '戻って内容を訂正する' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: '支払って購入を確定する' }),
    );
    expect(onBack).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();

    view.unmount();
    renderConfirmation({ isSubmitting: true, onBack, onConfirm });
    expect(
      screen.getByRole('button', { name: '戻って内容を訂正する' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'ウォレットで署名を確認中…' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/ウォレットの署名画面をご確認ください/),
    ).toBeInTheDocument();
  });
});
