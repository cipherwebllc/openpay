import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { CreatorStorePurchaseState } from '@/components/CreatorStorePurchaseState';

const base = {
  libraryHref: '/ja/store/library',
  supportHref: 'mailto:seller@example.com',
} as const;

describe('CreatorStorePurchaseState', () => {
  it('own read-back 前は access=ready 入力でも購入完了・ライブラリ導線を出さない', () => {
    render(
      <CreatorStorePurchaseState
        {...base}
        paymentStatus="confirmed"
        accessStatus="ready"
        ownershipReadBack={false}
      />,
    );

    expect(screen.queryByText('購入完了')).toBeNull();
    expect(screen.queryByRole('link', { name: 'ライブラリで開く' })).toBeNull();
    expect(screen.getByText('商品の引き渡しを確認中')).toBeInTheDocument();
    expect(
      screen.getByText(
        '決済は成立しました。商品の引き渡しを確認中です。自動で確認を続けます。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('成立')).toBeInTheDocument();
    expect(screen.getByText('引き渡し確認中')).toBeInTheDocument();
  });

  it('content API 200 の own read-back 後だけ購入完了とライブラリ導線を出す', () => {
    render(
      <CreatorStorePurchaseState
        {...base}
        paymentStatus="confirmed"
        accessStatus="ready"
        ownershipReadBack
      />,
    );

    expect(screen.getByText('購入完了')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'ライブラリで開く' }),
    ).toHaveAttribute('href', '/ja/store/library');
    expect(screen.getByText('利用可能')).toBeInTheDocument();
  });

  it('USDC 購入完了は P1 payment snapshot の実払額と JPYC 価格を描画する', () => {
    render(
      <CreatorStorePurchaseState
        {...base}
        paymentStatus="confirmed"
        accessStatus="ready"
        ownershipReadBack
        payment={{
          version: 1,
          rail: 'usdc',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetSymbol: 'USDC',
          chainId: 8453,
          paidAtomic: '2000000',
          priceJpyc: '300',
          quote: {
            rateScaled: '150000000',
            rateFetchedAt: 1_800_000_000_000,
            fxQuoteExpiresAt: 1_800_000_180_000,
            rounding: 'ceil',
          },
        }}
      />,
    );

    expect(screen.getByText('決済スナップショット v1')).toBeInTheDocument();
    expect(screen.getByText('2 USDC')).toBeInTheDocument();
    expect(screen.getByText('300 JPYC')).toBeInTheDocument();
    expect(screen.getByText('USDC · Base (8453)')).toBeInTheDocument();
  });

  it('failed_prebroadcast は支払い未実行を明示する', () => {
    render(
      <CreatorStorePurchaseState
        {...base}
        paymentStatus="not-executed"
        accessStatus="none"
        ownershipReadBack={false}
      />,
    );

    expect(screen.getByText('支払いは実行されていません')).toBeInTheDocument();
    expect(screen.queryByText('購入完了')).toBeNull();
  });

  it('202 継続中は二重払い禁止と自動確認中を明示する', () => {
    render(
      <CreatorStorePurchaseState
        {...base}
        paymentStatus="unknown"
        accessStatus="none"
        ownershipReadBack={false}
      />,
    );

    expect(screen.getByText(/二重に支払わないでください/))
      .toHaveTextContent('自動で確認中です');
    expect(screen.queryByText('購入完了')).toBeNull();
  });

  it('90 秒を過ぎても自動確認を続けている間は、確定すると自動で表示される旨を出す', () => {
    render(
      <CreatorStorePurchaseState
        {...base}
        paymentStatus="unknown"
        accessStatus="needs-support"
        ownershipReadBack={false}
        autoChecking
      />,
    );

    expect(
      screen.getByText(
        '決済結果を確認中です。確定すると、この画面に自動で表示されます。二重に支払わないでください。',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/決済結果を確定できません/)).toBeNull();
    expect(screen.queryByText('購入完了')).toBeNull();
    // 見た目は決済待ち (pending) と同じ黄色・「引き渡し確認中」。赤と「要問い合わせ」は出さない。
    const status = screen.getByRole('status');
    expect(status).toHaveClass('border-amber-200', 'bg-amber-50');
    expect(status).not.toHaveClass('border-red-200');
    expect(screen.getByText('確認中')).toBeInTheDocument();
    expect(screen.getByText('引き渡し確認中')).toBeInTheDocument();
    expect(screen.queryByText('要問い合わせ')).toBeNull();
  });

  it('自動確認を止めた後は、二重に支払わず販売者へ問い合わせる案内に戻す', () => {
    render(
      <CreatorStorePurchaseState
        {...base}
        paymentStatus="unknown"
        accessStatus="needs-support"
        ownershipReadBack={false}
      />,
    );

    expect(
      screen.getByText(
        '決済結果を確定できません。二重に支払わず、販売者へお問い合わせください。',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/確定すると、この画面に自動で表示されます/)).toBeNull();
    expect(
      screen.getByRole('link', { name: '販売者へ問い合わせる' }),
    ).toHaveAttribute('href', 'mailto:seller@example.com');
    // 確認を止めた後は、今どおり赤と「要問い合わせ」。
    const status = screen.getByRole('status');
    expect(status).toHaveClass('border-red-200', 'bg-red-50');
    expect(status).not.toHaveClass('border-amber-200');
    expect(screen.getByText('要問い合わせ')).toBeInTheDocument();
    expect(screen.queryByText('引き渡し確認中')).toBeNull();
  });

  it('決済が成立した後の引き渡し不明は、自動確認の有無で文言を変えない', () => {
    render(
      <CreatorStorePurchaseState
        {...base}
        paymentStatus="confirmed"
        accessStatus="needs-support"
        ownershipReadBack={false}
        autoChecking
      />,
    );

    expect(
      screen.getByText(
        '決済は成立していますが、商品の引き渡しを確認できません。二重に支払わず、販売者へお問い合わせください。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('border-red-200');
    expect(screen.getByText('要問い合わせ')).toBeInTheDocument();
  });
});
