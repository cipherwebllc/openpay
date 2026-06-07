import { test, expect } from '@playwright/test';
import { QR_SETTINGS_KEY, SEED_QR_SETTINGS, demoChrome } from './_seed';

// ランディング用デモ② レジ (POS)。受取先は設定済みで開始 → レジタブ → 既定プリセット
// (コーヒー/Tシャツ/イベント参加費) を順にタップして明細を積み上げ、合計が 500→3500→4500
// と増える様子と全画面QRを見せる。
//
// 注意 (重要): /create は wagmi 等で初期ハイドレーションが重く、本番ビルドでは interactive
// になるまで数秒かかる。それ以前にタップしても React の event replay キューに溜まり、
// ハイドレーション完了時に一気に反映 → 積み上がりがフレームに残らない (合計が 0 のまま
// 末尾で QR に飛ぶ)。そこで「クリック開始前に十分待つ」+「各タップ後に明細件数の反映を
// 待ってから hold」で、ラグがあっても確実にステップを収める。先頭の待ち時間は収録後に
// ffmpeg で trim する前提 (HYDRATE_SETTLE_MS を変えれば調整可)。
const HYDRATE_SETTLE_MS = 12000;

test('レジ(POS)デモ — プリセットでカート→QR', async ({ page }) => {
  await page.addInitScript(
    ([key, val]) => localStorage.setItem(key, val),
    [QR_SETTINGS_KEY, JSON.stringify(SEED_QR_SETTINGS)] as const,
  );
  await page.addInitScript(demoChrome);
  await page.goto('/ja/create');
  await expect(page.getByRole('button', { name: '決済QR' })).toBeVisible();

  // ハイドレーション完了までしっかり待つ (これ以前のクリックは replay 遅延で積み上がりが
  // 映らない)。この間の素の画面は収録後に trim する。
  await page.waitForTimeout(HYDRATE_SETTLE_MS);

  await page.getByRole('button', { name: 'レジ' }).click();
  const coffee = page.getByRole('button', { name: /コーヒー/ });
  await expect(coffee).toBeVisible();
  await page.waitForTimeout(1100);

  // 明細カードの削除ボタン数 = カート件数。各タップ後にこれが増えるまで (= React 反映 +
  // カード描画まで) 待ち、合計の増加を見せてから次へ。
  const removeButtons = page.getByRole('button', { name: 'この商品を削除' });

  await coffee.click();
  await expect(removeButtons).toHaveCount(1);
  await page.waitForTimeout(1000); // 合計 500 を見せる

  await page.getByRole('button', { name: /Tシャツ/ }).click();
  await expect(removeButtons).toHaveCount(2);
  await page.waitForTimeout(1000); // 合計 3500 を見せる

  await page.getByRole('button', { name: /イベント参加費/ }).click();
  await expect(removeButtons).toHaveCount(3);
  await expect(page.getByText('4500 JPYC').last()).toBeVisible();
  await page.waitForTimeout(1700); // 合計 4500 をしっかり見せる (POS の見せ場)

  // 「QRコードを表示する」をタップ → 全画面QR (DOM 末尾 = bottom bar)。
  const showQr = page.getByRole('button', { name: 'QRコードを表示する' }).last();
  await showQr.scrollIntoViewIfNeeded();
  await expect(showQr).toBeVisible();
  await page.waitForTimeout(600);
  await showQr.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(2200);
});
