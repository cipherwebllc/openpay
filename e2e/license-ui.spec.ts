import { expect, test } from '@playwright/test';

// Standard terms remain public independently of listing flags, including CI flag OFF.
for (const [locale, heading] of [
  ['ja', '利用ライセンス標準条件 standard-v1'],
  ['en', 'Standard Usage License Terms standard-v1'],
]) {
  test(`standard license terms are public (${locale})`, async ({ page }) => {
    await page.goto(`/${locale}/license-terms/standard-v1`);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('article ol > li')).toHaveCount(11);
  });
}

// CI の既定 OFF で、既存の作成画面とガイドへライセンス UI が漏れないことを確認する。
test.describe('license UI default OFF', () => {
  test.skip(process.env.NEXT_PUBLIC_ENABLE_LICENSE_NFT === '1' || process.env.NEXT_PUBLIC_ENABLE_LICENSE_NFT === 'true', '有効化環境の確認は flag ON 用の検証で行う');

  test('ガイドはライセンス節を表示しない', async ({ page }) => {
    await page.goto('/ja/guide/store');
    // ガイドは h1 が複数ある (タイトル + ヒーロー) ので strict 違反を避けて先頭だけ待つ。
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
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
