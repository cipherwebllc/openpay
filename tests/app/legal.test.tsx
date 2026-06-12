import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import TermsPage from '@/app/[locale]/terms/page';
import PrivacyPage from '@/app/[locale]/privacy/page';
import DisclaimerPage from '@/app/[locale]/disclaimer/page';
import TokuteiPage from '@/app/[locale]/tokutei/page';
import { LEGAL_ENTITY, DISCLOSED_RECOVER_FEE } from '@/lib/legal';
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

    // 外部レビュー対応: Cookie/localStorage 正確化 + 要配慮個人情報 非取得 +
    // プロファイリング非実施 (1節) + 安全管理措置 (新5節) + 番号繰下げ。
    it('ja: 1節に localStorage 実態・要配慮非取得・プロファイリング非実施がある', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const body = ja.Privacy.section1.body;
      expect(body).toContain('ローカルストレージ');
      // 「Cookie/localStorage を利用しません」という事実誤認を書いていないこと
      expect(body).not.toMatch(/ローカルストレージを利用しません/);
      expect(body).toContain('追跡または広告目的の Cookie を利用しません');
      expect(body).toContain('要配慮個人情報');
      expect(body).toContain('プロファイリング');
      // カメラ開示 (i18nKeys.test の法的要件) が維持されていること
      expect(body).toMatch(/カメラ/);
    });

    it('en: 1節に local storage / special-care info / profiling 文がある', async () => {
      const en = (await import('@/messages/en.json')).default;
      const body = en.Privacy.section1.body;
      expect(body).toMatch(/local storage/i);
      expect(body).toMatch(/tracking or advertising cookies/i);
      expect(body).toMatch(/special-care-required/i);
      expect(body).toMatch(/profiling/i);
    });

    it('安全管理措置の節 (sectionSecurity) が ja/en に存在し SSL/TLS を含む', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Privacy.sectionSecurity.title).toContain('安全管理措置');
      expect(ja.Privacy.sectionSecurity.body).toContain('SSL/TLS');
      expect(en.Privacy.sectionSecurity.title).toMatch(/Security Measures/i);
      expect(en.Privacy.sectionSecurity.body).toMatch(/SSL\/TLS/);
    });

    it('安全管理措置節 挿入で開示請求=6/問い合わせ=7/改定=8 に繰下げ済 (ja)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      expect(ja.Privacy.sectionSecurity.title).toMatch(/^5\./);
      expect(ja.Privacy.section5.title).toMatch(/^6\./);
      expect(ja.Privacy.section6.title).toMatch(/^7\./);
      expect(ja.Privacy.section7.title).toMatch(/^8\./);
      // section5 本文の相互参照 (お問い合わせ窓口) が renumber 後の「第7項」に追従
      // (旧「第6項」のまま残ると参照ずれ・Codex 指摘)
      expect(ja.Privacy.section5.body).toContain('第 7 項');
      expect(ja.Privacy.section5.body).not.toContain('第 6 項');
    });

    it('en: section5 本文の相互参照が Section 7 に追従 (Section 6 は残らない)', async () => {
      const en = (await import('@/messages/en.json')).default;
      expect(en.Privacy.section5.body).toMatch(/Section 7/);
      expect(en.Privacy.section5.body).not.toMatch(/Section 6/);
    });

    it('安全管理措置の節が実際に描画される (ja, 見出し「5.」)', () => {
      renderWithIntl(<PrivacyPage />, { locale: 'ja' });
      expect(
        screen.getByRole('heading', { level: 2, name: /個人情報の安全管理措置/ }),
      ).toBeInTheDocument();
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

    it('section 7 (OpenPay 利用料および gas 肩代わり) に per-tx 利用料 (約2 JPYC / 7月から1%・最低2 JPYC / 決済時に申し受け / 負担者は店主選択) の明示と、旧「全額負担・徴収しません」絶対主張の不在', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'ja' });
      const section7Heading = screen.getByRole('heading', {
        level: 2,
        name: /^7\./,
      });
      const body = section7Heading.nextElementSibling;
      expect(body?.textContent).toMatch(/OpenPay 利用料/);
      expect(body?.textContent).toMatch(/gas を肩代わり/);
      // per-tx 利用料: 決済 1 件ごと・当面 約 2 JPYC・2026年7月から決済額の1%・最低 2 JPYC・決済時に申し受け
      expect(body?.textContent).toMatch(/決済 1 件ごと/);
      expect(body?.textContent).toMatch(/約 2 JPYC/);
      expect(body?.textContent).toMatch(/2026 年 7 月/);
      expect(body?.textContent).toMatch(/1%/);
      expect(body?.textContent).toMatch(/最低 2 JPYC/);
      expect(body?.textContent).toMatch(/各決済の実行時/);
      // 確定モデル (2026-06-13): 決済は店舗 (店主) が利用料を負担し、お客様は表示額のみ。
      // 旧「店主が gasMode で負担者を選択」式は撤去 (固定化)。
      expect(body?.textContent).toMatch(/店舗 \(店主\) が負担|店舗が負担/);
      expect(body?.textContent).toMatch(/表示された決済額のみ|表示額のみ/);
      expect(body?.textContent).not.toMatch(/店主が選択/);
      // チップはガス相当額をお客様 (チッパー) 負担・1% 非適用。
      expect(body?.textContent).toMatch(/チップ/);
      expect(body?.textContent).toMatch(/1% は適用しません|1% は適用しない/);
      // gas の回収目的ではなく gas 額と非連動 (回収/立替フレーミングへの逆戻り検知)
      expect(body?.textContent).toMatch(/gas の回収を目的とするものではなく/);
      // 旧「無料化ピボット」の絶対主張 (JPYC gas を全額負担・徴収しません・月次後払い) は撤回済
      expect(body?.textContent).not.toMatch(/全額負担/);
      expect(body?.textContent).not.toMatch(/相当額を利用者から徴収しません/);
      expect(body?.textContent).not.toMatch(/後払い/);
      // 未払い相当時はガスレス中継のみ停止 (受け取り自体・通常決済は継続)
      expect(body?.textContent).toMatch(/申し受けられない/);
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
      // JPYC ガス無料化で「全額が」直接送金される旨を挿入したため、間に文字を許容。
      expect(main.textContent).toMatch(/店舗ウォレットへ[^。]*直接送金/);
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
      expect(section7.textContent).toMatch(/OpenPay Usage Fee|Gas Sponsorship/);
      expect(section8.textContent).toMatch(/Alpha/);
    });
  });

  describe('Tokutei (特商法表記)', () => {
    it('ja: h1 と必須 row (事業者 / 所在地 / 役務の対価 / 返品) が render される', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      expect(
        screen.getByRole('heading', { level: 1, name: '特定商取引法に基づく表記' }),
      ).toBeInTheDocument();
      // 主要 row label が出ている (役務提供のため「販売事業者」→「事業者（役務提供事業者）」)
      expect(screen.getByText('事業者（役務提供事業者）')).toBeInTheDocument();
      expect(screen.getByText('所在地')).toBeInTheDocument();
      expect(screen.getByText('電話番号')).toBeInTheDocument();
      expect(screen.getByText('役務の対価 (OpenPay 利用料)')).toBeInTheDocument();
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

    it('役務の対価: per-tx OpenPay 利用料 (約2 JPYC / 7月から決済額の1%・最低2 JPYC / JPYC ガスレス限定 / 6月まで無料0% / 負担者は店主選択)、旧 % 都度手数料 (1.0%/0.5%) と旧 最低 5 JPYC 文の不在 (regression guard)', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      // per-tx: OpenPay 利用料 (決済 1 件ごと・当面 約 2 JPYC・2026年7月から決済額の1%・最低 2 JPYC) を正面で assert
      expect(main.textContent).toMatch(/OpenPay 利用料/);
      expect(main.textContent).toMatch(/決済 1 件ごと/);
      expect(main.textContent).toMatch(/約 2 JPYC/);
      expect(main.textContent).toMatch(/1%/);
      expect(main.textContent).toMatch(/最低 2 JPYC/);
      expect(main.textContent).toMatch(/2026 年 7 月/);
      expect(main.textContent).toMatch(/0%/);
      // 各決済の実行時 (オンチェーン精算時) に同一取引内で申し受ける (per-tx・決済時)。月次後払い文言は撤回。
      expect(main.textContent).toMatch(/各決済の実行時/);
      expect(main.textContent).not.toMatch(/後払い/);
      // 確定モデル (2026-06-13): 決済は店舗が負担しお客様は表示額のみ (負担者トグルは撤去)。
      expect(main.textContent).toMatch(/店舗 \(店主\) が負担|店舗が負担/);
      expect(main.textContent).toMatch(/表示された決済額のみ|表示額のみ/);
      expect(main.textContent).not.toMatch(/店主が選択/);
      // 課金トリガー = JPYC ガスレスのみ。「対応トークン」(USDC を巻き込む) への逆戻りを検知。
      expect(main.textContent).toMatch(/JPYC のガスレス決済/);
      expect(main.textContent).not.toMatch(/ガスレス決済モードで受領した対応トークンの額/);
      // 旧 % 都度手数料 (1.0% / 0.5%) 表記は撤去済
      expect(main.textContent).not.toMatch(/1\.0%/);
      expect(main.textContent).not.toMatch(/0\.5%/);
      // 旧 MIN_FEE 文言 (最低 5 JPYC) の不在 (新文言は 最低 2 JPYC)
      expect(main.textContent).not.toMatch(/最低 5 JPYC/);
      expect(main.textContent).not.toMatch(/最低 0\.05 USDC/);
    });

    it('支払時期: 「直接送金」表現で merchant 売上を預からない設計を明示', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      // ノンカストディ設計の明文化 — 決済は顧客→店主へ直接送金 (預かり前提でない)。
      // JPYC ガス無料化で当社指定ウォレットへの送金は生じず、商品代金等は全額が
      // 店主の指定ウォレットへ直接届く。
      expect(main.textContent).toMatch(/店主の指定ウォレットへ直接送金/);
      // 「受領・保管・管理」と否定形「ものではありません」が同一文に並ぶことを要求。
      // 単語の存在だけ見ると「受領、保管、管理します」のような affirmation 改変で
      // CI が素通りするため、否定形までを regex に含めて意味反転を検出する。
      expect(main.textContent).toMatch(/受領.*保管.*管理.*ものではありません/);
      expect(main.textContent).not.toMatch(/取引金額から自動的に控除/);
    });

    it('JPYC per-tx 利用料化: 旧「gas 全額負担・相当額を徴収しません」絶対主張の不在 + gas 非連動の明示 (regression guard)', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      // 無料化ピボットの絶対主張は撤回済: JPYC gas を「全額負担」する旨、利用者から相当額を
      // 「徴収しません」とする旨は本文に現れない (USDC carve-out の「当社は徴収しません」は
      // 別系統で additionalFees 専用テストが担保)。
      expect(main.textContent).not.toMatch(/全額負担/);
      expect(main.textContent).not.toMatch(/相当額を利用者から徴収しません/);
      // per-tx 利用料の本質: gas の回収目的ではなく gas 額と非連動である旨を要求 (回収/立替への逆戻り検知)。
      expect(main.textContent).toMatch(/gas の回収を目的とするものではなく/);
      expect(main.textContent).toMatch(/gas 額とは連動しません/);
      // 旧「相当額を JPYC 等で徴収」(都度の gas 回収) 文言が復活していないこと。
      expect(main.textContent).not.toMatch(/相当額を JPYC 等で徴収/);
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
    it('ja Terms 第 5 条 (料金) は per-tx OpenPay 利用料 (約2 JPYC / 7月から1%・最低2 JPYC / 決済時 / 負担者は店主選択)、両モード記載 + 旧「全額負担・徴収しません」絶対主張の不在 (USDC carve-out は温存)', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      const article5 = screen.getByRole('heading', {
        level: 2,
        name: /第 5 条/,
      });
      const body = article5.nextElementSibling;
      expect(body?.textContent).toMatch(/ガスレス決済/);
      expect(body?.textContent).toMatch(/通常決済（ガスあり）/);
      // per-tx OpenPay 利用料: 決済 1 件ごと / 約 2 JPYC / 2026年7月から1%・最低 2 JPYC / 6月まで無料 (0%)
      expect(body?.textContent).toMatch(/OpenPay 利用料/);
      expect(body?.textContent).toMatch(/決済 1 件ごと/);
      expect(body?.textContent).toMatch(/約 2 JPYC/);
      expect(body?.textContent).toMatch(/1%/);
      expect(body?.textContent).toMatch(/最低 2 JPYC/);
      expect(body?.textContent).toMatch(/2026 年 7 月/);
      expect(body?.textContent).toMatch(/0%/);
      // per-tx・決済時に同一取引内で申し受ける。月次後払い文言は撤回。
      expect(body?.textContent).toMatch(/各決済の実行時/);
      expect(body?.textContent).not.toMatch(/後払い/);
      // 確定モデル (2026-06-13): 決済は店舗が利用料を負担しお客様は表示額のみ (負担者トグルは撤去)。
      expect(body?.textContent).toMatch(/店舗 \(店主\) が負担|店舗が負担/);
      expect(body?.textContent).toMatch(/表示された決済額のみ|表示額のみ/);
      expect(body?.textContent).not.toMatch(/店主が選択/);
      // 課金トリガー = JPYC ガスレスのみ (USDC を巻き込む「対応トークン」への逆戻りを検知)
      expect(body?.textContent).toMatch(/JPYC のガスレス決済/);
      // 旧 % 都度手数料は撤去
      expect(body?.textContent).not.toMatch(/1\.0%/);
      expect(body?.textContent).not.toMatch(/0\.5%/);
      // 無料化ピボットの絶対主張は撤回: JPYC gas「全額負担」「相当額を利用者から徴収しません」は消える。
      // ただし利用料は gas 回収目的でなく gas 額と非連動である旨は残す。
      expect(body?.textContent).not.toMatch(/全額負担/);
      expect(body?.textContent).not.toMatch(/相当額を利用者から徴収しません/);
      expect(body?.textContent).toMatch(/gas の回収を目的とするものではなく/);
      // USDC carve-out は温存: 「USDC の ERC20 Paymaster …当社は徴収しません」を同一節で要求。
      expect(body?.textContent).toMatch(/USDC の ERC20 Paymaster[^。]*徴収しません/);
      // 旧モデル (相当額を JPYC 等で回収/徴収します) も復活なし。
      expect(body?.textContent).not.toMatch(/顧客負担または店主負担/);
      expect(body?.textContent).not.toMatch(/相当額を JPYC 等で[^。]*徴収します/);
      expect(body?.textContent).not.toMatch(/回収として/);
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

    it('en Terms Article 5 は per-tx OpenPay usage fee (about 2 JPYC / 1% from July・min 2 JPYC / at settlement / payment borne by merchant・customer pays displayed amount only)、両モード記載で旧 % 手数料 + 旧 "bears in full / monthly arrears" 主張は不在 (USDC carve-out は温存)', () => {
      renderWithIntl(<TermsPage />, { locale: 'en' });
      const article5 = screen.getByRole('heading', {
        level: 2,
        name: /^Article 5 \(/,
      });
      const body = article5.nextElementSibling;
      expect(body?.textContent).toMatch(/Gasless Payment/);
      expect(body?.textContent).toMatch(/Standard Payment/);
      // per-tx OpenPay usage fee: about 2 JPYC / 1% from July / min 2 JPYC / June free (0%)
      expect(body?.textContent).toMatch(/OpenPay usage fee/);
      expect(body?.textContent).toMatch(/per-transaction/i);
      expect(body?.textContent).toMatch(/about 2 JPYC/i);
      expect(body?.textContent).toMatch(/1%/);
      expect(body?.textContent).toMatch(/minimum of 2 JPYC/i);
      expect(body?.textContent).toMatch(/July 2026/);
      // taken at settlement, not billed monthly in arrears (旧 monthly-arrears 文言の撤回を検知)
      expect(body?.textContent).toMatch(/at on-chain settlement/i);
      expect(body?.textContent).not.toMatch(/billed monthly rather than deducted/i);
      expect(body?.textContent).not.toMatch(/billed in arrears/i);
      // 確定モデル (2026-06-13): payments are borne by the Merchant; customer pays only the
      // displayed amount (the per-QR payer toggle is removed).
      expect(body?.textContent).toMatch(/borne by the Merchant/i);
      expect(body?.textContent).toMatch(/pays only the displayed/i);
      expect(body?.textContent).not.toMatch(/Merchant chooses who bears/i);
      // 課金トリガー = JPYC ガスレスのみ
      expect(body?.textContent).toMatch(/JPYC gasless/i);
      expect(body?.textContent).toMatch(/0%/);
      expect(body?.textContent).not.toMatch(/1\.0%/);
      expect(body?.textContent).not.toMatch(/0\.5%/);
      // 無料化ピボットの絶対主張は撤回: "bears that Network Fee in full" は JPYC について消える。
      // 利用料が gas 回収目的でない旨は残す。
      expect(body?.textContent).not.toMatch(/bears that Network Fee in full/);
      expect(body?.textContent).toMatch(/not for the purpose of recovering gas/i);
      // USDC carve-out は温存: "ERC20 Paymaster for USDC … does not collect" を同一節で要求。
      expect(body?.textContent).toMatch(/ERC20 Paymaster for USDC[^.]*does not collect/);
      expect(body?.textContent).not.toMatch(/collects an amount equivalent/i);
      expect(body?.textContent).not.toMatch(/as recovery of the advanced gas/i);
    });

    it('ja Tokutei 役務の対価 は OpenPay 利用料 1% (6月まで無料0%)、両モード記載で旧 % 都度手数料は不在', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      expect(main.textContent).toMatch(/OpenPay 利用料/);
      expect(main.textContent).toMatch(/1%/);
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

    it('用語統一: Terms 全条文で「運営手数料」「OpenPay 利用手数料」が消えている (= 「OpenPay 利用料」に統一)', () => {
      renderWithIntl(<TermsPage />, { locale: 'ja' });
      const main = screen.getByRole('main');
      expect(main.textContent).not.toMatch(/運営手数料/);
      // 旧称「OpenPay 利用手数料」は撤去済 (「OpenPay 利用料」へ統一)
      expect(main.textContent).not.toMatch(/OpenPay 利用手数料/);
      // 「OpenPay 利用料」が複数回出ている
      const matches = main.textContent?.match(/OpenPay 利用料/g);
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

    it('effectiveDate: 負担者固定化 (決済=店舗負担 / チップ=顧客ガス相当) の 3 文書 (Terms/Disclaimer/特商法) は 2026-06-13、Privacy は据置 2026-06-08', () => {
      // 2026-06-08: 外部レビュー精査に基づく開示拡充を 4 文書に反映。
      // 2026-06-09: OpenPay 利用料 (月額・ガスレス受領額1%・後払いの a1 モデル) の有料化開始を事前開示。
      // 2026-06-12: 無料化ピボットの絶対主張 (gas 全額負担・無徴収・100%着金) と a1 月次後払い
      //   モデルのいずれも JPYC ガスレスについて撤回し、決済 1 件ごとに決済時に申し受ける per-tx の
      //   OpenPay 利用料 (約 2 JPYC、2026年7月から決済額の1%・最低 2 JPYC) へ改定。
      // 2026-06-13: per-tx 利用料の負担者を固定化 — 決済 (/pay・/checkout・レジ) は店舗が手数料を
      //   常に負担しお客様は表示額のみ (per-QR トグル撤去)、チップ (/tip・@handle) はガス相当額
      //   (約 2 JPYC・1% 非適用) をチッパーが負担。料金性質に直接関わる Terms/Disclaimer/特商法 を
      //   改定 (実質的改定のため施行日/最終更新日を更新)。Privacy は料金モデルに直接言及しないため据置。
      expect(LEGAL_ENTITY.termsEffectiveDate).toBe('2026-06-13');
      expect(LEGAL_ENTITY.tokuteiEffectiveDate).toBe('2026-06-13');
      expect(LEGAL_ENTITY.disclaimerEffectiveDate).toBe('2026-06-13');
      expect(LEGAL_ENTITY.privacyEffectiveDate).toBe('2026-06-08');
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
  // 外部レビュー対応: (A) 行為能力・未成年者条項 (4条) と (B) 違反時の利用制限・
  // 提供停止条項 (7条) を追加。(B) は非カストディ前提を崩さないよう「ウォレット/
  // 資産にはアクセス・凍結できない」を明記する。文言が将来落ちないよう fence。
  // -------------------------------------------------------------------------
  describe('regression: 行為能力/未成年 (4条) + 利用制限/提供停止 (7条)', () => {
    it('ja: 4条に行為能力・未成年者の法定代理人同意がある', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const body = ja.Terms.article4.body;
      expect(body).toContain('行為能力');
      expect(body).toContain('未成年者');
      expect(body).toContain('法定代理人');
    });

    it('en: 4条に capacity / minor / legal representative がある', async () => {
      const en = (await import('@/messages/en.json')).default;
      const body = en.Terms.article4.body;
      expect(body).toMatch(/capacity/i);
      expect(body).toMatch(/minor/i);
      expect(body).toMatch(/legal representative/i);
    });

    it('ja: 7条に利用制限・提供停止 + 非カストディ (凍結不能) がある', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const body = ja.Terms.article7.body;
      expect(body).toContain('提供を停止');
      expect(body).toContain('ノンカストディアル');
      expect(body).toContain('凍結');
    });

    it('en: 7条に suspend + non-custodial (cannot freeze) がある', async () => {
      const en = (await import('@/messages/en.json')).default;
      const body = en.Terms.article7.body;
      expect(body).toMatch(/suspend/i);
      expect(body).toMatch(/non-custodial/i);
      expect(body).toMatch(/freeze/i);
    });
  });

  // -------------------------------------------------------------------------
  // C8: 法務 prose (Terms art2(6)/art3/art5(2)・特商法) は「JPYC=sponsorship
  // (当社がガスを肩代わり・無徴収) / USDC=erc20 (顧客が Paymaster に支払い)」を
  // ハードコードしている (paymasterMode は徴収有無ではなく paymaster 種別を表す)。
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
      // JPYC は全て sponsorship (prose: 当社がガスを肩代わり・無徴収)。
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

  // 外部レビュー対応: 免責事項に脱ペッグ明記 (section3) と SC 脆弱性免責 (section1)。
  describe('regression: 免責事項 脱ペッグ + SC脆弱性免責 (外部レビュー対応)', () => {
    it('脱ペッグ明記が ja/en の Disclaimer section3 にある', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Disclaimer.section3.body).toContain('脱ペッグ');
      expect(en.Disclaimer.section3.body).toMatch(/de-peg/i);
    });

    it('スマートコントラクト脆弱性免責が ja/en の Disclaimer section1 にある', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Disclaimer.section1.body).toContain('スマートコントラクト');
      expect(ja.Disclaimer.section1.body).toContain('脆弱性');
      expect(en.Disclaimer.section1.body).toMatch(/smart contract/i);
      expect(en.Disclaimer.section1.body).toMatch(/vulnerabilit/i);
    });
  });

  // 外部レビュー対応: 特商法 支払方法 wallet-only 明確化 + 事業者種精緻化 + 保証なし明記。
  describe('regression: 特商法 支払方法/事業者種/保証 (外部レビュー対応)', () => {
    it('事業者種が役務提供事業者に精緻化 (ja/en)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Tokutei.rows.seller.label).toContain('役務提供事業者');
      expect(en.Tokutei.rows.seller.label).toMatch(/Service Provider/i);
    });

    it('支払方法 wallet-only (カード/振込/現金 非対応) が ja/en に明記', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Tokutei.rows.paymentTiming.value).toContain('オンチェーン送金のみ');
      expect(ja.Tokutei.rows.paymentTiming.value).toContain('クレジットカード');
      expect(en.Tokutei.rows.paymentTiming.value).toMatch(/credit cards/i);
      expect(en.Tokutei.rows.paymentTiming.value).toMatch(/not supported/i);
    });

    it('返品欄に「特別な保証なし (現状有姿)」が ja/en に明記', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Tokutei.rows.returnPolicy.value).toContain('特別な保証');
      expect(en.Tokutei.rows.returnPolicy.value).toMatch(/special warranty/i);
    });

    it('商品紛争は店主↔顧客で解決・当社は非当事者 (ja/en)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Tokutei.rows.returnPolicy.value).toContain('店主と顧客の間で直接解決');
      expect(ja.Tokutei.rows.returnPolicy.value).toContain('当事者ではなく');
      expect(en.Tokutei.rows.returnPolicy.value).toMatch(/between the merchant and the customer/i);
      expect(en.Tokutei.rows.returnPolicy.value).toMatch(/not a party/i);
    });
  });

  // 外部レビュー対応: 9条(2) 賠償上限を取引金額連動に + 9条(3) ガスレス一時停止/遅延の免責。
  describe('regression: 利用規約 9条 賠償上限/ガスレス免責 (外部レビュー対応)', () => {
    it('9条(2): 賠償上限が取引金額連動 (最も高い額) に (ja/en)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Terms.article9.body).toContain('取引金額');
      expect(ja.Terms.article9.body).toContain('最も高い額');
      // {amount} の floor は維持
      expect(ja.Terms.article9.body).toContain('{amount}');
      expect(en.Terms.article9.body).toMatch(/transaction amount of the specific payment/i);
      expect(en.Terms.article9.body).toMatch(/greatest of/i);
    });

    it('9条(3): ガスレス決済機能の一時停止/遅延の免責が明示 (ja/en)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Terms.article9.body).toContain('ガスレス決済機能の一時的な停止');
      expect(en.Terms.article9.body).toMatch(/gasless payment functionality/i);
    });
  });

  // 外部レビュー対応 (Privacy/免責 第2巡): localStorage 削除導線・Sentry 漏洩時措置・
  // SC アップグレード/移行免責・免責と規約の相互補完。
  describe('regression: Privacy(localStorage削除/Sentry) + 免責(SC移行/相互補完)', () => {
    it('P4: localStorage 削除コントロールが ja/en の Privacy section1 に', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Privacy.section1.body).toContain('任意に削除');
      expect(en.Privacy.section1.body).toMatch(/delete this client-side data/i);
    });

    it('P3: Sentry 漏洩時の削除/マスクが ja/en の Privacy section2 に', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Privacy.section2.body).toContain('マスク');
      expect(en.Privacy.section2.body).toMatch(/deletion or masking/i);
    });

    it('D3: SC アップグレード/移行免責が ja/en の Disclaimer section1 に', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Disclaimer.section1.body).toContain('移行');
      expect(ja.Disclaimer.section1.body).toContain('切替え');
      expect(en.Disclaimer.section1.body).toMatch(/migrate/i);
      expect(en.Disclaimer.section1.body).toMatch(/switchover/i);
    });

    it('D1: 免責と利用規約は相互補完 (旧「利用規約が優先」を撤去)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const en = (await import('@/messages/en.json')).default;
      expect(ja.Disclaimer.legalNote).toContain('相互に補完');
      expect(ja.Disclaimer.legalNote).not.toContain('利用規約が優先');
      expect(en.Disclaimer.legalNote).toMatch(/complement each other/i);
    });
  });

  // L4: 法務開示 ↔ env のフェンス。文書本文に書かれた数値 (約 2 JPYC / 1% / 最低 2 JPYC) と
  // lib/legal.ts の DISCLOSED_RECOVER_FEE 定数を結びつけ、片側だけの変更で fail させる。
  // また実装の既定 (relayGasFeeValue() / recoverFeeBps()) を開示済み数値にピン留めする。
  describe('L4: per-tx 利用料の開示数値 ↔ 定数/実装デフォルトのフェンス', () => {
    // 定数から導いた表示文字列。文書本文がこれを含むことを assert する (定数だけ・本文だけの
    // 片側変更が fail する)。floorJpyc=2 → "2 JPYC" / percentFromJulyBps=100 → "1%"。
    const floorJpyc = DISCLOSED_RECOVER_FEE.floorJpyc; // 2
    const percentFromJuly = DISCLOSED_RECOVER_FEE.percentFromJulyBps / 100; // 1 (%)

    it('Tokutei (役務の対価) の描画本文が定数由来の数値 (約 2 JPYC / 最低 2 JPYC / 1%) を含む', () => {
      renderWithIntl(<TokuteiPage />, { locale: 'ja' });
      const text = screen.getByRole('main').textContent ?? '';
      expect(text).toContain(`約 ${floorJpyc} JPYC`);
      expect(text).toContain(`最低 ${floorJpyc} JPYC`);
      expect(text).toContain(`${percentFromJuly}%`);
    });

    it('Disclaimer (§7 OpenPay 利用料) の描画本文が定数由来の数値を含む', () => {
      renderWithIntl(<DisclaimerPage />, { locale: 'ja' });
      const section7 = screen.getByRole('heading', { level: 2, name: /^7\./ });
      const body = section7.nextElementSibling?.textContent ?? '';
      expect(body).toContain(`約 ${floorJpyc} JPYC`);
      expect(body).toContain(`最低 ${floorJpyc} JPYC`);
      expect(body).toContain(`${percentFromJuly}%`);
    });

    it('Terms (第5条 料金) のメッセージ本文が定数由来の数値を含む (ja)', async () => {
      const ja = (await import('@/messages/ja.json')).default;
      const body = ja.Terms.article5.body;
      expect(body).toContain(`約 ${floorJpyc} JPYC`);
      expect(body).toContain(`最低 ${floorJpyc} JPYC`);
      expect(body).toContain(`${percentFromJuly}%`);
    });

    // code-default consistency: relayGasFeeValue() を env 未設定 (clean) で評価し、
    // 開示済みフロア (floorJpyc × 10^18) と一致することをピン留めする。env をクリーンにするため
    // NEXT_PUBLIC_RELAY_GAS_FEE_JPYC を undefined に stub し resetModules で再 import する。
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('relayGasFeeValue() の既定 (env 未設定) === BigInt(DISCLOSED_RECOVER_FEE.floorJpyc) * 10^18', async () => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', '');
      const { relayGasFeeValue } = await import('@/lib/relay/forwarderConfig');
      expect(relayGasFeeValue()).toBe(
        BigInt(DISCLOSED_RECOVER_FEE.floorJpyc) * 10n ** 18n,
      );
    });

    it('recoverFeeBps() の既定 (env 未設定) === 0 (= 7 月前の無徴収相当・開示済み許可値)', async () => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_RECOVER_FEE_BPS', '');
      const { recoverFeeBps } = await import('@/lib/relay/recoverFee');
      expect(recoverFeeBps()).toBe(0);
    });

    // feeDisclosureDivergence(): live env が開示済み数値と (日付対応で) 一致なら null、乖離なら
    // 非 null 理由文字列。CDX-4b: 開示は「当面フロアのみ (bps=0)、2026 年 7 月のご利用分から 1%」。
    // 期待 bps は現在日付で一意に決まる: 7 月前は 0、7 月以降は percentFromJulyBps(=100)。
    const JUNE = new Date('2026-06-20T00:00:00Z'); // 7 月前
    const JULY = new Date('2026-07-05T00:00:00Z'); // 7 月以降

    it('CDX-4b: 6 月・bps=0 → 乖離なし (null)', async () => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', '');
      vi.stubEnv('NEXT_PUBLIC_RECOVER_FEE_BPS', '');
      const { feeDisclosureDivergence } = await import('@/lib/legal');
      expect(feeDisclosureDivergence(JUNE)).toBeNull();
    });

    it('CDX-4b: 6 月・bps=100 (早期設定) → 乖離を検出 (非 null・理由に bps)', async () => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', '');
      vi.stubEnv(
        'NEXT_PUBLIC_RECOVER_FEE_BPS',
        String(DISCLOSED_RECOVER_FEE.percentFromJulyBps),
      );
      const { feeDisclosureDivergence } = await import('@/lib/legal');
      const d = feeDisclosureDivergence(JUNE);
      expect(d).not.toBeNull();
      expect(d).toMatch(/recoverFeeBps/);
    });

    it('CDX-4b: 7 月・bps=0 (反映漏れ) → 乖離を検出 (非 null・理由に bps)', async () => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', '');
      vi.stubEnv('NEXT_PUBLIC_RECOVER_FEE_BPS', '');
      const { feeDisclosureDivergence } = await import('@/lib/legal');
      const d = feeDisclosureDivergence(JULY);
      expect(d).not.toBeNull();
      expect(d).toMatch(/recoverFeeBps/);
    });

    it('CDX-4b: 7 月・bps=100 → 乖離なし (null)', async () => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', '');
      vi.stubEnv(
        'NEXT_PUBLIC_RECOVER_FEE_BPS',
        String(DISCLOSED_RECOVER_FEE.percentFromJulyBps),
      );
      const { feeDisclosureDivergence } = await import('@/lib/legal');
      expect(feeDisclosureDivergence(JULY)).toBeNull();
    });

    it('feeDisclosureDivergence: floor を開示と違う額にすると乖離を検出 (非 null・理由に floor)', async () => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', '5'); // 開示は 2
      vi.stubEnv('NEXT_PUBLIC_RECOVER_FEE_BPS', '');
      const { feeDisclosureDivergence } = await import('@/lib/legal');
      const d = feeDisclosureDivergence(JUNE);
      expect(d).not.toBeNull();
      expect(d).toMatch(/relayGasFeeValue/);
    });

    it('feeDisclosureDivergence: bps を開示外の率 (例 50) にすると乖離を検出 (非 null・理由に bps)', async () => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', '');
      vi.stubEnv('NEXT_PUBLIC_RECOVER_FEE_BPS', '50'); // 6 月の期待は 0
      const { feeDisclosureDivergence } = await import('@/lib/legal');
      const d = feeDisclosureDivergence(JUNE);
      expect(d).not.toBeNull();
      expect(d).toMatch(/recoverFeeBps/);
    });
  });
});
