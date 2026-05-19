import { test, expect } from '@playwright/test';

test.describe('home / (QR generator + Tip widget tab)', () => {
  test('default タブは決済 QR、QrGenerator が表示される', async ({ page }) => {
    await page.goto('/ja');
    await expect(
      page.getByRole('heading', { name: 'OpenPay' }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '決済 QR (店舗)' }),
    ).toBeVisible();
    // 金額モードのタブ (QrGenerator 内)
    await expect(page.getByRole('button', { name: '金額指定' })).toBeVisible();
  });

  test('Tip widget タブに切り替えると TipEmbedGenerator が表示', async ({
    page,
  }) => {
    await page.goto('/ja');
    await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
    await expect(
      page.getByRole('heading', { name: /Tip widget 埋め込みコードを生成/ }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/),
    ).toBeVisible();
  });

  test('受取アドレス入力 → URL と iframe スニペットが生成される', async ({
    page,
  }) => {
    await page.goto('/ja');
    await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
    const addressInput = page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/);
    await addressInput.fill(
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
    // 生成 URL は origin + /tip/0x...?token=jpyc。locale prefix は middleware
    // が動的に付与するため埋め込み URL 自体には含まれない (iframe を貼った
    // ページ訪問者の Accept-Language で /ja か /en に redirect される)。
    await expect(
      page
        .locator('div')
        .filter({
          hasText:
            /\/tip\/0x52d4901142e2B5680027da5EB47C86CB02a3cA81\?token=jpyc/,
        })
        .first(),
    ).toBeVisible();
    // iframe スニペットには <iframe + width="380" が出る
    await expect(page.getByText(/width="380"/)).toBeVisible();
  });

  test('英語ロケール (/en) でも UI が描画される', async ({ page }) => {
    await page.goto('/en');
    await expect(
      page.getByRole('button', { name: 'Payment QR (merchant)' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Tip widget (creator)' }),
    ).toBeVisible();
  });

  test('ja: offramp セクションに JPYC 公式 / SBI VC トレード のリンクが正しい href で描画される', async ({
    page,
  }) => {
    await page.goto('/ja');
    const offrampHeading = page.getByRole('heading', {
      name: '受け取った通貨を換金',
    });
    await expect(offrampHeading).toBeVisible();
    const jpycLink = page.getByRole('link', { name: /JPYC 公式/ });
    await expect(jpycLink).toHaveAttribute('href', 'https://jpyc.co.jp/');
    await expect(jpycLink).toHaveAttribute('target', '_blank');
    await expect(jpycLink).toHaveAttribute('rel', 'noopener noreferrer');
    const sbiLink = page.getByRole('link', { name: /SBI VC トレード/ });
    await expect(sbiLink).toHaveAttribute('href', 'https://www.sbivc.co.jp/');
    // ja では Japan residents only / locale switch ヒントは出ない
    await expect(page.getByText(/日本居住者のみ/)).toHaveCount(0);
  });

  test('mobile: Tip widget で ENS (vitalik.eth) 解決後の 0x display も overflow しない (実 bug シナリオ)', async ({
    page,
  }, testInfo) => {
    // 報告された元の症状そのもの:「ENS を入力すると下のアドレスが改行されずに
    // 突き抜ける」を実機 viewport で再現検証。useResolveAddress は viem 経由で
    // ethereum-rpc.publicnode.com に eth_call を投げる。publicnode が unreachable
    // な環境では test.skip して全体を落とさない (CI offline 配慮)。
    test.skip(
      testInfo.project.name !== 'mobile-safari',
      '横 overflow は mobile viewport でのみ視覚的バグになるため mobile-safari でのみ実行',
    );
    await page.goto('/ja');
    await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
    const addressInput = page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/);
    await addressInput.fill('vitalik.eth');

    // 解決完了 (✓ プレフィックス + 0x address が同じ <p> に並ぶ) を待つ。
    // 10s 以内に成功表示が出なければ RPC unreachable と判定して skip。
    const resolvedLine = page.getByText(/✓ vitalik\.eth/);
    const resolved = await resolvedLine
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(
      !resolved,
      'ENS mainnet RPC (publicnode) 到達不能でこのテストを skip',
    );

    // 解決済 address (0x で始まる 42 字) が同一 <p> 内に visible なことを保証
    const addressSpan = page.getByText(/^0x[a-fA-F0-9]{40}$/).first();
    await expect(addressSpan).toBeVisible();

    // jsdom では Tailwind の生成 CSS が解釈されず class 名検証しかできない。
    // 実 browser (mobile-safari engine) で getComputedStyle 経由で word-break
    // が break-all として効いていることを assert。Tailwind config が壊れたり、
    // CSS purge が誤動作した場合に検出する。
    const wordBreak = await addressSpan.evaluate(
      (el) => window.getComputedStyle(el).wordBreak,
    );
    expect(wordBreak).toBe('break-all');

    // viewport 横 overflow チェック (元 bug の本丸)
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test('mobile: Tip widget で長い 0x アドレス入力後も viewport 横 overflow が出ない', async ({
    page,
  }, testInfo) => {
    // 報告された regression の実機検証:「ENS / 0x を入力すると下のアドレス + URL が
    // スマホ画面を突き抜ける」。mobile-safari project (iPhone 14, 390px viewport)
    // で document.documentElement.scrollWidth <= clientWidth を保証する。
    // chromium (desktop 1280) では常に余裕があるため意味が薄いので skip。
    test.skip(
      testInfo.project.name !== 'mobile-safari',
      '横 overflow は mobile viewport でのみ視覚的バグになるため mobile-safari でのみ実行',
    );
    await page.goto('/ja');
    await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
    const addressInput = page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/);
    await addressInput.fill('0x52d4901142e2B5680027da5EB47C86CB02a3cA81');

    // tip URL が描画されるまで待機 (生成完了の signal)
    await expect(
      page.getByText(/\/tip\/0x52d4901142e2B5680027da5EB47C86CB02a3cA81/).first(),
    ).toBeVisible();

    // 実機の viewport より document の scrollWidth が大きいと右にはみ出している
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test('en: offramp セクションは Coinbase + JPYC official、注記/ヒントが両方出る', async ({
    page,
  }) => {
    await page.goto('/en');
    await expect(
      page.getByRole('heading', { name: 'Off-ramp received tokens' }),
    ).toBeVisible();
    const jpycLink = page.getByRole('link', { name: /JPYC official/ });
    await expect(jpycLink).toHaveAttribute('href', 'https://jpyc.co.jp/');
    await expect(page.getByText('(Japan residents only)')).toBeVisible();
    const coinbaseLink = page.getByRole('link', { name: /Coinbase/ });
    await expect(coinbaseLink).toHaveAttribute(
      'href',
      'https://www.coinbase.com/',
    );
    await expect(
      page.getByText(/Japan residents: switch to Japanese for SBI VC Trade/),
    ).toBeVisible();
  });
});
