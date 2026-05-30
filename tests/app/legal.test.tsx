import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import TermsPage from '@/app/[locale]/terms/page';
import PrivacyPage from '@/app/[locale]/privacy/page';
import DisclaimerPage from '@/app/[locale]/disclaimer/page';
import TokuteiPage from '@/app/[locale]/tokutei/page';
import { LEGAL_ENTITY } from '@/lib/legal';
import { TOKEN_DEPLOYMENTS } from '@/lib/tokens';
import { USDC_CHAINS, chainForSlug } from '@/lib/chains';

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

    it('section 3 (第三者提供) に Vercel / Pimlico / Alchemy / Circle が含まれる', () => {
      renderWithIntl(<PrivacyPage />, { locale: 'ja' });
      const section3Heading = screen.getByRole('heading', {
        level: 2,
        name: /^3\./,
      });
      const sectionBody = section3Heading.nextElementSibling;
      expect(sectionBody?.textContent).toContain('Vercel');
      expect(sectionBody?.textContent).toContain('Pimlico');
      expect(sectionBody?.textContent).toContain('Alchemy');
      // Circle Paymaster (USDC ガスレス) を委託先として開示 (provider 次元・C4)。
      expect(sectionBody?.textContent).toContain('Circle');
      expect(sectionBody?.textContent).toMatch(/Paymaster/);
      // 当社徴収0の明示 (paymasterMode='erc20' の真正性: 顧客が USDC で gas 負担)。
      expect(sectionBody?.textContent).toMatch(/徴収・取得することはありません/);
    });

    it('en: section 3 に Circle Paymaster 委託先開示 + 当社徴収0', () => {
      renderWithIntl(<PrivacyPage />, { locale: 'en' });
      const section3Heading = screen.getByRole('heading', {
        level: 2,
        name: /^3\./,
      });
      const sectionBody = section3Heading.nextElementSibling;
      expect(sectionBody?.textContent).toContain('Circle');
      expect(sectionBody?.textContent).toMatch(/Paymaster/);
      expect(sectionBody?.textContent).toMatch(/does not collect or receive/i);
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

    it('役務の対価: alpha 期間中 0% を明示、旧 % 手数料 (1.0%/0.5%) と最低手数料文の不在 (regression guard)', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      // Phase 1: 0% (無料) を正面で assert、旧 % 表記は撤去済
      expect(main.textContent).toMatch(/0%/);
      expect(main.textContent).not.toMatch(/1\.0%/);
      expect(main.textContent).not.toMatch(/0\.5%/);
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

    it('ネットワーク手数料相当額の負担者選択 (顧客 / 店主) を明示', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      // Phase 1: gasless の gas 相当額の負担者を店主が選択できる旨
      expect(main.textContent).toMatch(/負担者.*顧客.*店主|顧客 \/ 店主/);
    });
  });

  describe('regression: MIN_FEE 撤廃の legal 反映', () => {
    it('Terms 第 5 条 (料金) は 0% を明示し、旧 % 手数料 / 最低手数料文が現れない', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      const article5Heading = screen.getByRole('heading', {
        level: 2,
        name: /第 5 条/,
      });
      const body = article5Heading.nextElementSibling;
      // Phase 1: 0% 化、旧 % 表記と MIN_FEE 文言は撤去済
      expect(body?.textContent).toMatch(/0%/);
      expect(body?.textContent).not.toMatch(/1\.0%/);
      expect(body?.textContent).not.toMatch(/0\.5%/);
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

  // -------------------------------------------------------------------------
  // 通常決済（ガスあり） / mode=standard 追加に伴う両モード並記 regression
  // -------------------------------------------------------------------------
  describe('regression: 通常決済（ガスあり）モード追加', () => {
    it('ja Terms 第 5 条 (料金) は Phase 1 で 0% 化、両モードとネットワーク手数料負担者選択を明記', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      const article5 = screen.getByRole('heading', {
        level: 2,
        name: /第 5 条/,
      });
      const body = article5.nextElementSibling;
      expect(body?.textContent).toMatch(/ガスレス決済/);
      expect(body?.textContent).toMatch(/通常決済（ガスあり）/);
      // Phase 1: 0% 化、旧 % 手数料は撤去
      expect(body?.textContent).toMatch(/0%/);
      expect(body?.textContent).not.toMatch(/1\.0%/);
      expect(body?.textContent).not.toMatch(/0\.5%/);
      // ネットワーク手数料相当額の負担者選択 (顧客/店主) を明記
      expect(body?.textContent).toMatch(/顧客負担または店主負担/);
    });

    it('ja Terms 第 2 条 (定義) で「ガスレス決済」「通常決済（ガスあり）」が定義語として導入される', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      const article2 = screen.getByRole('heading', {
        level: 2,
        name: /第 2 条/,
      });
      const body = article2.nextElementSibling;
      expect(body?.textContent).toMatch(/「ガスレス決済」/);
      expect(body?.textContent).toMatch(/「通常決済（ガスあり）」/);
    });

    it('en Terms Article 5 は Phase 1 で 0% 化、両モード記載で旧 % 手数料は不在', () => {
      renderWithIntl(<TermsPage />, { locale: 'en' });
      const article5 = screen.getByRole('heading', {
        level: 2,
        name: /^Article 5 \(/,
      });
      const body = article5.nextElementSibling;
      expect(body?.textContent).toMatch(/Gasless Payment/);
      expect(body?.textContent).toMatch(/Standard Payment/);
      expect(body?.textContent).toMatch(/0%/);
      expect(body?.textContent).not.toMatch(/1\.0%/);
      expect(body?.textContent).not.toMatch(/0\.5%/);
    });

    it('ja Tokutei 役務の対価 は Phase 1 で 0% 化、両モード記載で旧 % 手数料は不在', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      expect(main.textContent).toMatch(/0%/);
      expect(main.textContent).not.toMatch(/1\.0%/);
      expect(main.textContent).not.toMatch(/0\.5%/);
      expect(main.textContent).toMatch(/ガスレス決済/);
      expect(main.textContent).toMatch(/通常決済（ガスあり）/);
    });

    it('ja Disclaimer 第 4 条 (ネットワーク手数料の変動) で両モードの取扱いが明記', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'ja' });
      const section4 = screen.getByRole('heading', { level: 2, name: /^4\./ });
      const body = section4.nextElementSibling;
      // gasless mode 固有の gas 見積の話と、standard mode で wallet 側に委ねる話が両方
      expect(body?.textContent).toMatch(/ガスレス決済モード/);
      expect(body?.textContent).toMatch(/通常決済（ガスあり）モード/);
    });

    it('ja Disclaimer 第 7 条 で standard mode は OpenPay が gas に関与しない旨を明記', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'ja' });
      const section7 = screen.getByRole('heading', { level: 2, name: /^7\./ });
      const body = section7.nextElementSibling;
      // 通常決済モードについて当社がネットワーク手数料に関与しないことを記載
      expect(body?.textContent).toMatch(/通常決済（ガスあり）モード/);
      expect(body?.textContent).toMatch(/ネットワーク手数料に一切関与せず/);
    });

    it('用語統一: Terms 全条文で「運営手数料」が消えている (= 「OpenPay 利用手数料」に統一)', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      expect(main.textContent).not.toMatch(/運営手数料/);
      // 「OpenPay 利用手数料」が複数回出ている
      const matches = main.textContent?.match(/OpenPay 利用手数料/g);
      expect(matches?.length ?? 0).toBeGreaterThanOrEqual(3);
    });

    it('用語統一: Disclaimer / Tokutei / Privacy で「運営手数料」が消えている', () => {
      for (const Page of [DisclaimerPage, TokuteiPage, PrivacyPage]) {
        const { unmount } = renderWithIntl(<Page />, { locale: 'ja' });
        const main = screen.getByRole('main');
        expect(main.textContent).not.toMatch(/運営手数料/);
        unmount();
      }
    });

    it('mode=direct (旧名) は legal 文書本文にも現れない (用語統一)', () => {
      for (const Page of [TermsPage, DisclaimerPage, TokuteiPage]) {
        const { unmount } = renderWithIntl(<Page />, { locale: 'ja' });
        const main = screen.getByRole('main');
        // 旧名 "mode=direct" や "直接送金" の言及がない (UI 文言からも撤去済)
        expect(main.textContent).not.toMatch(/mode=direct/);
        unmount();
      }
    });

    it('effectiveDate: 手数料 0% / 案A 改定で terms/tokutei/disclaimer は 2026-05-29、privacy は 2026-05-16 据置', () => {
      // 2026-05-29: 料金条項 (Terms 第5条 / 特商法 役務の対価) を 0% 化に改定。
      // Disclaimer も同改定で「送金されるのはネットワーク手数料相当額」へ冒頭・第7条を
      // 修正し、Terms 第9条(2) 賠償上限を固定額ベースに改めたため 2026-05-29 に更新。
      // privacy は料金モデルに直接言及しないため 2026-05-16 据置。
      expect(LEGAL_ENTITY.termsEffectiveDate).toBe('2026-05-29');
      expect(LEGAL_ENTITY.tokuteiEffectiveDate).toBe('2026-05-29');
      expect(LEGAL_ENTITY.disclaimerEffectiveDate).toBe('2026-05-29');
      expect(LEGAL_ENTITY.privacyEffectiveDate).toBe('2026-05-16');
    });
  });

  // -------------------------------------------------------------------------
  // i18n 完全性 — 全 mode 関連 key が ja / en 両方に存在
  // -------------------------------------------------------------------------
  describe('regression: i18n key 完全性 (両モード新規 key の存在検証)', () => {
    // 空文字列 / 空白のみ / undefined のいずれも reject (空文字列 i18n が UI に
     // 出ると label が消える silent regression を防ぐ)。
    function expectNonEmptyString(value: unknown, key: string, locale: string) {
      expect(value, `${locale}.${key}`).toBeTypeOf('string');
      expect((value as string).trim().length, `${locale}.${key} は非空である必要`).toBeGreaterThan(0);
    }

    it('PaymentForm namespace に standard mode 用 key が全て存在 (ja/en、非空文字列)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      const requiredKeys = [
        'standardModeTitle',
        'standardModeBody',
        'modeBadgeGasless',
        'modeBadgeStandard',
        'gasRowStandard',
        'gasRowStandardValue',
        'customerStandard',
        'standardBatchHint',
        'standardMerchantTxLabel',
        'standardFeeTxLabel',
        'standardFeeRetryTitle',
        'standardFeeRetryBody',
        'standardFeeRetryButton',
        'btnStandardMerchantSending',
        'btnStandardMerchantMining',
        'btnStandardFeeSending',
        'btnStandardFeeMining',
      ];
      for (const key of requiredKeys) {
        expectNonEmptyString(
          ja.PaymentForm[key as keyof typeof ja.PaymentForm],
          key,
          'ja.PaymentForm',
        );
        expectNonEmptyString(
          en.PaymentForm[key as keyof typeof en.PaymentForm],
          key,
          'en.PaymentForm',
        );
      }
    });

    it('CheckoutForm namespace に standard mode 用 key が全て存在 (ja/en、非空文字列)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      const requiredKeys = [
        'modeBadgeGasless',
        'modeBadgeStandard',
        'gasRowStandard',
        'gasRowStandardValue',
        'totalRowStandard',
        'standardHint',
        'standardMerchantTxLabel',
        'standardFeeTxLabel',
        'standardFeeRetryTitle',
        'standardFeeRetryBody',
        'standardFeeRetryButton',
        'btnStandardMerchantSending',
        'btnStandardMerchantMining',
        'btnStandardFeeSending',
        'btnStandardFeeMining',
      ];
      for (const key of requiredKeys) {
        expectNonEmptyString(
          ja.CheckoutForm[key as keyof typeof ja.CheckoutForm],
          key,
          'ja.CheckoutForm',
        );
        expectNonEmptyString(
          en.CheckoutForm[key as keyof typeof en.CheckoutForm],
          key,
          'en.CheckoutForm',
        );
      }
    });

    it('QrGenerator / CheckoutLinkGenerator に payMode radio 用 key が全て存在 (ja/en、非空文字列)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      const radioKeys = [
        'payModeLabel',
        'payModeGaslessTitle',
        'payModeGaslessDesc',
        'payModeStandardTitle',
        'payModeStandardDesc',
      ];
      for (const key of radioKeys) {
        expectNonEmptyString(
          ja.QrGenerator[key as keyof typeof ja.QrGenerator],
          key,
          'ja.QrGenerator',
        );
        expectNonEmptyString(
          en.QrGenerator[key as keyof typeof en.QrGenerator],
          key,
          'en.QrGenerator',
        );
        expectNonEmptyString(
          ja.CheckoutLinkGenerator[
            key as keyof typeof ja.CheckoutLinkGenerator
          ],
          key,
          'ja.CheckoutLinkGenerator',
        );
        expectNonEmptyString(
          en.CheckoutLinkGenerator[
            key as keyof typeof en.CheckoutLinkGenerator
          ],
          key,
          'en.CheckoutLinkGenerator',
        );
      }
      // QrGenerator 固有
      expectNonEmptyString(ja.QrGenerator.standardHint, 'standardHint', 'ja.QrGenerator');
      expectNonEmptyString(en.QrGenerator.standardHint, 'standardHint', 'en.QrGenerator');
      // Phase 1 (alpha): OpenPay 利用手数料 0% 化に伴い、feeReceiverHint* /
      // eip681FeeBypass* / 料率 (0.5%, 1.0%) 文言の regression fence は撤去。
      // Phase 2 で課金復活時はこれらを再有効化する。
    });

    it('Phase 1: payModeStandardDesc / standardModeBody から 0.5% 文言が消えている', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.QrGenerator.payModeStandardDesc).not.toMatch(/0\.5%/);
      expect(en.QrGenerator.payModeStandardDesc).not.toMatch(/0\.5%/);
      expect(ja.PaymentForm.standardModeBody).not.toMatch(/0\.5%/);
      expect(en.PaymentForm.standardModeBody).not.toMatch(/0\.5%/);
    });

    it('Phase 1: payModeGaslessDesc から 1.0% 文言が消えている', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.QrGenerator.payModeGaslessDesc).not.toMatch(/1\.0%/);
      expect(en.QrGenerator.payModeGaslessDesc).not.toMatch(/1\.0%/);
      expect(ja.CheckoutLinkGenerator.payModeGaslessDesc).not.toMatch(/1\.0%/);
      expect(en.CheckoutLinkGenerator.payModeGaslessDesc).not.toMatch(/1\.0%/);
    });

    it('旧 directHint / directOption / directOptionDesc が ja/en の QrGenerator から削除されている', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      // 削除済 key は存在しない (型 cast でアクセス可能性をチェック)
      expect(
        (ja.QrGenerator as Record<string, unknown>).directHint,
      ).toBeUndefined();
      expect(
        (ja.QrGenerator as Record<string, unknown>).directOption,
      ).toBeUndefined();
      expect(
        (en.QrGenerator as Record<string, unknown>).directHint,
      ).toBeUndefined();
      expect(
        (en.QrGenerator as Record<string, unknown>).directOption,
      ).toBeUndefined();
    });

    it('旧 directWarningTitle / directWarningBody / directBatchHint / customerDirect が PaymentForm から削除されている', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      const removed = [
        'directWarningTitle',
        'directWarningBody',
        'directBatchHint',
        'customerDirect',
      ];
      for (const key of removed) {
        expect(
          (ja.PaymentForm as Record<string, unknown>)[key],
        ).toBeUndefined();
        expect(
          (en.PaymentForm as Record<string, unknown>)[key],
        ).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // C7: 賠償上限 (Terms 第9条) を lib/legal.ts の SoT に集約し、ja/en prose には
  // {amount} 補間で注入。両言語が同一定数由来となり乖離不能であることを担保。
  // -------------------------------------------------------------------------
  describe('regression: 賠償上限の SoT 化 (lib/legal.ts liabilityCapJpy)', () => {
    const expected = LEGAL_ENTITY.liabilityCapJpy.toLocaleString('en-US');

    it('ja Terms 第9条が liabilityCapJpy の整形値を表示', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      const body = screen.getByRole('heading', {
        level: 2,
        name: /第 9 条/,
      }).nextElementSibling;
      expect(body?.textContent).toContain(expected);
    });

    it('en Terms Article 9 が同一の整形値を表示 (ja と乖離しない)', () => {
      renderWithIntl(<TermsPage />, { locale: 'en' });
      const body = screen.getByRole('heading', {
        level: 2,
        name: /^Article 9 \(/,
      }).nextElementSibling;
      expect(body?.textContent).toContain(expected);
    });

    it('messages から旧ハードコード数値が消え {amount} 補間化されている (ja/en)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      // 旧固定文字列 "10,000" が prose に直書きされていないこと
      expect(ja.Terms.article9.body).not.toMatch(/10,000/);
      expect(en.Terms.article9.body).not.toMatch(/10,000/);
      // {amount} 補間が両言語に存在
      expect(ja.Terms.article9.body).toContain('{amount}');
      expect(en.Terms.article9.body).toContain('{amount}');
    });
  });

  // -------------------------------------------------------------------------
  // C8: 法務 prose (Terms art2(6)/art3/art5(2)・特商法) は「JPYC=sponsorship
  // (当社徴収) / USDC=erc20 (顧客が Paymaster に支払い)」をハードコードしている。
  // lib/tokens.ts の静的 paymasterMode マッピングが変わったら本テストが落ち、prose
  // の見直しを促す。
  //
  // ⚠️ スコープ: 法務文書は **mainnet 本番商用サービス**を記述対象とする (プロダクト
  // 判断)。本ガードは TOKEN_DEPLOYMENTS の静的 paymasterMode (mainnet/testnet で
  // 不変: usdc=erc20 / jpyc=sponsorship) を固定する。testnet では実行時に
  // resolvePaymasterMode が USDC erc20→sponsorship に倒すため挙動が異なるが、testnet
  // は非商用テスト環境 (AlphaNotice) であり法務文書の記述対象外。testnet の USDC
  // ガス代徴収挙動 (useGasQuote が sponsorship で発火) は本タスクとは別軸の
  // コード論点として別途扱う。
  // -------------------------------------------------------------------------
  describe('regression: token->paymasterMode 前提を tokens.ts に固定 (法務 prose ドリフトガード)', () => {
    it('per-deployment: merchant USDC は全て erc20 / JPYC は全て sponsorship / sponsorship は JPYC のみ', () => {
      // merchant vs buyer-only の分類は paymasterMode ではなく **独立ソース**
      // (lib/chains.ts USDC_CHAINS) から行う。paymasterMode で分類すると、merchant
      // USDC が誤って 'unavailable' に変わった場合にフィルタで除外され検知できない
      // (循環依存)。USDC_CHAINS は merchant 受信 chain の SoT。
      //
      // env-invariance note: paymasterMode は mainnet/testnet で同一 (usdc は常に
      // 'erc20'、jpyc は常に 'sponsorship'、buyer-only は常に 'unavailable' を
      // lib/tokens.ts がハードコード)。env で変わるのは address/chainId のみ。よって
      // 本テストが testnet env (vitest.config) で走っても mainnet の paymasterMode
      // マッピングを正しく検証する。実行時の resolvePaymasterMode による testnet
      // フォールバックは法務 scope 外 (mainnet 商用)。
      //
      // 受容する残リスク (判断: 文書化して受容): 本テストは testnet env で読み込んだ
      // 静的マッピングから mainnet を「推論」する。万一将来 usdcPaymasterModeFor 等を
      // env 依存 (例: isMainnet で分岐) に書き換えると、mainnet 限定のドリフトを本
      // テストは捕捉できない。mainnet env 再ロード test は lib/env.ts の mainnet ガード
      // (FEE_RECEIVER 等未設定で throw) を全スタブ要で脆いため不採用。paymasterMode を
      // env 依存化する変更を行う場合は、その PR で mainnet env 専用 test を追加すること。
      const merchantUsdcChainIds = new Set(
        USDC_CHAINS.map((slug) => chainForSlug(slug).id),
      );
      const usdc = TOKEN_DEPLOYMENTS.filter((d) => d.symbol === 'usdc');
      const merchantUsdc = usdc.filter((d) =>
        merchantUsdcChainIds.has(d.chainId),
      );
      const buyerOnlyUsdc = usdc.filter(
        (d) => !merchantUsdcChainIds.has(d.chainId),
      );
      const jpyc = TOKEN_DEPLOYMENTS.filter((d) => d.symbol === 'jpyc');

      // merchant 受信 USDC は全て erc20 (prose: 顧客が Paymaster に支払い・当社徴収なし)。
      // unavailable へ漂流したら独立分類で拾われ every(erc20) が落ちる。
      expect(merchantUsdc.length).toBe(USDC_CHAINS.length);
      expect(merchantUsdc.every((d) => d.paymasterMode === 'erc20')).toBe(true);
      // buyer-only USDC は gasless 非対応 (unavailable)、法務 prose 対象外。
      expect(buyerOnlyUsdc.every((d) => d.paymasterMode === 'unavailable')).toBe(
        true,
      );
      // JPYC は全て sponsorship (prose: 当社が肩代わり・JPYC で徴収)。
      expect(jpyc.length).toBeGreaterThan(0);
      expect(jpyc.every((d) => d.paymasterMode === 'sponsorship')).toBe(true);
      // 逆向き: sponsorship 経路は JPYC のみ (新 sponsorship トークン追加を検知)。
      expect(
        TOKEN_DEPLOYMENTS.filter(
          (d) => d.paymasterMode === 'sponsorship',
        ).every((d) => d.symbol === 'jpyc'),
      ).toBe(true);
    });

    it('USDC 非徴収 carve-out が同一節で USDC×ERC20 Paymaster×非徴収/非送金 を結びつけて art2/art3/art5/特商法 に存在', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;

      // art2(6) 定義: ERC20 Paymaster 経路が USDC と同一節 (句点区切り無し) で結びつく
      expect(ja.Terms.article2.body).toMatch(
        /ERC20 Paymaster[^。]*USDC|USDC[^。]*ERC20 Paymaster/,
      );
      expect(en.Terms.article2.body).toMatch(
        /ERC20 Paymaster \(e\.g\. USDC|ERC20 Paymaster for USDC/,
      );

      // art3 (本サービスの内容): USDC 経路は「当社指定ウォレットへの送金は生じない」
      // を同一節でバインド。
      expect(ja.Terms.article3.body).toMatch(
        /USDC の ERC20 Paymaster[^。]*送金は生じません/,
      );
      expect(en.Terms.article3.body).toMatch(
        /ERC20 Paymaster for USDC[^.]*no transfer is made/,
      );

      // art5(2) と特商法 additionalFees: 「USDC の ERC20 Paymaster …徴収しません」を
      // 同一節で明記 (別パスへの付け替え・carve-out 削除を検知)。en も同一節バインド。
      expect(ja.Terms.article5.body).toMatch(
        /USDC の ERC20 Paymaster[^。]*徴収しません/,
      );
      expect(ja.Tokutei.rows.additionalFees.value).toMatch(
        /USDC の ERC20 Paymaster[^。]*徴収しません/,
      );
      expect(en.Terms.article5.body).toMatch(
        /ERC20 Paymaster for USDC[^.]*does not collect/,
      );
      expect(en.Tokutei.rows.additionalFees.value).toMatch(
        /ERC20 Paymaster for USDC[^.]*does not collect/,
      );
    });
  });
});
