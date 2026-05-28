import { test, expect } from '@playwright/test';

// /history は LocalStorage 専用の per-browser ページ。jsdom 経由の vitest では
// hydrate 経路や SSR/CSR 切替を 100% 再現できないため、本 spec で実 browser での
// ハイドレート + 表示 + LocalStorage 連動を確認する。
// 実 wallet/network は不要 (purely client-side / no fetch)。

test.describe('/history (browser-level smoke)', () => {
  test('ja: 空 LocalStorage で empty state が表示される', async ({ page }) => {
    await page.goto('/ja/history');
    // ページタイトルは h2 (AppShell の logo h1 + NonCustodialNotice の h2 と
    // 区別するため exact: true)
    await expect(
      page.getByRole('heading', { name: '取引履歴', level: 2, exact: true }),
    ).toBeVisible();
    // NonCustodialNotice の h2
    await expect(
      page.getByRole('heading', { name: '取引履歴について', level: 2 }),
    ).toBeVisible();
    // empty state
    await expect(page.getByText(/履歴はまだありません/)).toBeVisible();
    // CSV / Clear ボタンは disabled
    await expect(
      page.getByRole('button', { name: 'CSV ダウンロード' }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: '全て削除' })).toBeDisabled();
  });

  test('en: 英語 landing が hydrate される', async ({ page }) => {
    await page.goto('/en/history');
    await expect(
      page.getByRole('heading', {
        name: 'Transaction history',
        level: 2,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'About transaction history', level: 2 }),
    ).toBeVisible();
    await expect(page.getByText(/No history yet/)).toBeVisible();
  });

  test('LocalStorage に seed → ハイドレート後に entry が出る + filter / CSV ボタンが enabled', async ({
    page,
  }) => {
    await page.goto('/ja/history');
    // 描画完了 (empty) を待ってから seed
    await expect(page.getByText(/履歴はまだありません/)).toBeVisible();

    // 別 tab から書込まれた状況の simulation: 直接 LocalStorage に書いて
    // storage event を dispatch (useHistory hook が拾って再 load する)。
    await page.evaluate(() => {
      const entry = {
        schemaVersion: 1,
        id: 'e2e-seed',
        ts: Date.now(),
        flow: 'batch',
        status: 'success',
        chainId: 80002,
        chainSlug: 'polygon',
        asset: 'jpyc',
        tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
        payMode: 'gasless',
        gasMode: 'customer',
        merchant: '0x1111111111111111111111111111111111111111',
        merchantAmount: '500000000000000000000', // 500 JPYC
        customer: '0x9999999999999999999999999999999999999999',
        feeReceiver: '0x2222222222222222222222222222222222222222',
        feeAmount: '5000000000000000000', // 5 JPYC
        txHash:
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        userOpHash:
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        blockNumber: '12345',
        errorMessage: null,
        storeName: '',
        note: '',
      };
      window.localStorage.setItem(
        'openpay:history:v1',
        JSON.stringify([entry]),
      );
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'openpay:history:v1',
          newValue: 'seeded',
        }),
      );
    });

    // filter ボタンが新 count を反映
    await expect(
      page.getByRole('button', { name: /全て \(1\)/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /JPYC \(1\)/ }),
    ).toBeVisible();
    // 金額表示 (500 JPYC)
    await expect(page.getByText('500 JPYC')).toBeVisible();
    // status badge
    await expect(page.getByText('成功')).toBeVisible();
    // Explorer 行内リンクは NETWORK_ENV と chainId の組合せで決まるため
    // 環境非依存に検証しない (chainId=80002 は testnet のみ supportedChains 内)。
    // CSV / Clear が enabled
    await expect(
      page.getByRole('button', { name: 'CSV ダウンロード' }),
    ).toBeEnabled();
  });

  test('AppShell ロゴ click で home (/ja) へ戻れる (旧 back link の代替)', async ({
    page,
  }) => {
    await page.goto('/ja/history');
    // AppHeader 内のロゴ link を scope (HistoryEmptyState の "OpenPay →" CTA や
    // SiteFooter の X link との strict mode 衝突を回避)
    const header = page.locator('header');
    const logoLink = header.getByRole('link', { name: 'OpenPay', exact: true });
    await expect(logoLink).toHaveAttribute('href', '/ja');
  });

  test('AppShell BottomNav / TopNav から /history への nav link がある (旧 SiteFooter link の置換)', async ({
    page,
  }) => {
    await page.goto('/ja');
    // viewport 別: desktop は TopNav (md:flex / aria-label=primary navigation)、
    // mobile は BottomNav (md:hidden / aria-label=bottom navigation) が visible に
    // なる。両方の nav に同じ「履歴」 link が存在するため、role を nav 一般に広げて
    // .first() で visible な方を取る。href は両 nav で同一 (/ja/history)。
    const link = page
      .getByRole('navigation')
      .getByRole('link', { name: '履歴' })
      .first();
    await expect(link).toHaveAttribute('href', '/ja/history');
  });

  test('/pay (bare, query 空) → PayEmptyLanding に「履歴を見る」link', async ({
    page,
  }) => {
    await page.goto('/ja/pay');
    await expect(
      page.getByRole('heading', { name: 'ここは「顧客向け」決済ページです' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'このブラウザの履歴を見る' }),
    ).toHaveAttribute('href', '/history');
  });
});
