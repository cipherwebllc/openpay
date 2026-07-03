import { test, expect } from '@playwright/test';

test.describe('/explore (Web3 サービス directory)', () => {
  test('ja: 5 カテゴリ heading が visible (Exchange/DEX/dApp/Bridge/Resource)', async ({
    page,
  }) => {
    await page.goto('/ja/explore');
    await expect(
      page.getByRole('heading', { name: /取引所 \(CEX\)/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /DEX \(分散型取引所\)/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /dApp \/ サービス/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Bridge \(cross-chain\)/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Resource \(探索・分析\)/ }),
    ).toBeVisible();
  });

  test('ja: 代表エントリ (JPYC EX / Uniswap / Circle CCTP) が target=_blank で出る', async ({
    page,
  }) => {
    await page.goto('/ja/explore');
    const jpyc = page.getByRole('link', { name: /JPYC EX/ });
    await expect(jpyc).toBeVisible();
    await expect(jpyc).toHaveAttribute('href', 'https://jpyc.co.jp/');
    await expect(jpyc).toHaveAttribute('target', '_blank');
    await expect(jpyc).toHaveAttribute('rel', 'noopener noreferrer');

    const uni = page.getByRole('link', { name: /Uniswap/ });
    await expect(uni).toBeVisible();
    await expect(uni).toHaveAttribute('href', 'https://app.uniswap.org/');

    const cctp = page.getByRole('link', { name: /Circle CCTP/ });
    await expect(cctp).toBeVisible();
    await expect(cctp).toHaveAttribute('href', /circle\.com/);
  });

  test('en: page title が英語、Exchange/DEX heading が英語表記', async ({ page }) => {
    await page.goto('/en/explore');
    // h1 を level + exact name で固定 (h2 "Resources (explore & analyze)" との
    // 部分一致衝突を回避)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Explore' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Exchanges \(CEX\)/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /DEX \(decentralized\)/ }),
    ).toBeVisible();
  });

  test('ja: badge (日本居住者 / Global) が複数 entry に出る', async ({ page }) => {
    await page.goto('/ja/explore');
    // 「日本居住者」 badge は JPYC EX / SBI VC 等の jp-only 系で複数件
    expect(await page.getByText('日本居住者').count()).toBeGreaterThan(2);
    expect(await page.getByText('Global', { exact: true }).count()).toBeGreaterThan(2);
  });
});
