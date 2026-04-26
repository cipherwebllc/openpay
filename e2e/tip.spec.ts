import { test, expect } from '@playwright/test';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

test.describe('/tip/[address] (creator tip widget)', () => {
  test('最小 URL → preset ボタン + 連結チェーン名', async ({ page }) => {
    await page.goto(`/ja/tip/${TO}?token=jpyc`);
    await expect(page.getByText('OpenPay Tip')).toBeVisible();
    // 既定 preset
    await expect(page.getByRole('button', { name: '100 JPYC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '500 JPYC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '1000 JPYC' })).toBeVisible();
    // 既定で先頭 preset (100) が選択 → 顧客支払 115 (MIN_FEE 15 上乗せ)
    await expect(page.getByText('115 JPYC を送る')).toBeVisible();
  });

  test('全パラメータ付き URL → カスタム表示反映', async ({ page }) => {
    await page.goto(
      `/tip/${TO}?token=jpyc&name=%E5%B1%B1%E7%94%B0%E5%A4%AA%E9%83%8E&message=hi&color=%23ff0080&preset=200,800`,
    );
    await expect(page.getByText('山田太郎 さんへチップを送る')).toBeVisible();
    await expect(page.getByText('hi')).toBeVisible();
    await expect(page.getByRole('button', { name: '200 JPYC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '800 JPYC' })).toBeVisible();
  });

  test('USDC + 既定 preset (1/5/10)', async ({ page }) => {
    await page.goto(`/ja/tip/${TO}?token=usdc`);
    await expect(page.getByRole('button', { name: '1 USDC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '5 USDC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '10 USDC' })).toBeVisible();
  });

  test('不正 URL (token なし) → エラー表示', async ({ page }) => {
    await page.goto(`/ja/tip/${TO}`);
    await expect(page.getByText(/Tip URL が不正/)).toBeVisible();
  });

  test('英語ロケール (/en/tip) でも動作', async ({ page }) => {
    await page.goto(`/en/tip/${TO}?token=jpyc`);
    await expect(page.getByText('OpenPay Tip')).toBeVisible();
    await expect(page.getByText(/Send a tip to the creator/)).toBeVisible();
    await expect(page.getByText(/Send 115 JPYC/)).toBeVisible();
  });
});
