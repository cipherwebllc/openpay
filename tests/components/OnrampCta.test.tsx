import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { OnrampCta } from '@/components/OnrampCta';

describe('OnrampCta', () => {
  describe('ja locale', () => {
    it('jpyc: JPYC EX リンクと購入文言を出す、注記なし', () => {
      render(<OnrampCta token="jpyc" namespace="PaymentForm" />, {
        locale: 'ja',
      });
      const link = screen.getByRole('link', {
        name: /JPYC EX で JPYC を購入/,
      });
      expect(link).toHaveAttribute('href', 'https://jpyc.co.jp/');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.queryByText(/日本居住者のみ/)).toBeNull();
      expect(screen.queryByText(/SBI VC トレード/)).toBeNull();
    });

    it('usdc: SBI VC トレード リンクと購入文言を出す、注記なし', () => {
      render(<OnrampCta token="usdc" namespace="PaymentForm" />, {
        locale: 'ja',
      });
      const link = screen.getByRole('link', {
        name: /SBI VC トレード で USDC を購入/,
      });
      expect(link).toHaveAttribute('href', 'https://www.sbivc.co.jp/');
      expect(link).toHaveAttribute('target', '_blank');
      expect(screen.queryByText(/日本居住者のみ/)).toBeNull();
    });
  });

  describe('en locale', () => {
    it('jpyc: JPYC EX + Japan residents only 注記', () => {
      render(<OnrampCta token="jpyc" namespace="PaymentForm" />, {
        locale: 'en',
      });
      const link = screen.getByRole('link', {
        name: /Buy JPYC on JPYC EX/,
      });
      expect(link).toHaveAttribute('href', 'https://jpyc.co.jp/');
      expect(screen.getByText(/Japan residents only/)).toBeInTheDocument();
      expect(
        screen.queryByText(/switch to Japanese for SBI VC Trade/),
      ).toBeNull();
    });

    it('usdc: Coinbase + Japan residents への locale switch hint', () => {
      render(<OnrampCta token="usdc" namespace="PaymentForm" />, {
        locale: 'en',
      });
      const link = screen.getByRole('link', {
        name: /Buy USDC on Coinbase/,
      });
      expect(link).toHaveAttribute('href', 'https://www.coinbase.com/');
      expect(
        screen.getByText(/Japan residents: switch to Japanese for SBI VC Trade/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Japan residents only/)).toBeNull();
    });
  });

  describe('namespace 互換性', () => {
    it('TipForm namespace でも同じ文言が引ける', () => {
      render(<OnrampCta token="jpyc" namespace="TipForm" />, { locale: 'ja' });
      expect(
        screen.getByRole('link', { name: /JPYC EX で JPYC を購入/ }),
      ).toBeInTheDocument();
    });

    it('CheckoutForm namespace でも同じ文言が引ける', () => {
      render(<OnrampCta token="usdc" namespace="CheckoutForm" />, {
        locale: 'ja',
      });
      expect(
        screen.getByRole('link', { name: /SBI VC トレード で USDC を購入/ }),
      ).toBeInTheDocument();
    });
  });

  describe('セキュリティ', () => {
    it('全リンクが target=_blank + rel=noopener noreferrer (phishing 防御)', () => {
      const { unmount: unmount1 } = render(
        <OnrampCta token="jpyc" namespace="PaymentForm" />,
        { locale: 'ja' },
      );
      let link = screen.getByRole('link');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      unmount1();

      const { unmount: unmount2 } = render(
        <OnrampCta token="usdc" namespace="PaymentForm" />,
        { locale: 'en' },
      );
      link = screen.getByRole('link');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      unmount2();
    });
  });
});
