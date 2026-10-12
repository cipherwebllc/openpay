import { test, expect } from '@playwright/test';

// ガイド共通の目次 (components/guide/GuideFrame.tsx) と /guide ハブ。
// jsdom では見られない breakpoint の出し分け (PC = 左のサイドバー / スマホ = <details> のバー) と開閉をここで見る。
// 目次は PC 用とスマホ用の 2 つを DOM に置き、CSS で片方を display:none にしている。
// そのため「ガイド一覧」は文字ではなく nav の名前で探す (getByText だと隠れた方にも当たって strict 違反になる)。
// リンク名は関連ガイドの「導入前チェックリスト — …」等にも部分一致するので、nav の中に絞って exact にする。

test.describe('ガイドの目次と /guide ハブ', () => {
  test('PC: サイドバーの「ガイド一覧」に現在地が出て、別のガイドへ移ると現在地も移る', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC (lg 以上) 専用');
    await page.goto('/ja/guide/qr');
    const nav = page.getByRole('navigation', { name: 'ガイド一覧' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: '決済QR', exact: true })).toHaveAttribute('aria-current', 'page');
    // PC ではスマホ用のバーを出さない
    await expect(page.locator('summary', { hasText: 'ガイド一覧' })).toBeHidden();

    await nav.getByRole('link', { name: 'API を売る', exact: true }).click();
    await expect(page).toHaveURL(/\/ja\/guide\/sell$/);
    const navAfter = page.getByRole('navigation', { name: 'ガイド一覧' });
    await expect(navAfter.getByRole('link', { name: 'API を売る', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(navAfter.getByRole('link', { name: '決済QR', exact: true })).not.toHaveAttribute('aria-current', 'page');
  });

  test('スマホ: 「ガイド一覧」のバーを押すと目次が開き、ガイドへ移れる', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-safari', 'mobile viewport 専用');
    await page.goto('/ja/guide/qr');
    const summary = page.locator('summary', { hasText: 'ガイド一覧' });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('決済QR');
    const nav = page.getByRole('navigation', { name: 'ガイド一覧' });
    const link = nav.getByRole('link', { name: '導入前チェックリスト', exact: true });
    await expect(link).toBeHidden();

    await summary.click();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/ja\/guide\/start$/);
  });

  test('/ja/guide: 見出しと、main の中にガイドへのリンク (はじめての方へ 2 本 + 一覧 10 本)', async ({ page }) => {
    await page.goto('/ja/guide');
    await expect(page.getByRole('heading', { level: 1, name: 'OpenPay でできること' })).toBeVisible();
    // 「はじめての方へ」(導入前チェックリスト・決済QR の 2 本) + 5 グループの 10 本。
    await expect(page.getByRole('main').locator('a[href^="/ja/guide/"]')).toHaveCount(12);
  });
});
