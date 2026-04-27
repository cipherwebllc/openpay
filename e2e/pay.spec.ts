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

  test('mode=direct → ガス代お客様負担の警告が出る', async ({ page }) => {
    await page.goto(
      `/pay?to=${TO}&token=usdc&amount=10&mode=direct`,
    );
    await expect(page.getByText(/ガス代お客様負担/)).toBeVisible();
  });
});
