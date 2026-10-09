import { test, expect } from './fixtures';

// 受注タブ (2026-10 磨き上げ P2)。本番と同じ flag の build で、未サインインの店主に
// 「何をすればよいか (サインイン) → 保存の開示」の順で出ることを確かめる。
// サインイン後の一覧 (件数・2 列・顧客申告の注記) は mock wallet の無い本番 flag build では作れないため unit test で見る。
test('/create?tab=orders — guest sees one sign-in entry first and the retention disclosure last, verbatim', async ({ page }) => {
  // 販売の画面は共通で市場レート (USDC→円) を読む。受注の表示には関係しないので固定値で応える。
  await page.route('**/api/market/rates', (route) =>
    route.fulfill({ json: { usdcJpy: 150, updatedAt: '2026-10-09T00:00:00.000Z' } }),
  );
  await page.goto('/ja/create?tab=orders');

  const prompt = page.getByText('受注を見るには、受取ウォレットでサインインしてください。', { exact: true });
  await expect(prompt).toBeVisible();
  // 入口は 1 つ (押すとウォレットの一覧を開く)。
  await expect(page.getByRole('button', { name: 'ウォレットを接続', exact: true })).toHaveCount(1);

  // 受注データの保存の開示は文言のまま、サインインの入口より後に置く。支払いと注文の結びつきは、結びつけられない
  // 注文のカードにだけ注記を出す (常時の技術的な開示文は出さない)。
  const retention = page.getByText(/^受注は決済時に OpenPay サーバへ一時保存され/);
  await expect(retention).toBeVisible();
  await expect(page.getByText(/暗号学的/)).toHaveCount(0);
  const [promptBox, retentionBox] = await Promise.all([prompt.boundingBox(), retention.boundingBox()]);
  expect(promptBox!.y).toBeLessThan(retentionBox!.y);
});
