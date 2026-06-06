import { test, expect } from '@playwright/test';
import { QR_SETTINGS_KEY, SEED_QR_SETTINGS, hideScrollbars } from './_seed';

// ランディング用デモ① 受取 (決済QR)。受取先は「初回に一度設定すれば次回スキップ」
// という実運用に合わせ、localStorage に設定済みでスタート → 金額を入れて QR を出すだけ
// の最短フローを見せる (前版より速い)。録画が主目的、待ちは視認用。
test('受取(決済QR)デモ — 金額入力→QR', async ({ page }) => {
  await page.addInitScript(
    ([key, val]) => localStorage.setItem(key, val),
    [QR_SETTINGS_KEY, JSON.stringify(SEED_QR_SETTINGS)] as const,
  );
  await page.addInitScript(hideScrollbars);
  await page.goto('/ja/create');
  await expect(page.getByRole('button', { name: '決済QR' })).toBeVisible();
  // 受取先は設定済 (② は折りたたみサマリ「OpenPay Store · 0x52d4…cA81」) → すぐ金額へ。
  await page.waitForTimeout(1300);

  const amount = page.getByPlaceholder('1000', { exact: true });
  await amount.click();
  await amount.pressSequentially('1280', { delay: 75 });
  await page.waitForTimeout(700);

  // モバイル下部固定バーから全画面 QR を提示 (DOM 末尾 = bottom bar)。
  const showQr = page.getByRole('button', { name: 'QRコードを表示する' }).last();
  await expect(showQr).toBeVisible();
  await showQr.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(2400);
});
