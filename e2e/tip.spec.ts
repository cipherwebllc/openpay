import { test, expect } from '@playwright/test';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

test.describe('/tip/[address] (creator tip widget)', () => {
  test('最小 URL → preset ボタン + breakdown + 接続待ち UI', async ({ page }) => {
    await page.goto(`/ja/tip/${TO}?token=jpyc`);
    // <title>OpenPay Tip</title> も match するため main 配下に scope する
    await expect(page.locator('main').getByText('OpenPay Tip')).toBeVisible();
    // 既定 preset (DEFAULT_TIP_PRESETS.jpyc = ['300','1000','3000'])
    await expect(page.getByRole('button', { name: '300 JPYC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '1000 JPYC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '3000 JPYC' })).toBeVisible();
    // breakdown: 運営手数料は店主負担で顧客は preset そのまま (gas は未接続/見積前で 0)
    // 「あなたの支払額」 + 「300 JPYC」が breakdown 行に表示される
    await expect(page.getByText('あなたの支払額')).toBeVisible();
    // gas 行は Pimlico API が未呼出なので「見積取得中…」が表示
    await expect(page.getByText('見積取得中…')).toBeVisible();
    // 未接続なので submit ボタンは t('btnConnect') = 「ウォレットを接続してください」
    // (TipForm.tsx 388-400 行: isConnected=false のとき btnConnect に倒れる)
    await expect(
      page.getByRole('button', { name: 'ウォレットを接続してください' }),
    ).toBeVisible();
  });

  test('全パラメータ付き URL (ja) → カスタム表示反映', async ({ page }) => {
    // /tip/... では middleware が Accept-Language で locale を選ぶため
    // 日本語アサーションを使うこのテストは明示的に /ja を指定する
    await page.goto(
      `/ja/tip/${TO}?token=jpyc&name=%E5%B1%B1%E7%94%B0%E5%A4%AA%E9%83%8E&message=hi&color=%23ff0080&preset=200,800`,
    );
    await expect(page.getByText('山田太郎 さんへチップを送る')).toBeVisible();
    await expect(page.getByText('hi')).toBeVisible();
    await expect(page.getByRole('button', { name: '200 JPYC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '800 JPYC' })).toBeVisible();
  });

  test('USDC + 既定 preset (5/20/50)', async ({ page }) => {
    await page.goto(`/ja/tip/${TO}?token=usdc`);
    await expect(page.getByRole('button', { name: '5 USDC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '20 USDC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '50 USDC' })).toBeVisible();
  });

  test('不正 URL (token なし) → エラー表示', async ({ page }) => {
    await page.goto(`/ja/tip/${TO}`);
    await expect(page.getByText(/Tip URL が不正/)).toBeVisible();
  });

  test('英語ロケール (/en/tip) でも動作', async ({ page }) => {
    await page.goto(`/en/tip/${TO}?token=jpyc`);
    // <title>OpenPay Tip</title> も match するため main 配下に scope する
    await expect(page.locator('main').getByText('OpenPay Tip')).toBeVisible();
    await expect(page.getByText('Send a tip to the creator')).toBeVisible();
    // 英語版 breakdown: customerRow = "You pay"
    await expect(page.getByText('You pay')).toBeVisible();
    // 未接続 → submit ボタンは "Connect a wallet"
    await expect(
      page.getByRole('button', { name: 'Connect a wallet' }),
    ).toBeVisible();
  });
});
