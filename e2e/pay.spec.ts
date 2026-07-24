import { test, expect } from '@playwright/test';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

test.describe('/pay (URL parser smoke)', () => {
  test('正しい URL → 決済画面が出てウォレット接続を促す', async ({ page }) => {
    await page.goto(`/ja/pay?to=${TO}&token=usdc&amount=10`);
    await expect(page.getByText('OpenPay 決済')).toBeVisible();
    // i18n string check (ja header)
    await expect(page.getByText('Base Sepolia')).toBeVisible();
    // ヘッダの大文字金額表示
    await expect(page.getByText('10 USDC').first()).toBeVisible();
    // 接続ボタンは押せる (未接続時はウォレット選択へスクロール誘導・#267)。
    // btnConnect は短縮済み (旧「ウォレットを接続してください」→「ウォレットを接続」)。
    const submit = page.getByRole('button', {
      name: /ウォレットを接続/,
    });
    await expect(submit).toBeEnabled();
    // タップでウォレット選択セクション (ConnectButton) が viewport に入る。
    await submit.click();
    await expect(page.getByText('ウォレット', { exact: true })).toBeInViewport();
  });

  test('to 欠落 → エラー表示', async ({ page }) => {
    await page.goto('/ja/pay?token=usdc');
    await expect(page.getByText(/決済 URL が不正/)).toBeVisible();
  });

  test('mode=standard → 通常決済（ガスあり）バッジが表示される (Phase 1: fee=0)', async ({ page }) => {
    // 日本語アサーションのため locale を明示。/pay へ素で行くと middleware が
    // Accept-Language (Playwright 既定 en-US) で /en/pay へ redirect する。
    await page.goto(
      `/ja/pay?to=${TO}&token=usdc&amount=10&mode=standard`,
    );
    // amber バナータイトル + breakdown hint で複数箇所
    await expect(
      page.getByText('通常決済（ガスあり）').first(),
    ).toBeVisible();
    // 「ネットワーク手数料: ウォレットで支払い」明細 (standard mode は顧客が wallet で
    // ガスを別途負担する旨。文言は gasRowStandardValue = 「ウォレットで支払い」に短縮済み)。
    await expect(page.getByText(/ウォレットで支払い/)).toBeVisible();
    // Phase 1: fee=0 のため breakdown の「店主受取」行が請求額そのまま (10 USDC)。
    // ヘッダーの金額表示と区別するため店主受取行 (Row の div) に scope する。
    const merchantRow = page
      .locator('div.justify-between')
      .filter({ has: page.getByText('店主受取', { exact: true }) });
    await expect(merchantRow).toContainText('10 USDC');
    // 旧 fee 行 (0.5%=0.05 USDC) と fee 控除後 merchant 値 (9.95 USDC) は出ない
    expect(await page.getByText('0.05 USDC').count()).toBe(0);
    expect(await page.getByText('9.95 USDC').count()).toBe(0);
  });

  test('legacy alias: mode=direct (旧 URL) → mode=standard と同じ UI に正規化される', async ({
    page,
  }) => {
    // 既発行 QR との互換性保証 (parser で direct → standard alias)
    await page.goto(
      `/ja/pay?to=${TO}&token=usdc&amount=10&mode=direct`,
    );
    await expect(
      page.getByText('通常決済（ガスあり）').first(),
    ).toBeVisible();
    // Phase 1: fee=0 のため店主受取行 = 10 USDC、fee 控除後の旧値 9.95 は出ない
    const merchantRow = page
      .locator('div.justify-between')
      .filter({ has: page.getByText('店主受取', { exact: true }) });
    await expect(merchantRow).toContainText('10 USDC');
    expect(await page.getByText('9.95 USDC').count()).toBe(0);
  });

  test('mobile (iPhone 14 / 390px) header で switcher + env badge + back-link が overflow しない', async ({
    page,
  }, testInfo) => {
    // /pay header は back-link + LocaleSwitcher + env badge を flex justify-between で並べる。
    // 狭い viewport で wrap / overflow が起きないことを担保。
    test.skip(testInfo.project.name !== 'mobile-safari', 'mobile viewport 専用');
    await page.goto(`/ja/pay?to=${TO}&token=usdc&amount=10`);
    // back-link は exact match ("← OpenPay")。footer の X link
    // (aria-label "OpenPay の X (旧 Twitter)") と strict mode 衝突する regex /OpenPay/
    // を避ける (X link 追加 commit 9c21ef5 以降の regression)。
    await expect(page.getByRole('link', { name: '← OpenPay' })).toBeVisible();
    await expect(page.getByRole('button', { name: /日本語/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /English/ })).toBeVisible();
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test('mode=gasless (default) → ネットワーク手数料見積行が出る (Phase 1: fee=0)', async ({
    page,
  }) => {
    await page.goto(`/ja/pay?to=${TO}&token=usdc&amount=10`);
    // 通常決済バッジは出ない
    await expect(page.getByText('通常決済（ガスあり）')).toHaveCount(0);
    // ネットワーク手数料見積行は出る (gasQuote 未取得状態でも label は描画)
    await expect(page.getByText(/ネットワーク手数料見積/).first()).toBeVisible();
    // Phase 1: fee=0 のため店主受取行 = 10 USDC (gasless でも fee 控除なし)。
    // gas=customer 既定なので gas は顧客支払額に上乗せ、merchant は満額。
    const merchantRow = page
      .locator('div.justify-between')
      .filter({ has: page.getByText('店主受取', { exact: true }) });
    await expect(merchantRow).toContainText('10 USDC');
    // 旧 fee 行 (1.0%=0.1 USDC) と fee 控除後 merchant 値 (9.9 USDC) は出ない
    expect(await page.getByText('0.1 USDC').count()).toBe(0);
    expect(await page.getByText('9.9 USDC').count()).toBe(0);
  });
});
