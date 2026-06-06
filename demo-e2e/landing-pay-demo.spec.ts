import { test, expect } from '@playwright/test';
import { DEMO_RECEIVER, demoChrome } from './_seed';

// ランディング用デモ③ 支払う (顧客)。QR をスキャンした顧客が見る支払いリクエスト画面を
// 直リンクで提示 (金額・ガス代不要・3ステップ・接続導線)。モック wallet が無いため
// 署名手前まで (正直に「接続して支払う」直前で締める)。
test('支払い(顧客)デモ — スキャン後の支払いリクエスト', async ({ page }) => {
  await page.addInitScript(demoChrome);
  await page.goto(
    `/ja/pay?to=${DEMO_RECEIVER}&token=jpyc&chain=polygon&amount=1000`,
  );
  // 顧客が見る支払いリクエスト (金額が出ていればレンダリング成功)。
  await expect(page.getByText(/1000/).first()).toBeVisible();
  await page.waitForTimeout(1600);

  // 金額 → ステップ → 接続導線 まで見せるため緩やかにスクロール
  // (mobile WebKit は mouse.wheel 非対応なので window.scrollBy を使う)。
  await page.evaluate(() => window.scrollBy({ top: 220, behavior: 'smooth' }));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollBy({ top: 220, behavior: 'smooth' }));
  await page.waitForTimeout(2200);
});
