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

    it('section 7 (OpenPay 利用手数料および gas 肩代わり) の本文に差額精算なしの明示', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'ja' });
      const section7Heading = screen.getByRole('heading', {
        level: 2,
        name: /^7\./,
      });
      const body = section7Heading.nextElementSibling;
      expect(body?.textContent).toMatch(/OpenPay 利用手数料/);
      expect(body?.textContent).toMatch(/gas 肩代わり/);
      expect(body?.textContent).toMatch(/差額精算/);
      expect(body?.textContent).toMatch(/取消.*返金.*修正/);
    });

    it('section 8 (アルファ版) の本文に少額テスト送信の指示', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'ja' });
      const section8Heading = screen.getByRole('heading', {
        level: 2,
        name: /^8\./,
      });
      const body = section8Heading.nextElementSibling;
      expect(body?.textContent).toMatch(/アルファ版/);
      expect(body?.textContent).toMatch(/少額.*テスト送信/);
    });

    it('intro に「お客様の支払い・店舗売上を預からない」ノンカストディ宣言が含まれる', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      // 「お客様の支払い」「店舗売上」「預かりません」の 3 語が同一文 (句点で区切られた
      // 範囲) に揃っていることを要求。前 regex は `|預かりません` の alternation で
      // 「預かりません」単独 (別 section の trailing 用) でも pass してしまっていた。
      expect(main.textContent).toMatch(
        /お客様の支払い[^。]*店舗売上[^。]*預かりません/,
      );
      expect(main.textContent).toMatch(/店舗ウォレットへ直接送金/);
    });

    it('en: section 7 / 8 が英訳で render される', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'en' });
      const section7 = screen.getByRole('heading', {
        level: 2,
        name: /^7\./,
      });
      const section8 = screen.getByRole('heading', {
        level: 2,
        name: /^8\./,
      });
      expect(section7.textContent).toMatch(/OpenPay Service Fee|Gas Sponsorship/);
      expect(section8.textContent).toMatch(/Alpha/);
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

    it('最終更新日が LEGAL_ENTITY.tokuteiEffectiveDate と一致', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      expect(
        screen.getByText(
          new RegExp(`最終更新日:\\s*${LEGAL_ENTITY.tokuteiEffectiveDate}`),
        ),
      ).toBeInTheDocument();
    });

    it('役務の対価: 1.0% 単独表記、最低手数料 (5 JPYC / 0.05 USDC) 文の不在 (regression guard)', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      // 1% プロポーショナル単独であることを正面で assert
      expect(main.textContent).toMatch(/1\.0%/);
      // MIN_FEE 文言の不在 (再導入されたら test 失敗)
      expect(main.textContent).not.toMatch(/最低 5 JPYC/);
      expect(main.textContent).not.toMatch(/最低 0\.05 USDC/);
    });

    it('支払時期: 「直接送金」表現で merchant 売上を預からない設計を明示', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      // ノンカストディ設計の明文化 — 「取引金額から自動的に控除」(預かり前提) でないこと
      expect(main.textContent).toMatch(/当社指定ウォレットへ直接送金/);
      // 「受領・保管・管理」と否定形「ものではありません」が同一文に並ぶことを要求。
      // 単語の存在だけ見ると「受領、保管、管理します」のような affirmation 改変で
      // CI が素通りするため、否定形までを regex に含めて意味反転を検出する。
      expect(main.textContent).toMatch(/受領.*保管.*管理.*ものではありません/);
      expect(main.textContent).not.toMatch(/取引金額から自動的に控除/);
    });

    it('OpenPay 利用手数料の負担者選択肢 (店主負担 / 顧客負担) を明示', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      expect(main.textContent).toMatch(/店主負担.*顧客負担|顧客負担.*店主負担/);
    });
  });

  describe('regression: MIN_FEE 撤廃の legal 反映', () => {
    it('Terms 第 5 条 (料金) に「最低 5 JPYC / 0.05 USDC」の文が現れない', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      const article5Heading = screen.getByRole('heading', {
        level: 2,
        name: /第 5 条/,
      });
      const body = article5Heading.nextElementSibling;
      expect(body?.textContent).toMatch(/1\.0%/);
      expect(body?.textContent).not.toMatch(/最低 5 JPYC/);
      expect(body?.textContent).not.toMatch(/最低 0\.05 USDC/);
    });

    it('Terms 施行日が LEGAL_ENTITY と同期 (今期改定の反映)', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      expect(
        screen.getByText(
          new RegExp(`施行日:\\s*${LEGAL_ENTITY.termsEffectiveDate}`),
        ),
      ).toBeInTheDocument();
    });

    it('en: Terms article 5 でも minimum fee 文の不在', () => {
      renderWithIntl(<TermsPage />, { locale: 'en' });
      const article5 = screen.getByRole('heading', {
        level: 2,
        name: /^Article 5 \(/,
      });
      const body = article5.nextElementSibling;
      expect(body?.textContent).not.toMatch(/minimum of 5 JPYC/);
      expect(body?.textContent).not.toMatch(/0\.05 USDC for USDC/);
    });
  });
});
