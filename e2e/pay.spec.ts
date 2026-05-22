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
    // 接続ボタンは disabled (未接続)
    const submit = page.getByRole('button', {
      name: /ウォレットを接続してください/,
    });
    await expect(submit).toBeDisabled();
  });

  test('to 欠落 → エラー表示', async ({ page }) => {
    await page.goto('/ja/pay?token=usdc');
    await expect(page.getByText(/決済 URL が不正/)).toBeVisible();
  });

  test('mode=standard → 通常決済（ガスあり）バッジが表示される', async ({ page }) => {
    // 日本語アサーションのため locale を明示。/pay へ素で行くと middleware が
    // Accept-Language (Playwright 既定 en-US) で /en/pay へ redirect する。
    await page.goto(
      `/ja/pay?to=${TO}&token=usdc&amount=10&mode=standard`,
    );
    // amber バナータイトル + breakdown hint で複数箇所
    await expect(
      page.getByText('通常決済（ガスあり）').first(),
    ).toBeVisible();
    // 「ネットワーク手数料: ウォレットで別途支払い」明細
    await expect(page.getByText(/ウォレットで別途/)).toBeVisible();
    // 0.5% fee: 10 USDC × 0.5% = 0.05 USDC
    await expect(page.getByText('0.05 USDC')).toBeVisible();
    // merchant 受取 = 9.95 USDC
    await expect(page.getByText('9.95 USDC')).toBeVisible();
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
    // standard と同じ breakdown (0.05 USDC fee / 9.95 USDC merchant)
    await expect(page.getByText('0.05 USDC')).toBeVisible();
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

  test('mode=gasless (default) → 1.0% fee + ネットワーク手数料見積行が出る', async ({
    page,
  }) => {
    await page.goto(`/ja/pay?to=${TO}&token=usdc&amount=10`);
    // 通常決済バッジは出ない
    await expect(page.getByText('通常決済（ガスあり）')).toHaveCount(0);
    // ネットワーク手数料見積行は出る (gasQuote 未取得状態でも label は描画)
    await expect(page.getByText(/ネットワーク手数料見積/).first()).toBeVisible();
    // 1.0% fee: 10 USDC × 1% = 0.1 USDC
    await expect(page.getByText('0.1 USDC')).toBeVisible();
    // merchant = 9.9 USDC
    await expect(page.getByText('9.9 USDC')).toBeVisible();
  });
});
