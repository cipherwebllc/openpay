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
});
