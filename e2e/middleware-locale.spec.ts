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

  test('/api/paid/hello: x402 paid route は middleware bypass、test mode で 200 / production で 402', async ({
    request,
  }) => {
    const res = await request.get('/api/paid/hello');
    // X402_TEST_MODE=true で build した場合は 200、未設定 (default false) で
    // build した production deploy では 402 (未払い)。e2e は production build
    // (next start) を起動するため、ローカル CI 環境で X402_TEST_MODE を
    // どちらに設定しても module load + routing が壊れていなければ通る。
    expect([200, 402]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toMatchObject({ message: 'Hello, paid AI agent.' });
    } else {
      const body = await res.json();
      // x402 spec: 402 body は accepts array を含む
      expect(body).toHaveProperty('x402Version');
    }
  });
});
