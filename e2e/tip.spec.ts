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
    // breakdown: Phase 1 (alpha) は決済手数料 0% なので「OpenPay 利用手数料」行は
    // 非表示。creatorRow にはチップ満額 (既定 preset 300、fee 控除なし) が出る。
    // 既定 preset[0]=300 が選択済なので creator 受取 = 300 JPYC。
    const creatorRow = page
      .locator('div.justify-between')
      .filter({ has: page.getByText('クリエイター受取', { exact: true }) });
    await expect(creatorRow).toContainText('300 JPYC');
    await expect(page.getByText('あなたの支払額')).toBeVisible();
    // fee 行 (feeRow) は feeAmount=0 で hide されている (Phase 1 regression fence)
    await expect(page.getByText('OpenPay 利用手数料')).toHaveCount(0);
    // JPYC ガスレス (testnet・forwarder 未設定 = free モード) は OpenPay がガスを全額負担する
    // ため、ネットワーク手数料行は Pimlico fetch 待ちの「見積取得中…」も「最大 N」見積も出さず、
    // 確定文言「無料 (OpenPay が負担)」を即表示する。creator は preset 満額 (300)、ファンの
    // 支払いも preset 満額 (gas 上乗せなし) になる。
    await expect(page.getByText('見積取得中…')).toHaveCount(0);
    await expect(page.getByText('無料 (OpenPay が負担)')).toBeVisible();
    // 未接続なので submit ボタンは t('btnConnect') = 「ウォレットを接続」
    // (isConnected=false のとき btnConnect に倒れる)
    await expect(
      page.getByRole('button', { name: 'ウォレットを接続' }),
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

  test('iframe size (380×640) で LocaleSwitcher + content が overflow しない', async ({
    page,
  }) => {
    // TipEmbedGenerator が生成する iframe は 380×640 で固定 (primary embed UX)。
    // 新規追加の LocaleSwitcher が狭い枠で wrap / overflow を起こさないことを
    // viewport で smoke する。
    await page.setViewportSize({ width: 380, height: 640 });
    await page.goto(`/ja/tip/${TO}?token=jpyc`);
    // LocaleSwitcher が visible + clickable (aria-label = "言語: 日本語" 形式)
    await expect(page.getByRole('button', { name: /日本語/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /English/ })).toBeVisible();
    // 主要 UI も同時に visible (switcher が breakdown を押し下げて隠していない)
    await expect(page.getByRole('button', { name: '300 JPYC' })).toBeVisible();
    // 横 overflow なし
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test('JPYC + Kaia chain: URL から chain name + chain id + preset + 受信状態を解決', async ({
    page,
  }) => {
    // ?chain=kaia を Tip URL に乗せて、TipForm が JPYC@Kaia deployment を解決し、
    // header / preset / breakdown / gas hint まで一貫して render することを確認。
    // 単一 chain name だけでなく以下を全て assert することで「Kaia path が live」と
    // 言える根拠を強化:
    //   1. chain name 文字列 (Kaia or Kairos Testnet)
    //   2. preset 3 個 (JPYC default)
    //   3. breakdown 行 ("あなたの支払額" 等)
    //   4. gas hint info link (Kaia の sponsorship 説明文)
    //   5. submit button (未接続なので Connect 状態)
    //   6. polygon default URL では出ないことの裏返し確認 (chain=kaia の URL のみ
    //      header が Kaia/Kairos になる、default URL では Polygon)
    await page.goto(`/ja/tip/${TO}?token=jpyc&chain=kaia`);
    await expect(page.getByText(/Kaia|Kairos/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '300 JPYC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '1000 JPYC' })).toBeVisible();
    await expect(page.getByRole('button', { name: '3000 JPYC' })).toBeVisible();
    await expect(page.getByText('あなたの支払額')).toBeVisible();
    // Kaia 系も JPYC ガスレス free モード (testnet・forwarder 未設定) → OpenPay 全額負担で
    // 「無料 (OpenPay が負担)」を即表示 (pending なし)。
    await expect(page.getByText('見積取得中…')).toHaveCount(0);
    await expect(page.getByText('無料 (OpenPay が負担)')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'ウォレットを接続' }),
    ).toBeVisible();

    // 裏返し: 同じ URL から chain=kaia を外す → Polygon (default) が出る
    await page.goto(`/ja/tip/${TO}?token=jpyc`);
    await expect(page.getByText(/Polygon/).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/Kairos|Kaia/);
  });

  test('JPYC + 非対応 chain (base/arbitrum/optimism/ethereum) → エラー表示', async ({
    page,
  }) => {
    // URL parser の reject path 4 件を e2e で確認 (cleanup b5ce61e の
    // resolveChainSlugParam + hasDeployment 経路が production で live)。
    for (const chain of ['base', 'arbitrum', 'optimism', 'ethereum']) {
      await page.goto(`/ja/tip/${TO}?token=jpyc&chain=${chain}`);
      await expect(page.getByText(/Tip URL が不正/)).toBeVisible();
    }
  });

  test('USDC + Ethereum L1 → 受理 (2026-05 L1 restore で ERC20 paymaster ガスレス対応)', async ({
    page,
  }) => {
    // 2026-05 に Ethereum L1 を merchant-and-buyer に復帰 (commit 8ecccaa)。USDC@L1 は
    // Pimlico ERC-20 paymaster でガスレス対応になったため Tip でも受理される。
    // (useTipSettings.test.tsx「usdc + ethereum → そのまま保存」と一致。旧 reject
    // 前提の assertion は L1 restore 後に stale 化していたものを修正。)
    await page.goto(`/ja/tip/${TO}?token=usdc&chain=ethereum`);
    await expect(page.getByText(/Tip URL が不正/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '5 USDC' })).toBeVisible();
  });

  test('USDC + crossChain=false: CrossChainHint 非 mount + iframe 380×640 で破綻なし', async ({
    page,
  }) => {
    // iframe 内 (狭い viewport) + crossChain=false 明示 で、CrossChainHint
    // 関連の DOM 要素 (例: SourceChooser 専用 i18n 文字列) が一切現れない
    // ことを negative assertion で確認。「mount されていない」を strict に検証。
    await page.setViewportSize({ width: 380, height: 640 });
    await page.goto(`/ja/tip/${TO}?token=usdc&crossChain=false`);
    await expect(page.getByRole('button', { name: '5 USDC' })).toBeVisible();
    // CrossChainHint / SourceChooser が mount されていないことを、その UI 固有の文言で検証する。
    // ("CCTP" / "Gateway" 単体は footer の技術スタック表記 "CCTP V2" 等に正当に現れるため
    // body 全体への substring 否定は誤検出になる → hint 専用の i18n 文字列で strict に確認する。)
    await expect(page.locator('body')).not.toContainText('支払元チェーンを選ぶ'); // SourceChooser.title
    await expect(page.locator('body')).not.toContainText('選択したチェーンで支払う'); // CrossChainHint.payWithSelected
    // 横 overflow なし
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test('USDC + crossChain=true (default): 未接続でも hint 関連の i18n 文字列は出ない', async ({
    page,
  }) => {
    // crossChain default ON でも、wallet 未接続なら CrossChainHint は mount
    // 条件を満たさない (`address` gate)。Hint UI が漏れ出ていないことを確認、
    // creator が embed した時 fan が見る初期画面が壊れないこと invariant。
    await page.goto(`/ja/tip/${TO}?token=usdc`);
    await expect(page.getByRole('button', { name: '5 USDC' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('支払元チェーン');
    await expect(page.locator('body')).not.toContainText('選択したチェーンで支払う');
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
