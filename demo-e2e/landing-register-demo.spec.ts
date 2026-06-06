import { test, expect } from '@playwright/test';
import { QR_SETTINGS_KEY, SEED_QR_SETTINGS, demoChrome } from './_seed';

// ランディング用デモ② レジ (POS)。受取先は設定済みで開始 → レジタブ → 既定プリセット
// (コーヒー/Tシャツ/イベント参加費…) をタップしてカートを組み立て → 合計確認 → 全画面QR。
// POS 風の使い勝手を見せる。
test('レジ(POS)デモ — プリセットでカート→QR', async ({ page }) => {
  await page.addInitScript(
    ([key, val]) => localStorage.setItem(key, val),
    [QR_SETTINGS_KEY, JSON.stringify(SEED_QR_SETTINGS)] as const,
  );
  await page.addInitScript(demoChrome);
  await page.goto('/ja/create');
  await expect(page.getByRole('button', { name: '決済QR' })).toBeVisible();
  await page.waitForTimeout(900);

  await page.getByRole('button', { name: 'レジ' }).click();
  await page.waitForTimeout(900);

  // 既定プリセットをタップして明細を積む (各 addFromPreset = 1 行)。
  await page.getByRole('button', { name: /コーヒー/ }).click();
  await page.waitForTimeout(550);
  await page.getByRole('button', { name: /Tシャツ/ }).click();
  await page.waitForTimeout(550);
  await page.getByRole('button', { name: /イベント参加費/ }).click();
  await page.waitForTimeout(900);

  // 下部固定バーの合計 → 全画面 QR を提示 (DOM 末尾 = bottom bar)。
  const showQr = page.getByRole('button', { name: 'QRコードを表示する' }).last();
  await expect(showQr).toBeVisible();
  await showQr.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(2400);
});
