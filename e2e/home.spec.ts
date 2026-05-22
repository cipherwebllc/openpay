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

  test('ja: offramp gasHint details の toggle が両方向で機能 (open → close → open) + ChevronIcon 実 rotation', async ({
    page,
  }) => {
    // <details> の native toggle が両方向で動くこと + ChevronIcon の回転
    // (group-open:rotate-90) が details[open] と同期して実 computed transform
    // を変えることを確認。close (再 click) で body が再 hide する path は
    // regression が出やすい (例: onClick で setState + preventDefault すると
    // native toggle が壊れる)。chevron transform も assert することで Tailwind の
    // group-open: variant が build で消えた場合の silent UX 劣化を検知。
    await page.goto('/ja');
    const gasHintTitle = page.getByText(
      /ガス代 \(POL \/ ETH\) が無くて取引所に送れないとき/,
    );
    const body = page.getByText(/Base \/ Arbitrum \/ Optimism は ETH/);
    const detailsEl = page.locator('details:has(summary:has-text("ガス代 (POL / ETH)"))');
    // ChevronIcon = summary 内で transition-transform クラスを持つ唯一の SVG。
    // 同 summary 内の GasPumpIcon (width=18) と区別するため class で選択。
    const chevron = detailsEl.locator('summary svg.transition-transform');

    // 初期: closed。chevron は未回転 ("none" もしくは identity matrix)。
    // toHaveCSS は auto-retry でtransform property の安定値を待つため、
    // transition-transform (0.15s) の race を吸収する。
    await expect(body).toBeHidden();
    await expect(detailsEl).not.toHaveAttribute('open', /.*/);
    await expect(chevron).toHaveCSS('transform', /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);

    // 1 度 click → open、body 表示、open 属性付与、chevron 90° 回転
    // 90° 回転後の matrix: matrix(cos90, sin90, -sin90, cos90, 0, 0)
    //   = matrix(0, 1, -1, 0, 0, 0) (CSS の rotate(90deg) 出力)
    await gasHintTitle.click();
    await expect(body).toBeVisible();
    await expect(detailsEl).toHaveAttribute('open', '');
    await expect(chevron).toHaveCSS(
      'transform',
      /matrix\(\s*[\d.eE+-]+,\s*1,\s*-1,\s*[\d.eE+-]+,\s*0,\s*0\s*\)/,
    );

    // 再 click → close、body 再 hidden、open 属性消失、chevron 未回転状態に戻る
    await gasHintTitle.click();
    await expect(body).toBeHidden();
    await expect(detailsEl).not.toHaveAttribute('open', /.*/);
    await expect(chevron).toHaveCSS('transform', /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);

    // 3 度目: 再度 open できる (native details が永続 disabled 化していない)
    await gasHintTitle.click();
    await expect(body).toBeVisible();
    await expect(chevron).toHaveCSS(
      'transform',
      /matrix\(\s*[\d.eE+-]+,\s*1,\s*-1,\s*[\d.eE+-]+,\s*0,\s*0\s*\)/,
    );
  });

  test('ja: offramp の TokenIcon が JPYC と USDC 両 row に SVG として描画される', async ({
    page,
  }) => {
    // inline SVG icon (TokenIcon) は decorative なので aria-hidden で a11y tree
    // から消えるが、DOM 上は token row 各々に <svg> として存在し、glyph (¥/$) を
    // 持つ。SVG 描画失敗 (例: import 漏れ、render error) を検知する。
    await page.goto('/ja');
    const offrampSection = page.locator('section[aria-labelledby="offramp-heading"]');
    // 各 row の text に対する SVG sibling を確認
    const jpycRow = offrampSection
      .locator('li')
      .filter({ hasText: /JPYC を/ });
    const usdcRow = offrampSection
      .locator('li')
      .filter({ hasText: /USDC を/ });
    // SVG が row 内に少なくとも 1 つ存在 (TokenIcon)
    await expect(jpycRow.locator('svg')).toHaveCount(1);
    await expect(usdcRow.locator('svg')).toHaveCount(1);
    // SVG の <text> に通貨記号が入っている
    await expect(jpycRow.locator('svg text')).toHaveText('¥');
    await expect(usdcRow.locator('svg text')).toHaveText('$');
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

  // 3-step UI refactor (2026-05-23): Step 1/2/3 が縦に並んで heading badge を
  // 持つこと、Step 3 (QR) が brand border で prominent に描画されること、
  // 「おすすめ」 badge が gasless option に付くことを e2e で実 browser 描画確認。
  test('ja: Step 1/2/3 の heading badge と Step 3 prominent border が visible', async ({
    page,
  }) => {
    await page.goto('/ja');
    await expect(page.getByRole('heading', { name: '金額' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '受取先' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QR コード' })).toBeVisible();
    // Step 3 は qr-prominent variant の brand border + ring を持つ
    const step3 = page.locator('section[aria-labelledby="step-3-heading"]');
    await expect(step3).toBeVisible();
    const className = await step3.getAttribute('class');
    expect(className).toMatch(/border-brand\/40/);
    expect(className).toMatch(/ring-1/);
  });

  test('ja: 高度な設定 を開くと gasless option に「おすすめ」 badge が出る', async ({
    page,
  }) => {
    await page.goto('/ja');
    // Step 2 が default open (受取先未設定) なので高度な設定 toggle が見える。
    // accordion はデフォルト閉。click で開く。
    const toggle = page.getByRole('button', { name: /高度な設定/ });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // gasless option button に「おすすめ」 badge
    const gaslessBtn = page.getByRole('button', {
      name: /ガスレス決済.*おすすめ/,
    });
    await expect(gaslessBtn).toBeVisible();
  });

  test('ja: Step 1 に token/chain chooser が同居している (顧客ごと変更頻度高)', async ({
    page,
  }) => {
    await page.goto('/ja');
    const step1 = page.locator('section[aria-labelledby="step-1-heading"]');
    await expect(step1).toBeVisible();
    // token (JPYC/USDC) ボタンが Step 1 内
    await expect(
      step1.getByRole('button', { name: /^JPYC\s+Polygon/ }),
    ).toBeVisible();
    await expect(step1.getByRole('button', { name: /^USDC/ })).toBeVisible();
    // USDC click → chain chooser が Step 1 内に出現
    await step1.getByRole('button', { name: /^USDC/ }).click();
    await expect(step1.getByRole('button', { name: /^Base/ })).toBeVisible();
    await expect(
      step1.getByRole('button', { name: /^Arbitrum/ }),
    ).toBeVisible();
  });

  test('ja: Step 2 は collapsible — 受取先入力後に手動で折り畳むと summary が出る', async ({
    page,
  }) => {
    await page.goto('/ja');
    const step2Toggle = page.getByRole('button', { name: /^受取先/ });
    // 初期 (LocalStorage 空) は default open
    await expect(step2Toggle).toHaveAttribute('aria-expanded', 'true');
    // 受取先を入力して toggle を click すると collapsed + summary 表示
    await page
      .getByPlaceholder(/0x\.\.\./)
      .fill('0x52d4901142e2B5680027da5EB47C86CB02a3cA81');
    await step2Toggle.click();
    await expect(step2Toggle).toHaveAttribute('aria-expanded', 'false');
    // collapsed summary に short address (0x52d4…cA81) が出る
    await expect(step2Toggle.getByText(/0x52d4…cA81/)).toBeVisible();
    // 再 click で再展開
    await step2Toggle.click();
    await expect(step2Toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('ja: QR 生成時の Print ボタンは brand color (primary CTA) + Printer アイコン', async ({
    page,
  }) => {
    await page.goto('/ja');
    // 必要項目を入力 → Step 3 で QR + Print ボタンが現れる
    await page
      .getByPlaceholder(/0x\.\.\./)
      .fill('0x52d4901142e2B5680027da5EB47C86CB02a3cA81');
    // amount 入力 (JPYC plain で 750)
    await page.getByPlaceholder('1000').fill('750');
    const printBtn = page.getByRole('button', { name: /印刷/ });
    await expect(printBtn).toBeVisible();
    const className = await printBtn.getAttribute('class');
    expect(className).toMatch(/bg-brand/);
    expect(className).toMatch(/text-white/);
    // Printer icon (lucide) が button 内に存在
    await expect(printBtn.locator('svg')).toHaveCount(1);
  });

  test('ja: Footer poweredBy は soft 文言で表示、技術詳細は <details> 展開で出る', async ({
    page,
  }) => {
    await page.goto('/ja');
    const footer = page.locator('footer');
    // soft 文言 (default visible)
    await expect(
      footer.getByText('Web3 ウォレット決済技術を利用しています'),
    ).toBeVisible();
    // 技術ラベルは default 折り畳まれていて DOM には存在するが <details> 内
    const techDetails = footer.locator(
      'details:has(summary:has-text("Web3 ウォレット決済技術"))',
    );
    await expect(techDetails).not.toHaveAttribute('open', /.*/);
    // 展開
    await techDetails.locator('summary').click();
    await expect(techDetails).toHaveAttribute('open', '');
    await expect(footer.getByText(/ERC-4337/)).toBeVisible();
  });
});
