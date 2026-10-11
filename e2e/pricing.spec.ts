import { test, expect } from '@playwright/test';

// 料金ページ (/pricing)。jsdom では見られない breakpoint (スマホは 1 列・横にはみ出さない) をここで見る。
// 数字は見ない (CI とローカルで env が違っても描画は同じだが、数字の照合は vitest が権威:
// tests/lib/pricing.test.ts・tests/lib/pricingExamples.test.ts・tests/app/pricingNoHardcode.test.tsx)。
// mobile-safari の click の待ちで時間を使い切らないよう、click は使わない。

const FEATURES_JA = [
  '決済QR',
  'レジ（POS）',
  'モバイル注文',
  'チップ',
  'デジタル商品',
  'お店がガス代を肩代わりして送る',
];

test.describe('料金ページ', () => {
  test('/ja/pricing: 見出しと 6 つの機能が見え、横にはみ出さない', async ({ page }) => {
    await page.goto('/ja/pricing');
    await expect(page.getByRole('heading', { level: 1, name: '料金' })).toBeVisible();
    for (const name of FEATURES_JA) {
      await expect(page.getByRole('heading', { level: 3, name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('table')).toHaveCount(3);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('/en/pricing: 見出しが英語', async ({ page }) => {
    await page.goto('/en/pricing');
    await expect(page.getByRole('heading', { level: 1, name: 'Pricing' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'The shop pays the gas', exact: true })).toBeVisible();
  });
});
