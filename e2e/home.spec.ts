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
    // JPYC / USDC 店主向け gas 迂回路 (MetaMask Swap) hint。UX 簡潔化で <details>
    // 折り畳みに変更したため、summary (title) は visible、body は user が summary
    // を click して展開後に visible になる。
    const gasHintTitle = page.getByText(
      /ガス代 \(POL \/ ETH\) が無くて取引所に送れないとき/,
    );
    await expect(gasHintTitle).toBeVisible();
    // closed 状態では body は折り畳み内で hidden (新 UX 仕様)
    await expect(
      page.getByText(/Base \/ Arbitrum \/ Optimism は ETH/),
    ).toBeHidden();
    // 展開 → body 露出
    await gasHintTitle.click();
    await expect(
      page.getByText(/Base \/ Arbitrum \/ Optimism は ETH/),
    ).toBeVisible();
    const mmSwapLink = page.getByRole('link', { name: /MetaMask Swap を開く/ });
    await expect(mmSwapLink).toHaveAttribute(
      'href',
      'https://portfolio.metamask.io/swap',
    );
    await expect(mmSwapLink).toHaveAttribute('target', '_blank');
    await expect(mmSwapLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('mobile: Tip widget で ENS (vitalik.eth) 解決後の 0x display も overflow しない (実 bug シナリオ)', async ({
    page,
  }, testInfo) => {
    // ENS mainnet RPC (publicnode) への eth_call を deterministic mock で置換し、
    // CI offline でも常に実行可能にする。実 viem コード (lib/resolveAddress.ts) +
    // wagmi state + AddressInput 描画は本物が走り、network 層だけ canned response。
    test.skip(testInfo.project.name !== 'mobile-safari', 'mobile viewport 専用');

    // Universal Resolver.resolve(name="vitalik.eth", data=addr(node)) の応答。
    // ABI encoding (bytes result, address resolver):
    //   offset(64) || resolver(0x231b0e..8e63) || bytes-length(32) || addr(vitalik)
    // 実値は probe e2e で publicnode から一度キャプチャ済。
    const vitalikEnsResponse =
      '0x0000000000000000000000000000000000000000000000000000000000000040' +
      '000000000000000000000000231b0ee14048e9dccd1d247744d114a4eb5e8e63' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045';

    await page.route('**/*publicnode*/**', async (route) => {
      const body = route.request().postData()
        ? JSON.parse(route.request().postData()!)
        : null;
      if (body?.method === 'eth_call') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: vitalikEnsResponse,
          }),
        });
        return;
      }
      // それ以外 (eth_chainId 等) は素通し。viem 2.x の getEnsAddress は eth_call 1 本のみ。
      await route.continue();
    });

    await page.goto('/ja');
    await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
    await page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/).fill('vitalik.eth');

    await expect(page.getByText(/✓ vitalik\.eth/)).toBeVisible({ timeout: 5_000 });

    const addressSpan = page.getByText(/^0x[a-fA-F0-9]{40}$/).first();
    await expect(addressSpan).toBeVisible();
    // 実 vitalik.eth address が描画されていることを assertion で固定 (mock 妥当性確認)
    await expect(addressSpan).toHaveText(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    );

    // 実 WebKit の computed style で word-break: break-all が効いていることを保証。
    // jsdom では Tailwind 生成 CSS が評価されないため class 名しか見られない。
    const wordBreak = await addressSpan.evaluate(
      (el) => window.getComputedStyle(el).wordBreak,
    );
    expect(wordBreak).toBe('break-all');

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test('mobile: Tip widget で長い 0x アドレス入力後も viewport 横 overflow が出ない', async ({
    page,
  }, testInfo) => {
    // iPhone 14 viewport (390px) で document.scrollWidth ≤ clientWidth を保証。
    // 負 control: min-w-0 を外すと scrollWidth=859 (2.2x overflow) で fail する。
    test.skip(testInfo.project.name !== 'mobile-safari', 'mobile viewport 専用');
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
