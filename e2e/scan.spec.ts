import { test, expect } from '@playwright/test';

// /scan は実カメラ + qr-scanner ワーカー + WalletConnect を要求するため、
// e2e では「ページ構造 + i18n + URL fallback + 未接続時の navigation」の
// smoke のみカバーする。実 camera 経路は LARP 防止のため明示的にスコープ外。
// camera decode 自体は tests/components/QrScannerSurface + ScanShell の単体
// 統合テストで「mock qr-scanner → 完全な router.push」までを通している。

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

test.describe('/scan: ページ構造', () => {
  test('/ja/scan が 200 + 主要 heading + ConnectButton (未接続) 描画', async ({
    page,
  }) => {
    const response = await page.goto('/ja/scan');
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: 'スキャンして支払う' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'ウォレットの状態' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'QR を読み取る' }),
    ).toBeVisible();
    // 未接続時は connectionPreHint が出る (connect button は wagmi 環境依存だが
    // pre-hint テキストは locale 文字列なので決定論的)
    await expect(page.getByText(/あらかじめウォレットを接続/)).toBeVisible();
  });

  test('/en/scan も 200 + 英語 UI に切替', async ({ page }) => {
    const response = await page.goto('/en/scan');
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: 'Scan to pay' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Scan a QR' }),
    ).toBeVisible();
  });

  test('/scan は middleware が Accept-Language で /ja or /en へ redirect', async ({
    page,
  }) => {
    const response = await page.goto('/scan');
    expect(response?.status()).toBeLessThan(400);
    expect(page.url()).toMatch(/\/(ja|en)\/scan\/?$/);
  });

  test('LocaleSwitcher が header に出ていて、ja → en で URL も切替', async ({
    page,
  }) => {
    await page.goto('/ja/scan');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page).toHaveURL(/\/en\/scan/);
    await expect(
      page.getByRole('heading', { name: 'Scan to pay' }),
    ).toBeVisible();
  });
});

test.describe('/scan: URL 手入力 fallback', () => {
  test('「カメラを起動」ボタンが視覚的に出る (camera permission は実環境依存)', async ({
    page,
  }) => {
    await page.goto('/ja/scan');
    await expect(
      page.getByRole('button', { name: 'カメラを起動' }),
    ).toBeVisible();
  });

  test('URL 手入力 → 「この URL で進む」で /pay へ遷移', async ({ page }) => {
    await page.goto('/ja/scan');
    // details summary をクリックして fallback フォームを展開
    await page.getByText('URL を貼り付けて続行').click();
    const input = page.getByLabel('OpenPay の URL (https://open-pay.jp/pay?…)');
    await input.fill(`http://localhost:3000/pay?to=${TO}&token=usdc&amount=10`);
    await page.getByRole('button', { name: 'この URL で進む' }).click();
    // 遷移後の URL は /ja/pay?... (currentLocale で正規化される)
    await expect(page).toHaveURL(
      new RegExp(`/ja/pay\\?to=${TO}&token=usdc&amount=10$`),
    );
    // 既存 /pay UI の決定論アサーション
    await expect(page.getByText('10 USDC').first()).toBeVisible();
  });

  test('外部 origin URL を手入力 → 警告 banner が出て /pay へは遷移しない', async ({
    page,
  }) => {
    await page.goto('/ja/scan');
    await page.getByText('URL を貼り付けて続行').click();
    const input = page.getByLabel('OpenPay の URL (https://open-pay.jp/pay?…)');
    await input.fill(`https://attacker.example.com/pay?to=${TO}`);
    await page.getByRole('button', { name: 'この URL で進む' }).click();
    await expect(
      page.getByText('OpenPay 以外の URL が読まれました'),
    ).toBeVisible();
    // URL は /scan のまま
    expect(page.url()).toMatch(/\/scan/);
    // 「新しいタブで開く」リンクの属性検証
    const externalLink = page.getByRole('link', { name: '新しいタブで開く' });
    await expect(externalLink).toHaveAttribute(
      'href',
      `https://attacker.example.com/pay?to=${TO}`,
    );
    await expect(externalLink).toHaveAttribute('target', '_blank');
    await expect(externalLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('ethereum: URL を手入力 → EIP-681 案内 banner を表示 (Phase 1 reject)', async ({
    page,
  }) => {
    await page.goto('/ja/scan');
    await page.getByText('URL を貼り付けて続行').click();
    await page
      .getByLabel('OpenPay の URL (https://open-pay.jp/pay?…)')
      .fill('ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1');
    await page.getByRole('button', { name: 'この URL で進む' }).click();
    await expect(
      page.getByText('ethereum: URL は現在 OpenPay 内で扱えません'),
    ).toBeVisible();
    expect(page.url()).toMatch(/\/scan/);
  });

  test('未知文字列を手入力 → unknown banner で raw を提示', async ({ page }) => {
    await page.goto('/ja/scan');
    await page.getByText('URL を貼り付けて続行').click();
    await page
      .getByLabel('OpenPay の URL (https://open-pay.jp/pay?…)')
      .fill('NOT-A-URL');
    await page.getByRole('button', { name: 'この URL で進む' }).click();
    await expect(
      page.getByText('QR の内容を判別できませんでした'),
    ).toBeVisible();
    await expect(page.getByText('NOT-A-URL')).toBeVisible();
  });
});

test.describe('/scan: home からの導線', () => {
  test('home の "📷 レジ前で素早く決済" CTA をクリック → /ja/scan へ遷移', async ({
    page,
  }) => {
    await page.goto('/ja');
    const cta = page.getByRole('link', {
      name: /レジ前で素早く決済/,
    });
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page).toHaveURL(/\/ja\/scan/);
    await expect(
      page.getByRole('heading', { name: 'スキャンして支払う' }),
    ).toBeVisible();
  });
});

test.describe('/scan: mobile viewport', () => {
  test('iPhone 14 (390px) viewport で horizontal overflow が無い', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-safari', 'mobile viewport 専用');
    await page.goto('/ja/scan');
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});

test.describe('/scan: PWA manifest 連携', () => {
  test('manifest が /ja/scan への shortcut を持つ', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      shortcuts?: Array<{ url: string; name?: string; icons?: unknown[] }>;
    };
    expect(body.shortcuts).toBeDefined();
    const scan = body.shortcuts!.find((s) => s.url === '/ja/scan');
    expect(scan).toBeDefined();
    expect(scan!.icons?.length).toBeGreaterThan(0);
  });
});
