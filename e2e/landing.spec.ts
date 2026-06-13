import { test, expect } from '@playwright/test';

test.describe('landing / (LP)', () => {
  // Phase 1: LP は Hero 2 CTA + WIP プレースホルダの骨格。Phase 2 で features /
  // FAQ を加える際に本 spec を拡張する。
  test('ja: Hero に 2 大 CTA (📱 支払う / 🏪 受け取る) と AppShell が描画される', async ({
    page,
  }) => {
    await page.goto('/ja');

    // AppHeader: logo は alt='OpenPay' の h1
    await expect(page.getByRole('heading', { name: 'OpenPay' }).first()).toBeVisible();

    // Hero leadline (h2) — 「JPYC / USDC QR決済」体言止め
    await expect(
      page.getByRole('heading', { name: /JPYC \/ USDC QR決済/ }),
    ).toBeVisible();

    // 2 大 CTA
    const scanCta = page.getByRole('link', { name: /📱 支払う/ });
    const createCta = page.getByRole('link', { name: /🏪 受け取る/ });
    await expect(scanCta).toBeVisible();
    await expect(createCta).toBeVisible();
    await expect(scanCta).toHaveAttribute('href', '/ja/scan');
    await expect(createCta).toHaveAttribute('href', '/ja/create');
  });

  test('en: Hero の 2 CTA は英語表記で描画される', async ({ page }) => {
    await page.goto('/en');
    await expect(page.getByRole('link', { name: /Pay \(Scan\)/ })).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Receive \(Create payment QR\)/ }),
    ).toBeVisible();
  });

  test('mobile: BottomNav に 4 link (ホーム/受け取る/履歴/探す) が出る', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile-safari',
      'BottomNav は md 未満専用',
    );
    await page.goto('/ja');
    const bottomNav = page.getByRole('navigation', { name: 'bottom navigation' });
    await expect(bottomNav).toBeVisible();
    // ホームへの戻りは AppHeader 左上のロゴクリックに集約。Nav 1 slot 目は「スキャン」。
    await expect(bottomNav.getByRole('link', { name: /スキャン/ })).toBeVisible();
    // Nav の受取導線ラベルは「受取る」(Nav.create)。
    await expect(bottomNav.getByRole('link', { name: /受取る/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /履歴/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /探す/ })).toBeVisible();
  });

  test('ja: Features セクションに 3 カード (ガスレス/マルチチェーン/ノンカストディ) が出る', async ({
    page,
  }) => {
    await page.goto('/ja');
    await expect(page.getByRole('heading', { name: 'OpenPay の特長' })).toBeVisible();
    // ガスレス特長カードの見出しは「ガス代不要」(featuresGaslessTitle)。
    await expect(page.getByRole('heading', { name: 'ガス代不要' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'マルチチェーン対応' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'ノンカストディ設計' }),
    ).toBeVisible();
  });

  test('ja: HowItWorks セクションに merchant + customer の 3-step が出る', async ({
    page,
  }) => {
    await page.goto('/ja');
    const howItWorks = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '使い方' }) });
    await expect(howItWorks).toBeVisible();
    // merchant 3 step
    await expect(howItWorks.getByText('受取ウォレットアドレスを入力')).toBeVisible();
    // step3: 印刷 or スマホ提示 の両パターン
    await expect(
      howItWorks.getByText(/QR を印刷.*スマホ.*タブレット/),
    ).toBeVisible();
    // customer 3 step
    await expect(
      howItWorks.getByText('右上の「接続」からウォレットを接続'),
    ).toBeVisible();
    // step 2: 「スキャン」テキストリンクが /scan を指す (HowItWorks 内に scope して
    // TopNav / Hero CTA の同名 link との strict mode 衝突を回避)
    const scanLink = howItWorks.getByRole('link', { name: 'スキャン', exact: true });
    await expect(scanLink).toHaveAttribute('href', '/ja/scan');
    await expect(howItWorks.getByText('ウォレットで署名 → 完了')).toBeVisible();
  });

  test('ja: FAQ-A4 は JPYC EX (jpyc.co.jp) と 受け取る (/create) のテキストリンクを含む', async ({
    page,
  }) => {
    await page.goto('/ja');
    // FAQ-Q4 を展開し、対象 <details> 要素内で link を解決する (TopNav の同名 link
    // との strict mode 衝突回避)。details は親 <li> 経由で locator を組む。
    const q4Summary = page.getByText(
      '受け取った JPYC / USDC を日本円に換金するには?',
    );
    const faqDetails = page
      .locator('details')
      .filter({ has: q4Summary });
    await q4Summary.click();
    await expect(faqDetails).toHaveAttribute('open', '');

    const jpycEx = faqDetails.getByRole('link', { name: 'JPYC EX' });
    await expect(jpycEx).toBeVisible();
    await expect(jpycEx).toHaveAttribute('href', 'https://jpyc.co.jp/');
    await expect(jpycEx).toHaveAttribute('target', '_blank');
    await expect(jpycEx).toHaveAttribute('rel', 'noopener noreferrer');

    const createLink = faqDetails.getByRole('link', {
      name: '受け取る',
      exact: true,
    });
    await expect(createLink).toHaveAttribute('href', '/ja/create');
  });

  test('ja: FAQ は <details> で default closed、click で展開される', async ({
    page,
  }) => {
    await page.goto('/ja');
    await expect(page.getByRole('heading', { name: 'よくある質問' })).toBeVisible();
    const q1 = page.getByText('本当にガス代は不要ですか?');
    await expect(q1).toBeVisible();
    // closed 状態では answer は hidden。faqA1 の本文 (回答) に固有の一節で照合する
    // (質問文ではなく回答 body であることを担保)。
    const a1Body = page.getByText(/JPYC または USDC の残高だけで支払いを完結/);
    await expect(a1Body).toBeHidden();
    // 展開
    await q1.click();
    await expect(a1Body).toBeVisible();
  });

  test('ja: Benefits セクション — Fee「1%」(7 月〜) + 4 focal + 店舗 3 / 顧客 1', async ({
    page,
  }) => {
    await page.goto('/ja');
    // recover 課金ピボット (2026-06-12): Fee カードは「利用料 1%（7 月〜）」訴求に再構成
    // (旧「永久 0% / 決済手数料ゼロ」から変更)。Cost / Settlement / NoSignup と合わせ 4 cards。
    const benefits = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '導入メリット' }) });
    await expect(benefits).toBeVisible();
    // 4 focal text (ビッグナンバー) — Benefits section 内に scope (benefitsFeeFocal="1%")
    await expect(benefits.getByText('1%', { exact: true })).toBeVisible();
    await expect(benefits.getByText('¥0', { exact: true })).toBeVisible();
    await expect(benefits.getByText('数秒', { exact: true })).toBeVisible();
    expect(await benefits.getByText('登録不要').count()).toBeGreaterThanOrEqual(1);
    // 旧 % 訴求「0.5%」と旧「0%」永続コミット文脈は撤去済 (regression fence)
    expect(await benefits.getByText('0.5%', { exact: true }).count()).toBe(0);
    expect(await benefits.getByText('0%', { exact: true }).count()).toBe(0);
    // 4 title (新 Fee カードは title=「利用料 1%（7 月〜）」、旧「決済手数料ゼロ/手数料が安い」は消えている)
    await expect(
      benefits.getByRole('heading', { name: '利用料 1%（7 月〜）' }),
    ).toBeVisible();
    await expect(
      benefits.getByRole('heading', { name: '導入コスト 0 円' }),
    ).toBeVisible();
    await expect(
      benefits.getByRole('heading', { name: '即時着金' }),
    ).toBeVisible();
    await expect(
      benefits.getByRole('heading', { name: '会員登録不要' }),
    ).toBeVisible();
    expect(
      await benefits.getByRole('heading', { name: '手数料が安い' }).count(),
    ).toBe(0);
    expect(
      await benefits.getByRole('heading', { name: '決済手数料ゼロ' }).count(),
    ).toBe(0);
    // audience pill: 店舗 3 / 顧客 1 — 4 cards
    expect(await benefits.getByText('店舗', { exact: true }).count()).toBe(3);
    expect(await benefits.getByText('顧客', { exact: true }).count()).toBe(1);
  });

  test('ja: Trust セクションに GitHub link (target=_blank + rel=noopener)', async ({
    page,
  }) => {
    await page.goto('/ja');
    // SiteFooter にも同名 GitHub link があるため、Trust section (= LP <main> 内) に
    // scope する。LandingTrust の link は icon + label + ↗ で SVG inline を含む。
    const trust = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'オープン技術と透明性' }) });
    await expect(trust).toBeVisible();
    const github = trust.getByRole('link', {
      name: /ソースコード \(GitHub\)/,
    });
    await expect(github).toBeVisible();
    await expect(github).toHaveAttribute(
      'href',
      'https://github.com/cipherwebllc/openpay',
    );
    await expect(github).toHaveAttribute('target', '_blank');
    await expect(github).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('ja: OpenPay 利用料 セクション — 説明 + Tip 応援 link button 5 つ (JPYC Polygon/Kaia/USDC + POL/KAIA)', async ({
    page,
  }) => {
    await page.goto('/ja');
    const support = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'OpenPay 利用料について' }) });
    await expect(support).toBeVisible();
    // 利用料ポリシーの説明 (recover ピボット後: JPYC ガスレスは利用料あり / 通常決済・顧客 gas 負担の
    // USDC は対象外=無料) + Tip 依頼文。
    await expect(
      support.getByText(
        /通常決済（ガスあり）および顧客が自らガスを負担する USDC 経路は対象外/,
      ),
    ).toBeVisible();
    await expect(support.getByText(/Tip を頂けると幸いです/)).toBeVisible();
    // 応援 link button 5 つ (新規タブで本番 /tip を開く): JPYC Polygon/Kaia, USDC cross-chain,
    // および native POL / KAIA。
    const tipLinks = support.getByRole('link', { name: /で応援$/ });
    await expect(tipLinks).toHaveCount(5);
    // 先頭ボタン (JPYC Polygon) の href / target / rel
    const first = support.getByRole('link', { name: 'JPYC (Polygon) で応援' });
    await expect(first).toHaveAttribute(
      'href',
      /open-pay\.jp\/tip\/0x428483FbA62eDCef1E3a100d3799F6d71759c560\?token=jpyc/,
    );
    await expect(first).toHaveAttribute('target', '_blank');
    await expect(first).toHaveAttribute('rel', 'noopener noreferrer');
    // 3 種の token/chain を網羅
    await expect(
      support.getByRole('link', { name: 'JPYC (Kaia) で応援' }),
    ).toHaveAttribute('href', /token=jpyc&chain=kaia/);
    await expect(
      support.getByRole('link', { name: 'USDC (cross-chain) で応援' }),
    ).toHaveAttribute('href', /token=usdc/);
  });
});
