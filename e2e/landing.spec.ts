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
      page.getByRole('heading', { name: /QRひとつで、JPYC \/ USDC決済/ }),
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
    // ホームへの戻りは AppHeader 左上のロゴクリックに集約。Nav 1 slot 目は「スキャン」。
    await expect(bottomNav.getByRole('link', { name: /スキャン/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /受け取る/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /履歴/ })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: /探す/ })).toBeVisible();
  });

  test('ja: Features セクションに 3 カード (ガスレス/マルチチェーン/ノンカストディ) が出る', async ({
    page,
  }) => {
    await page.goto('/ja');
    await expect(page.getByRole('heading', { name: 'OpenPay の特長' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ガスレス決済' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'マルチチェーン対応' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'ノンカストディ設計' }),
    ).toBeVisible();
  });

  test('ja: HowItWorks セクションに merchant + customer の 3-step が出る', async ({
    page,
  }) => {
    await page.goto('/ja');
    await expect(page.getByRole('heading', { name: '使い方' })).toBeVisible();
    // merchant 3 step (順序付きリスト内のテキスト)
    await expect(page.getByText('受取ウォレットアドレスを入力')).toBeVisible();
    // step3: 印刷 or スマホ提示 の両パターンを含む文言
    await expect(page.getByText(/QR を印刷.*スマホ.*タブレット/)).toBeVisible();
    // customer 3 step
    await expect(
      page.getByText('右上の「接続」からウォレットを接続'),
    ).toBeVisible();
    await expect(page.getByText('ウォレットで署名 → 完了')).toBeVisible();
  });

  test('ja: FAQ は <details> で default closed、click で展開される', async ({
    page,
  }) => {
    await page.goto('/ja');
    await expect(page.getByRole('heading', { name: 'よくある質問' })).toBeVisible();
    const q1 = page.getByText('本当にガス代は不要ですか?');
    await expect(q1).toBeVisible();
    // closed 状態では answer は hidden
    const a1Body = page.getByText(/Pimlico paymaster 経由で立て替え/);
    await expect(a1Body).toBeHidden();
    // 展開
    await q1.click();
    await expect(a1Body).toBeVisible();
  });

  test('ja: Trust セクションに GitHub link (target=_blank + rel=noopener)', async ({
    page,
  }) => {
    await page.goto('/ja');
    const github = page.getByRole('link', { name: /ソースコード \(GitHub\)/ });
    await expect(github).toBeVisible();
    await expect(github).toHaveAttribute(
      'href',
      'https://github.com/cipherwebllc/openpay',
    );
    await expect(github).toHaveAttribute('target', '_blank');
    await expect(github).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
