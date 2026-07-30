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
});
