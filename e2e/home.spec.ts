import { test, expect } from '@playwright/test';

test.describe('home / (QR generator + Tip widget tab)', () => {
  test('default タブは決済 QR、QrGenerator が表示される', async ({ page }) => {
    await page.goto('/ja');
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
    await page.goto('/ja');
    await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
    await expect(
      page.getByRole('heading', { name: /Tip widget 埋め込みコードを生成/ }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/),
    ).toBeVisible();
  });

  test('受取アドレス入力 → URL と iframe スニペットが生成される', async ({
    page,
  }) => {
    await page.goto('/ja');
    await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
    const addressInput = page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/);
    await addressInput.fill(
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
    // 生成 URL は origin + /tip/0x...?token=jpyc。locale prefix は middleware
    // が動的に付与するため埋め込み URL 自体には含まれない (iframe を貼った
    // ページ訪問者の Accept-Language で /ja か /en に redirect される)。
    await expect(
      page
        .locator('div')
        .filter({
          hasText:
            /\/tip\/0x52d4901142e2B5680027da5EB47C86CB02a3cA81\?token=jpyc/,
        })
        .first(),
    ).toBeVisible();
    // iframe スニペットには <iframe + width="380" が出る
    await expect(page.getByText(/width="380"/)).toBeVisible();
  });

  test('英語ロケール (/en) でも UI が描画される', async ({ page }) => {
    await page.goto('/en');
    await expect(
      page.getByRole('button', { name: 'Payment QR (merchant)' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Tip widget (creator)' }),
    ).toBeVisible();
  });

  test('ja: offramp セクションに JPYC 公式 / SBI VC トレード のリンクが正しい href で描画される', async ({
    page,
  }) => {
    await page.goto('/ja');
    const offrampHeading = page.getByRole('heading', {
      name: '受け取った通貨を換金',
    });
    await expect(offrampHeading).toBeVisible();
    const jpycLink = page.getByRole('link', { name: /JPYC 公式/ });
    await expect(jpycLink).toHaveAttribute('href', 'https://jpyc.co.jp/');
    await expect(jpycLink).toHaveAttribute('target', '_blank');
    await expect(jpycLink).toHaveAttribute('rel', 'noopener noreferrer');
    const sbiLink = page.getByRole('link', { name: /SBI VC トレード/ });
    await expect(sbiLink).toHaveAttribute('href', 'https://www.sbivc.co.jp/');
    // ja では Japan residents only / locale switch ヒントは出ない
    await expect(page.getByText(/日本居住者のみ/)).toHaveCount(0);
  });

  test('en: offramp セクションは Coinbase + JPYC official、注記/ヒントが両方出る', async ({
    page,
  }) => {
    await page.goto('/en');
    await expect(
      page.getByRole('heading', { name: 'Off-ramp received tokens' }),
    ).toBeVisible();
    const jpycLink = page.getByRole('link', { name: /JPYC official/ });
    await expect(jpycLink).toHaveAttribute('href', 'https://jpyc.co.jp/');
    await expect(page.getByText('(Japan residents only)')).toBeVisible();
    const coinbaseLink = page.getByRole('link', { name: /Coinbase/ });
    await expect(coinbaseLink).toHaveAttribute(
      'href',
      'https://www.coinbase.com/',
    );
    await expect(
      page.getByText(/Japan residents: switch to Japanese for SBI VC Trade/),
    ).toBeVisible();
  });
});
