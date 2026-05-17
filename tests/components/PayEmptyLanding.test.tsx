import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { PayEmptyLanding } from '@/components/PayEmptyLanding';

describe('PayEmptyLanding', () => {
  it('title と body を描画する (ja)', () => {
    render(<PayEmptyLanding />);
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'ここは「顧客向け」決済ページです',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/店舗の OpenPay QR を読み取るか/),
    ).toBeInTheDocument();
  });

  it('home (/) link が出る', () => {
    render(<PayEmptyLanding />);
    const link = screen.getByRole('link', {
      name: 'OpenPay (店舗向け) を開く',
    });
    expect(link).toHaveAttribute('href', '/');
  });

  it('履歴 (/history) link が出る', () => {
    render(<PayEmptyLanding />);
    const link = screen.getByRole('link', {
      name: 'このブラウザの履歴を見る',
    });
    expect(link).toHaveAttribute('href', '/history');
  });

  it('en locale で英文', () => {
    render(<PayEmptyLanding />, { locale: 'en' });
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'This is the customer payment page',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open OpenPay (merchant)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'View history on this browser' }),
    ).toBeInTheDocument();
  });
});
