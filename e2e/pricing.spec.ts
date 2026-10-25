import { test, expect } from '@playwright/test';

// 料金ページ (/pricing)。jsdom では見られない breakpoint (スマホは 1 列・横にはみ出さない) をここで見る。
// 数字は見ない (CI とローカルで env が違っても描画は同じだが、数字の照合は vitest が権威:
// tests/lib/pricing.test.ts・tests/lib/pricingExamples.test.ts・tests/app/pricingNoHardcode.test.tsx)。
// mobile-safari の click の待ちで時間を使い切らないよう、click は使わない。

// 行の見出しは h4 (払う人のまとまり = h3 の下に並ぶ・2026-10-25)。並びはお店の 3 行 → チップ → デジタル商品。
const GROUPS_JA = ['お店', 'チップを送る方', 'デジタル商品・AI の買い手'];
const FEATURES_JA = [
  '決済QR・レジ（POS）',
  'モバイル注文',
  'お店がガス代を肩代わりして送る',
  'チップ',
  'デジタル商品',
];

test.describe('料金ページ', () => {
  test('/ja/pricing: 見出しと 5 つの機能が見え、計算機が動き、横にはみ出さない', async ({ page }) => {
    await page.goto('/ja/pricing');
    await expect(page.getByRole('heading', { level: 1, name: '料金' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '料金がかかるのは、この 4 つです' })).toBeVisible();
    const fees = page.locator('section[aria-labelledby="pricing-fees"]');
    for (const name of GROUPS_JA) {
      await expect(fees.getByRole('heading', { level: 3, name, exact: true })).toBeVisible();
    }
    for (const name of FEATURES_JA) {
      await expect(fees.getByRole('heading', { level: 4, name, exact: true })).toBeVisible();
    }
    // 計算機は 1,000 JPYC で描かれ、金額を変えると結果が変わる (click は使わず fill だけ)。
    const amount = page.getByLabel('金額', { exact: true });
    await expect(amount).toHaveValue('1,000');
    await amount.fill('10000');
    await expect(amount).toHaveValue('10,000');
    await expect(page.locator('section[aria-labelledby="pricing-calc"]')).toContainText('9,900');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('/en/pricing: 見出しが英語', async ({ page }) => {
    await page.goto('/en/pricing');
    await expect(page.getByRole('heading', { level: 1, name: 'Pricing' })).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="pricing-fees"]').getByRole('heading', { level: 4, name: 'The shop pays the gas', exact: true }),
    ).toBeVisible();
  });
});
