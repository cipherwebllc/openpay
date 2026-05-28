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
    await expect(bottomNav.getByRole('link', { name: /受け取る/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /履歴/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /探す/ })).toBeVisible();
  });

  test('ja: Features セクションに 3 カード (ガスレス/マルチチェーン/ノンカストディ) が出る', async ({
    page,
  }) => {
    await page.goto('/ja');
    await expect(page.getByRole('heading', { name: 'OpenPay の特長' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ガスレス決済' })).toBeVisible();
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
    // closed 状態では answer は hidden
    const a1Body = page.getByText(/Pimlico paymaster 経由で立て替え/);
    await expect(a1Body).toBeHidden();
    // 展開
    await q1.click();
    await expect(a1Body).toBeVisible();
  });

  test('ja: Benefits セクション (Phase 1) — 3 focal text + 「店舗」2 / 「顧客」1 pill', async ({
    page,
  }) => {
    await page.goto('/ja');
    // Phase 1: Fee カード (focal=0.5%) は削除、Cost / Settlement / NoSignup の 3 cards に縮小。
    // Benefits section に scope して他セクションとの衝突を回避。
    const benefits = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '導入メリット' }) });
    await expect(benefits).toBeVisible();
    // 3 focal text
    await expect(benefits.getByText('¥0', { exact: true })).toBeVisible();
    await expect(benefits.getByText('数秒', { exact: true })).toBeVisible();
    expect(await benefits.getByText('登録不要').count()).toBeGreaterThanOrEqual(1);
    // Fee focal「0.5%」が消えている (Phase 1 fence)
    expect(await benefits.getByText('0.5%', { exact: true }).count()).toBe(0);
    // 3 title
    await expect(
      benefits.getByRole('heading', { name: '導入コスト 0 円' }),
    ).toBeVisible();
    await expect(
      benefits.getByRole('heading', { name: '即時着金' }),
    ).toBeVisible();
    await expect(
      benefits.getByRole('heading', { name: '会員登録不要' }),
    ).toBeVisible();
    // 旧 Fee カード title「手数料が安い」が消えている
    expect(
      await benefits.getByRole('heading', { name: '手数料が安い' }).count(),
    ).toBe(0);
    // audience pill: 店舗 2 / 顧客 1 — Phase 1 で 4→3 cards に縮小
    expect(await benefits.getByText('店舗', { exact: true }).count()).toBe(2);
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
});
