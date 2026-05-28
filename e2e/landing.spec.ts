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

    // Hero leadline (h2)
    await expect(
      page.getByRole('heading', { name: /Web3 決済ポータル/ }),
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
    await expect(bottomNav.getByRole('link', { name: /ホーム/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /受け取る/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /履歴/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /探す/ })).toBeVisible();
  });
});
