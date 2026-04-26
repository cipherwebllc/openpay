import { test, expect } from '@playwright/test';

test.describe('home / (QR generator + Tip widget tab)', () => {
  test('default タブは決済 QR、QrGenerator が表示される', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'OpenPay' }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '決済 QR (店舗)' }),
    ).toBeVisible();
    // 金額モードのタブ (QrGenerator 内)
    await expect(page.getByRole('button', { name: '金額指定' })).toBeVisible();
  });

  test('Tip widget タブに切り替えると TipEmbedGenerator が表示', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
    await expect(
      page.getByRole('heading', { name: /Tip widget 埋め込みコードを生成/ }),
    ).toBeVisible();
    // 受取アドレス入力 (placeholder は AddressInput の汎用化により変更)
    await expect(
      page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/),
    ).toBeVisible();
  });

  test('受取アドレス入力 → URL と iframe スニペットが生成される', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
    const addressInput = page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/);
    await addressInput.fill(
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
    // URL は header.origin + /tip/0x... を含む文字列
    await expect(
      page
        .locator('div')
        .filter({
          hasText: /\/tip\/0x52d4901142e2B5680027da5EB47C86CB02a3cA81\?token=jpyc/,
        })
        .first(),
    ).toBeVisible();
    // iframe スニペットには <iframe + width="380" が出る
    await expect(page.getByText(/width="380"/)).toBeVisible();
  });
});
