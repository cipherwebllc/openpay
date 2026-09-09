import { expect, test } from '@playwright/test';

// CI has flags OFF. Like license-ui, this does not fabricate a SIWE session or wallet.
// ON create/edit/holder coverage lives in component tests; real SIWE→302/private R2 is a release smoke.
test.describe('protected delivery UI default OFF', () => {
  test.skip(process.env.NEXT_PUBLIC_ENABLE_STORE_DELIVERY_TICKET === '1' || process.env.NEXT_PUBLIC_ENABLE_STORE_DELIVERY_TICKET === 'true', '有効化環境は flag ON 用の検証で確認する');

  test('作成画面に配布先欄を表示しない', async ({ page }) => {
    await page.goto('/ja/create?tab=profile');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '保護配布先URL', exact: true })).toHaveCount(0);
  });
  test('ライブラリにチケット発行リンクを表示しない', async ({ page }) => {
    await page.goto('/ja/store/library');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('link', { name: '保護ダウンロードを開く', exact: true })).toHaveCount(0);
    await expect(page.locator('a[href^="/api/store/delivery/"]')).toHaveCount(0);
  });
});

test('保護配布ガイドは未公開 SDK の準備手順を示す', async ({ page }) => {
  await page.goto('/ja/guide/store#protected-delivery');
  await expect(page.getByRole('heading', { name: 'ファイルを預けずに保護配布する' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'SDK README の保護配布の設定を見る' })).toHaveAttribute('href', /feat\/protected-delivery-sdk.*README.md#/);
});
