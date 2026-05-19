import { test, expect } from '@playwright/test';

// next-intl middleware の locale prefix / redirect 挙動を実 production build
// で smoke する。Next.js 本体や middleware の patch upgrade (例:
// 15.5.16 → 15.5.18) の後で runtime regression を検知する目的。
// vitest では middleware は走らないため、本 spec でしか catch できない種類の
// バグを対象にする。

test.describe('middleware: next-intl locale prefix / redirect', () => {
  test('/ にアクセスすると Accept-Language に従って /ja または /en へ redirect', async ({
    page,
  }) => {
    const response = await page.goto('/');
    expect(page.url()).toMatch(/\/(ja|en)\/?$/);
    expect(response?.status()).toBeLessThan(400);
  });

  test('/ja は 200 + OpenPay heading が描画', async ({ page }) => {
    const response = await page.goto('/ja');
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: 'OpenPay' }).first(),
    ).toBeVisible();
  });

  test('/en は 200 + 英語 UI', async ({ page }) => {
    const response = await page.goto('/en');
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('button', { name: 'Payment QR (merchant)' }),
    ).toBeVisible();
  });

  test.describe('4 legal page × 2 locale が全 200 (静的生成)', () => {
    const routes = ['terms', 'privacy', 'disclaimer', 'tokutei'];
    for (const route of routes) {
      for (const locale of ['ja', 'en']) {
        test(`/${locale}/${route}`, async ({ page }) => {
          const response = await page.goto(`/${locale}/${route}`);
          expect(response?.status()).toBe(200);
          await expect(page.locator('h1').first()).toBeVisible();
        });
      }
    }
  });

  test('未知 locale (/fr) は 404 (LOCALES whitelist 経由 notFound)', async ({
    page,
  }) => {
    const response = await page.goto('/fr');
    expect(response?.status()).toBe(404);
  });

  test('manifest.webmanifest は middleware bypass で直接 200', async ({
    page,
  }) => {
    const response = await page.goto('/manifest.webmanifest');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toMatch(/manifest|json/);
  });

  test('/api/log/payment は middleware を bypass (matcher 除外)。GET は 405', async ({
    request,
  }) => {
    const res = await request.get('/api/log/payment');
    expect(res.status()).toBe(405);
  });

  test('/api/log/payment POST: 不正 body で 400 (server route 自体は到達)', async ({
    request,
  }) => {
    const res = await request.post('/api/log/payment', {
      data: { not: 'valid' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'invalid_payload' });
  });

  test('/api/paid/hello: 未払いで 402 + x402 spec 準拠の paymentRequirements を返す', async ({
    request,
  }) => {
    // playwright.config.ts の webServer.env で X402_TEST_MODE=false /
    // X402_NETWORK=base-sepolia / X402_PAY_TO_ADDRESS=0x52d4… を pin している
    // ため、X-PAYMENT 欠落の GET は必ず 402 を返す deterministic 状態。
    const res = await request.get('/api/paid/hello');
    expect(res.status()).toBe(402);

    const body = await res.json();
    // x402 protocol: 402 body は { x402Version, error, accepts: [...] }
    expect(body.x402Version).toBeGreaterThanOrEqual(1);
    expect(typeof body.error).toBe('string');
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts.length).toBeGreaterThan(0);

    // accepts[0] は config で pin した値が反映されているはず
    const req0 = body.accepts[0];
    expect(req0.scheme).toBe('exact');
    expect(req0.network).toBe('base-sepolia');
    expect(req0.payTo).toBe('0x52d4901142e2B5680027da5EB47C86CB02a3cA81');
    // asset は base-sepolia native USDC contract (Circle 公式)
    expect(req0.asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    // maxAmountRequired は $0.001 = 1000 atomic unit (USDC 6 decimals)
    expect(req0.maxAmountRequired).toBe('1000');
    // resource は paid endpoint の URL を含む
    expect(req0.resource).toMatch(/\/api\/paid\/hello$/);
    expect(typeof req0.description).toBe('string');
    expect(req0.mimeType).toBe('application/json');
  });

  test('/api/paid/hello: 無効な X-PAYMENT header でも 402 (content は漏らさない)', async ({
    request,
  }) => {
    const res = await request.get('/api/paid/hello', {
      headers: {
        'x-payment': 'not-a-valid-base64-x402-payload',
      },
    });
    expect(res.status()).toBe(402);
    const body = await res.json();
    // handler 内容 "Hello, paid AI agent." が body に絶対漏れないこと
    expect(JSON.stringify(body)).not.toContain('Hello, paid AI agent');
    expect(body.x402Version).toBeGreaterThanOrEqual(1);
  });

  // -- LocaleSwitcher: 実 Next routing + middleware で locale 切替 + query 維持を検証

  test('/ja/pay?to=...&amount=10 → English ボタン → /en/pay (query 維持)', async ({
    page,
  }) => {
    const to = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    await page.goto(`/ja/pay?to=${to}&token=usdc&amount=10`);

    // 初期は日本語 UI (Connect 文言 ja)
    await expect(
      page.getByRole('button', { name: /ウォレットを接続してください/ }),
    ).toBeVisible();

    // LocaleSwitcher の English ボタンを押下
    await page.getByRole('button', { name: 'English' }).click();

    // URL が /en/pay に切替わり、query (to/token/amount) は丸ごと維持
    await expect(page).toHaveURL(
      new RegExp(`/en/pay\\?to=${to}&token=usdc&amount=10$`),
    );
    // 英語 UI: PaymentForm の Connect 文言が英語に (messages/en.json btnConnect)
    await expect(
      page.getByRole('button', { name: /Connect a wallet/i }),
    ).toBeVisible();
    // 金額 header は locale 非依存 (10 USDC) で表示継続 → query 反映確認
    await expect(page.getByText('10 USDC').first()).toBeVisible();
  });

  test('/en/checkout?items=... → 日本語ボタン → /ja/checkout (items / order_id 維持)', async ({
    page,
  }) => {
    const to = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    // items は ":" を %3A に encode した URL 形式 (lib/url.ts buildCheckoutPath 仕様)
    const items = encodeURIComponent('Coffee') + ':2:5.00';
    const url = `/en/checkout?to=${to}&token=usdc&items=${items}&order_id=ORDER-42`;
    await page.goto(url);

    await page.getByRole('button', { name: '日本語' }).click();

    // URL は /ja/checkout に変わり、items / order_id 含む全 query を維持
    await expect(page).toHaveURL(
      new RegExp(
        `/ja/checkout\\?to=${to}&token=usdc&items=${items}&order_id=ORDER-42$`,
      ),
    );
    // items の qty=2, price=5.00 → 合計 10 USDC が反映 (query 失われていない証拠)
    await expect(page.getByText(/10(\.00)? USDC/).first()).toBeVisible();
  });

  test('/ja/tip/0x...?token=jpyc&name=... → English → /en/tip/...?... (name / preset 維持)', async ({
    page,
  }) => {
    const to = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    const name = encodeURIComponent('山田太郎');
    await page.goto(`/ja/tip/${to}?token=jpyc&name=${name}&preset=200,800`);

    // 日本語 header: 「山田太郎 さんへチップを送る」
    await expect(page.getByText(/山田太郎.+チップ/)).toBeVisible();

    await page.getByRole('button', { name: 'English' }).click();

    await expect(page).toHaveURL(
      new RegExp(`/en/tip/${to}\\?token=jpyc&name=${name}&preset=200,800$`),
    );
    // 英語 header: name は preserved
    await expect(page.getByText(/山田太郎/)).toBeVisible();
    // preset ボタン (200/800) は URL query から復元
    await expect(page.getByRole('button', { name: '200 JPYC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '800 JPYC' })).toBeVisible();
  });

  test('LocaleSwitcher 同一 locale クリックは URL 変化なし (no-op)', async ({
    page,
  }) => {
    const to = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    await page.goto(`/ja/pay?to=${to}&token=usdc&amount=10`);
    const before = page.url();

    // 現在 locale (ja) の「日本語」ボタンを押下
    await page.getByRole('button', { name: '日本語' }).click();

    // navigation が起きない (URL 不変、PaymentForm そのまま)
    await expect(page).toHaveURL(before);
    await expect(
      page.getByRole('button', { name: /ウォレットを接続してください/ }),
    ).toBeVisible();
  });
});
