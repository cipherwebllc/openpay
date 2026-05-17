import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { NonCustodialNotice } from '@/components/NonCustodialNotice';

describe('NonCustodialNotice', () => {
  describe('short variant', () => {
    it('短縮 title と body を 1 行で描画する', () => {
      render(<NonCustodialNotice variant="short" />);
      expect(
        screen.getByText('履歴はブロックチェーン上にあります'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/正確な入金状況は店舗ウォレットまたは Explorer/),
      ).toBeInTheDocument();
    });

    it('role="note" + ⓘ アイコンが付く', () => {
      render(<NonCustodialNotice variant="short" />);
      const note = screen.getByRole('note');
      expect(note).toBeInTheDocument();
      expect(note.textContent).toContain('ⓘ');
    });

    it('full variant 用 title は描画されない (短縮 only)', () => {
      render(<NonCustodialNotice variant="short" />);
      expect(screen.queryByText('取引履歴について')).toBeNull();
    });
  });

  describe('full variant', () => {
    it('full title と body を h2 + p 構成で描画する', () => {
      render(<NonCustodialNotice variant="full" />);
      const heading = screen.getByRole('heading', { level: 2 });
      expect(heading).toHaveTextContent('取引履歴について');
      expect(
        screen.getByText(
          /OpenPay はノンカストディ設計のため、売上は店舗ウォレットへ直接送金されます/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/この画面の履歴は、店舗側の確認を補助するための表示です/),
      ).toBeInTheDocument();
    });

    it('aside タグ + role="note"', () => {
      const { container } = render(<NonCustodialNotice variant="full" />);
      const aside = container.querySelector('aside');
      expect(aside).not.toBeNull();
      expect(aside?.getAttribute('role')).toBe('note');
    });
  });

  describe('i18n', () => {
    it('en locale で英文が出る (short)', () => {
      render(<NonCustodialNotice variant="short" />, { locale: 'en' });
      expect(screen.getByText('Settlement lives on-chain')).toBeInTheDocument();
      expect(
        screen.getByText(/OpenPay is non-custodial\. For authoritative settlement/),
      ).toBeInTheDocument();
    });

    it('en locale で英文が出る (full)', () => {
      render(<NonCustodialNotice variant="full" />, { locale: 'en' });
      expect(
        screen.getByRole('heading', { name: 'About transaction history' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /OpenPay is non-custodial — funds are sent directly to your merchant wallet/,
        ),
      ).toBeInTheDocument();
    });
  });

  describe('styling extensibility', () => {
    it('className prop が append される (short)', () => {
      render(
        <NonCustodialNotice variant="short" className="custom-class-x" />,
      );
      expect(screen.getByRole('note').className).toContain('custom-class-x');
    });

    it('className prop が append される (full)', () => {
      const { container } = render(
        <NonCustodialNotice variant="full" className="custom-class-y" />,
      );
      const aside = container.querySelector('aside');
      expect(aside?.className).toContain('custom-class-y');
    });
  });
});
