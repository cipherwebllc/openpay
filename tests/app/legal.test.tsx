import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import TermsPage from '@/app/[locale]/terms/page';
import PrivacyPage from '@/app/[locale]/privacy/page';
import DisclaimerPage from '@/app/[locale]/disclaimer/page';
import TokuteiPage from '@/app/[locale]/tokutei/page';
import { LEGAL_ENTITY } from '@/lib/legal';

describe('Legal pages', () => {
  describe('Terms (利用規約)', () => {
    it('ja: h1 と 11 条すべての title が render される', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      expect(
        screen.getByRole('heading', { level: 1, name: '利用規約' }),
      ).toBeInTheDocument();
      // 11 条すべて
      for (let n = 1; n <= 11; n++) {
        expect(
          screen.getByRole('heading', {
            level: 2,
            name: new RegExp(`第 ${n} 条`),
          }),
        ).toBeInTheDocument();
      }
      // 事業者名が footer 領域に表示
      expect(screen.getAllByText(LEGAL_ENTITY.companyName).length).toBeGreaterThan(0);
    });

    it('en: h1 が Terms of Service、第 1..11 条の英訳 heading が出る', () => {
      renderWithIntl(<TermsPage />, { locale: 'en' });
      expect(
        screen.getByRole('heading', { level: 1, name: 'Terms of Service' }),
      ).toBeInTheDocument();
      for (let n = 1; n <= 11; n++) {
        // "Article 1" は "Article 10" / "Article 11" にも prefix match して
        // しまうので、直後に space + open-paren を要求して anchored にする。
        expect(
          screen.getByRole('heading', {
            level: 2,
            name: new RegExp(`^Article ${n} \\(`),
          }),
        ).toBeInTheDocument();
      }
    });

    it('施行日が表示される', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      expect(
        screen.getByText(
          new RegExp(`施行日:\\s*${LEGAL_ENTITY.termsEffectiveDate}`),
        ),
      ).toBeInTheDocument();
    });
  });

  describe('Privacy (プライバシーポリシー)', () => {
    it('ja: h1 と 7 section の title が render される', () => {
      renderWithIntl(<PrivacyPage />, { locale: 'ja' });
      expect(
        screen.getByRole('heading', {
          level: 1,
          name: 'プライバシーポリシー',
        }),
      ).toBeInTheDocument();
      for (let n = 1; n <= 7; n++) {
        expect(
          screen.getByRole('heading', {
            level: 2,
            name: new RegExp(`^${n}\\.`),
          }),
        ).toBeInTheDocument();
      }
    });

    it('en: h1 が Privacy Policy', () => {
      renderWithIntl(<PrivacyPage />, { locale: 'en' });
      expect(
        screen.getByRole('heading', { level: 1, name: 'Privacy Policy' }),
      ).toBeInTheDocument();
    });

    it('section 6 (お問い合わせ窓口) に連絡先 email が含まれる', () => {
      renderWithIntl(<PrivacyPage />, { locale: 'ja' });
      // text node 全体に email が含まれる
      expect(
        screen.getAllByText(new RegExp(LEGAL_ENTITY.contactEmail)).length,
      ).toBeGreaterThan(0);
    });

    it('section 3 (第三者提供) に Vercel / Pimlico / Alchemy が含まれる', () => {
      renderWithIntl(<PrivacyPage />, { locale: 'ja' });
      const section3Heading = screen.getByRole('heading', {
        level: 2,
        name: /^3\./,
      });
      const sectionBody = section3Heading.nextElementSibling;
      expect(sectionBody?.textContent).toContain('Vercel');
      expect(sectionBody?.textContent).toContain('Pimlico');
      expect(sectionBody?.textContent).toContain('Alchemy');
    });
  });

  describe('Disclaimer (免責事項)', () => {
    it('ja: h1 と 8 section の title が render される', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'ja' });
      expect(
        screen.getByRole('heading', { level: 1, name: '免責事項' }),
      ).toBeInTheDocument();
      for (let n = 1; n <= 8; n++) {
        expect(
          screen.getByRole('heading', {
            level: 2,
            name: new RegExp(`^${n}\\.`),
          }),
        ).toBeInTheDocument();
      }
    });

    it('en: h1 が Disclaimer', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'en' });
      expect(
        screen.getByRole('heading', { level: 1, name: 'Disclaimer' }),
      ).toBeInTheDocument();
    });

    it('ブロックチェーン取消不能の警告 (section 2) が含まれる', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'ja' });
      const section2 = screen.getByRole('heading', {
        level: 2,
        name: /^2\./,
      });
      expect(section2.textContent).toMatch(/不可逆性|取消/);
    });
  });

  describe('Tokutei (特商法表記)', () => {
    it('ja: h1 と必須 row (販売事業者 / 所在地 / 役務の対価 / 返品) が render される', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      expect(
        screen.getByRole('heading', { level: 1, name: '特定商取引法に基づく表記' }),
      ).toBeInTheDocument();
      // 主要 row label が出ている
      expect(screen.getByText('販売事業者')).toBeInTheDocument();
      expect(screen.getByText('所在地')).toBeInTheDocument();
      expect(screen.getByText('電話番号')).toBeInTheDocument();
      expect(screen.getByText('役務の対価 (OpenPay 利用手数料)')).toBeInTheDocument();
      expect(screen.getByText('返品・キャンセル')).toBeInTheDocument();
    });

    it('事業者情報 (法人番号 / 所在地 / 代表者 / メール) が LEGAL_ENTITY から注入される', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      expect(main.textContent).toContain(LEGAL_ENTITY.companyName);
      expect(main.textContent).toContain(LEGAL_ENTITY.corporateNumber);
      expect(main.textContent).toContain(LEGAL_ENTITY.headOffice);
      expect(main.textContent).toContain(LEGAL_ENTITY.representative);
      expect(main.textContent).toContain(LEGAL_ENTITY.contactEmail);
      expect(main.textContent).toContain(LEGAL_ENTITY.siteUrl);
    });

    it('電話番号は施行規則 23 条 exception の文言で記載 (請求あり次第開示)', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      expect(main.textContent).toMatch(/第 23 条/);
      expect(main.textContent).toMatch(/遅滞なく/);
    });

    it('en: h1 が Business Disclosure、phone exception 文言は英訳', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'en' });
      expect(
        screen.getByRole('heading', {
          level: 1,
          name: /Business Disclosure/,
        }),
      ).toBeInTheDocument();
      const main = screen.getByRole('main');
      expect(main.textContent).toMatch(/Article 23/);
      expect(main.textContent).toMatch(/without delay/);
    });
  });
});
