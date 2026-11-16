import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

// トップの販売の節の見本で選んだテーマと色が、「出品をはじめる」で開く作成画面 (プロフのタブ) の最初の見た目になる
// (plans/lp-polish-2026-11.md P6)。本番と同じ flag の build で、実際にトップから作成画面へ移って確かめる。ウォレットはつながない。
// 期待値は手で書く: 紫 = #7c3aed = rgb(124, 58, 237)・Night の地 = #0f172a = rgb(15, 23, 42)。

async function openTop(page: Page) {
  // 作成画面は最初に決済QR のタブを描き (?tab= はマウント後に反映)、決済QR は市場レート (USDC→円) を読む。
  // 見た目には関係しないので固定値で応える (order-link.spec と同じ)。
  await page.route('**/api/market/rates', (route) =>
    route.fulfill({ json: { usdcJpy: 150, updatedAt: '2026-10-09T00:00:00.000Z' } }),
  );
  await page.goto('/ja');
  return page.locator('section#lp-sell');
}

/** プロフのタブの「見た目（任意）」を開いて、テーマの選択と色の欄を返す。 */
async function openLook(page: Page) {
  const look = page.locator('details').filter({ has: page.getByText('見た目（任意）', { exact: true }) });
  await look.getByText('見た目（任意）', { exact: true }).click();
  return {
    theme: (name: string) => look.getByRole('button', { name, exact: true }),
    colorText: look.getByPlaceholder('#2563eb'),
  };
}

test('見本で Night × 紫を選ぶ → 「出品をはじめる」→ 作成画面のプレビューと見た目の選択が Night × 紫で始まる', async ({ page }) => {
  const sell = await openTop(page);
  await sell.getByRole('button', { name: 'Night', exact: true }).click();
  await sell.getByRole('button', { name: '紫', exact: true }).click();
  const cta = sell.getByRole('link', { name: '出品をはじめる', exact: true });
  await expect(cta).toHaveAttribute('href', '/ja/create?tab=profile&theme=night&color=violet');
  await cta.click();

  // 読んだ後は theme と color を URL から消す (tab は残す・再読み込みで二重に入れない)。
  await expect(page).toHaveURL(/\/ja\/create\?tab=profile$/, { timeout: 15_000 });
  const preview = page.getByTestId('handle-preview-scroll');
  await expect(preview).toHaveCSS('background-color', 'rgb(15, 23, 42)');
  await expect(preview).toHaveCSS('background-image', /rgba\(124, 58, 237, 0\.24/);
  const look = await openLook(page);
  await expect(look.theme('Night')).toHaveAttribute('aria-pressed', 'true');
  await expect(look.theme('Clean')).toHaveAttribute('aria-pressed', 'false');
  await expect(look.colorText).toHaveValue('#7c3aed');
  // 見本の名前はコピーしない (表示名は空のまま)。
  await expect(page.getByLabel('表示名', { exact: true })).toHaveValue('');

  // 再読み込みしても、入れた見た目はこの端末の下書きに残る (URL にはもう無い)。
  await page.reload();
  await expect(page.getByTestId('handle-preview-scroll')).toHaveCSS('background-color', 'rgb(15, 23, 42)', { timeout: 15_000 });
  await expect(page).toHaveURL(/\/ja\/create\?tab=profile$/);
});

test('見本に触らずに「出品をはじめる」→ 今までどおり既定 (Clean × 青) で始まる', async ({ page }) => {
  const sell = await openTop(page);
  const cta = sell.getByRole('link', { name: '出品をはじめる', exact: true });
  await expect(cta).toHaveAttribute('href', '/ja/create?tab=profile');
  await cta.click();
  await expect(page).toHaveURL(/\/ja\/create\?tab=profile$/, { timeout: 15_000 });
  const look = await openLook(page);
  await expect(look.theme('Clean')).toHaveAttribute('aria-pressed', 'true');
  await expect(look.colorText).toHaveValue('#2563eb');
  await expect(page.getByTestId('handle-preview-scroll')).toHaveCSS('background-image', 'none');
});
