import { expect, test } from '@playwright/test';

// CI の既定 OFF で、既存の作成画面とガイドへライセンス UI が漏れないことを確認する。
test.describe('license UI default OFF', () => {
  test.skip(process.env.NEXT_PUBLIC_ENABLE_LICENSE_NFT === '1' || process.env.NEXT_PUBLIC_ENABLE_LICENSE_NFT === 'true', '有効化環境の確認は flag ON 用の検証で行う');

  test('ガイドはライセンス節を表示しない', async ({ page }) => {
    await page.goto('/ja/guide/store');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '利用ライセンスを売る' })).toHaveCount(0);
    await expect(page.getByText('createLicenseGate', { exact: false })).toHaveCount(0);
  });

  test('作成画面はライセンスの商品タイプを表示しない', async ({ page }) => {
    await page.goto('/ja/create');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('radio', { name: '利用ライセンス NFT' })).toHaveCount(0);
    await expect(page.getByText('受け取ったライセンス', { exact: true })).toHaveCount(0);
  });
});
