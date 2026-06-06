import { test, expect } from '@playwright/test';

// ランディング用デモ収録 (録画が主目的)。実 UI を素のまま操作し、
// 「受取先 → サンプル金額ワンタップ → 全画面QR提示」の最短フローを見せる。
// 各ステップは expect で待ち合わせてフレーム落ち/早送りを防ぎ、
// waitForTimeout で視認できる間 (ためし見できる尺) を確保する。
test('決済QR作成デモ (受取先→サンプル金額→QR表示)', async ({ page }) => {
  await page.goto('/ja/create');
  await expect(page.getByRole('button', { name: '決済QR' })).toBeVisible();
  // タイトル/タブを読ませる間。
  await page.waitForTimeout(1600);

  // ① 受取先 (② ブロックは初期 open)。type 風に入力して
  // 「自分のウォレットアドレスで直接受け取る (ノンカストディ)」を見せる。
  const receiver = page.getByPlaceholder(/0x\.\.\./).first();
  await receiver.scrollIntoViewIfNeeded();
  await receiver.click();
  await receiver.pressSequentially(
    '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    { delay: 22 },
  );
  await page.waitForTimeout(900);

  // ② サンプル金額ワンタップ (Phase 6 の新導線)。受取先済 & 金額未入力で出る。
  const sample = page.getByRole('button', { name: /サンプル金額 1000 で試す/ });
  await sample.scrollIntoViewIfNeeded();
  await expect(sample).toBeVisible();
  await page.waitForTimeout(700);
  await sample.click();
  await page.waitForTimeout(1100);

  // ③ モバイル下部固定バーから全画面 QR を提示 (DOM 末尾 = bottom bar)。
  const showQr = page
    .getByRole('button', { name: 'QRコードを表示する' })
    .last();
  await expect(showQr).toBeVisible();
  await page.waitForTimeout(400);
  await showQr.click();

  // ④ QR モーダルで顧客提示。ここで停止して締める (ループの見せ場)。
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(2600);
});
