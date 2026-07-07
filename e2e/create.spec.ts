import { test, expect, type Page, type Locator } from '@playwright/test';

// hydration race 対策: 低速な webkit (mobile-safari) や負荷の高い CI runner では controlled input
// への fill が React hydration より前に走ると値が捨てられ、settings 更新 → localStorage 書込が起きず
// 後続の waitForFunction/summary が 30s timeout する。fill 後に値の定着を確認し、消えていれば再 fill
// する (toPass の retry ループ自体が hydration 待ちを兼ねる)。test-only の安定化 (本番コード非変更)。
// timeout は 15s: /create は複数ビルダー (QR/レジ/モバイル注文/プロフ) を静的 import するため初期
// hydration が重く、負荷時に 8s を超えて稀に flaky だった (値が定着するまで窓を広げて吸収)。
async function fillStable(locator: Locator, value: string) {
  await expect(locator).toBeVisible();
  await expect(async () => {
    if ((await locator.inputValue()) !== value) await locator.fill(value);
    expect(await locator.inputValue()).toBe(value);
  }).toPass({ timeout: 15000 });
}

// 受取先入力欄を hydration-safe に埋める shorthand。
function receiverInput(page: Page): Locator {
  return page.getByPlaceholder(/0x\.\.\./);
}

test.describe('create /create (QR generator + Tip widget tab)', () => {
  test('default タブは決済 QR、QrGenerator が表示される', async ({ page }) => {
    await page.goto('/ja/create');
    await expect(
      page.getByRole('heading', { name: 'OpenPay' }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '決済QR' }),
    ).toBeVisible();
    // 金額モードのタブ (QrGenerator 内)
    await expect(page.getByRole('button', { name: '金額指定' })).toBeVisible();
  });

  test('Tip widget タブに切り替えると TipEmbedGenerator が表示', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    await page.getByRole('button', { name: 'チップ' }).click();
    await expect(
      page.getByRole('heading', { name: /応援を受け取る Tip widget を作成/ }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/),
    ).toBeVisible();
  });

  test('受取アドレス入力 → URL と iframe スニペットが生成される', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    await page.getByRole('button', { name: 'チップ' }).click();
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
    // iframe スニペットは「サイトに埋め込む」タブを開くと出る (default は共有リンク)
    await page.getByRole('tab', { name: 'サイトに埋め込む' }).click();
    await expect(page.getByText(/width="380"/)).toBeVisible();
  });

  test('英語ロケール (/en) でも UI が描画される', async ({ page }) => {
    await page.goto('/en/create');
    await expect(
      page.getByRole('button', { name: 'Payment QR' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Tip', exact: true }),
    ).toBeVisible();
  });

  test('ja: offramp セクションに JPYC EX / SBI VC トレード のリンクが正しい href で描画される', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    const offrampHeading = page.getByRole('heading', {
      name: '受け取った通貨を換金',
    });
    await expect(offrampHeading).toBeVisible();
    const jpycLink = page.getByRole('link', { name: /JPYC EX/ });
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

  test('ja: offramp gasHint details の toggle が両方向で機能 (open → close → open) + ChevronIcon rotation', async ({
    page,
    browserName,
  }) => {
    // <details> の native toggle が両方向で動くこと (open / close / 再 open) を両ブラウザで検証。
    // close (再 click) で body が再 hide する path は regression が出やすい (例: onClick で
    // setState + preventDefault すると native toggle が壊れる)。
    //
    // ChevronIcon の回転 (group-open:rotate-90) は computed transform で検証するが **chromium のみ**。
    // WebKit (mobile-safari) は inline SVG の getComputedStyle().transform が適用済みでも "none" を返す
    // ことがある既知の非互換で、値が不安定なため (旧テストの flaky 真因)。回転 variant が build で
    // purge された場合の silent UX 劣化検知は chromium 側で担保する (機能=開閉自体は両ブラウザで担保)。
    await page.goto('/ja/create');
    const gasHintTitle = page.getByText(
      /ガス代 \(POL \/ ETH\) が無くて取引所に送れないとき/,
    );
    const body = page.getByText(/Base \/ Arbitrum \/ Optimism は ETH/);
    const detailsEl = page.locator('details:has(summary:has-text("ガス代 (POL / ETH)"))');
    // ChevronIcon = summary 内で transition-transform クラスを持つ唯一の SVG。
    // 同 summary 内の GasPumpIcon (width=18) と区別するため class で選択。
    const chevron = detailsEl.locator('summary svg.transition-transform');
    const IDENTITY = /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/;
    const onChromium = browserName === 'chromium';

    // 初期: closed (chevron 未回転 = identity)。
    await expect(body).toBeHidden();
    await expect(detailsEl).not.toHaveAttribute('open', /.*/);
    if (onChromium) await expect(chevron).toHaveCSS('transform', IDENTITY);

    // 1 度 click → open、body 表示、open 属性付与、chevron 回転 (identity 以外)。
    await gasHintTitle.click();
    await expect(body).toBeVisible();
    await expect(detailsEl).toHaveAttribute('open', '');
    if (onChromium) await expect(chevron).not.toHaveCSS('transform', IDENTITY);

    // 再 click → close、body 再 hidden、open 属性消失、chevron 未回転へ戻る。
    await gasHintTitle.click();
    await expect(body).toBeHidden();
    await expect(detailsEl).not.toHaveAttribute('open', /.*/);
    if (onChromium) await expect(chevron).toHaveCSS('transform', IDENTITY);

    // 3 度目: 再度 open できる (native details が永続 disabled 化していない)。
    await gasHintTitle.click();
    await expect(body).toBeVisible();
    if (onChromium) await expect(chevron).not.toHaveCSS('transform', IDENTITY);
  });

  test('ja: offramp の TokenIcon が JPYC と USDC 両 row に SVG として描画される', async ({
    page,
  }) => {
    // inline SVG icon (TokenIcon) は decorative なので aria-hidden で a11y tree
    // から消えるが、DOM 上は token row 各々に <svg> として存在し、glyph (¥/$) を
    // 持つ。SVG 描画失敗 (例: import 漏れ、render error) を検知する。
    await page.goto('/ja/create');
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

    await page.goto('/ja/create');
    await page.getByRole('button', { name: 'チップ' }).click();
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
    await page.goto('/ja/create');
    await page.getByRole('button', { name: 'チップ' }).click();
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

  test('en: offramp セクションは Coinbase + JPYC EX、注記/ヒントが両方出る', async ({
    page,
  }) => {
    await page.goto('/en/create');
    await expect(
      page.getByRole('heading', { name: 'Off-ramp received tokens' }),
    ).toBeVisible();
    const jpycLink = page.getByRole('link', { name: /JPYC EX/ });
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
    await page.goto('/ja/create');
    await expect(page.getByRole('heading', { name: '金額' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '受取先' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QR コード' })).toBeVisible();
    // Step 3 は qr-prominent variant の brand border + ring を持つ
    const step3 = page.locator('section[aria-labelledby="step-3-heading"]');
    await expect(step3).toBeVisible();
    const className = await step3.getAttribute('class');
    expect(className).toMatch(/ring-brand\/25/);
    expect(className).toMatch(/ring-1/);
  });

  test('ja: 高度な設定 を開くと gasless option に「おすすめ」 badge が出る', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    // Step 2 が default open (受取先未設定) なので高度な設定 toggle が見える。
    // accordion はデフォルト閉。click で開く。
    const toggle = page.getByRole('button', { name: /高度な設定/ });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // gasless option button に「おすすめ」 badge。タイトルは payModeGaslessTitle=「ガス代不要」
    // (旧「ガスレス決済」から短縮)、badge は payModeGaslessBadge=「おすすめ」。
    const gaslessBtn = page.getByRole('button', {
      name: /ガス代不要.*おすすめ/,
    });
    await expect(gaslessBtn).toBeVisible();
  });

  test('ja: Step 1 に token/chain chooser が同居 (JPYC は Polygon/Kaia、USDC は 5 chain)', async ({
    page,
  }) => {
    // 2026-05-23 JPYC Kaia 対応で JPYC も multi-chain 化。
    // phase 4a で USDC は Ethereum L1 追加 (4 → 5 chain)。
    await page.goto('/ja/create');
    const step1 = page.locator('section[aria-labelledby="step-1-heading"]');
    await expect(step1).toBeVisible();
    // token (JPYC/USDC) ボタンが Step 1 内、JPYC は multi-chain hint
    await expect(step1.getByRole('button', { name: /^JPYC$/ })).toBeVisible();
    await expect(step1.getByRole('button', { name: /^USDC/ })).toBeVisible();
    // JPYC default → chain chooser に Polygon / Kaia 2 つ
    await expect(step1.getByRole('button', { name: /^Polygon/ })).toBeVisible();
    await expect(step1.getByRole('button', { name: /^Kai/ })).toBeVisible();
    // USDC click → chain chooser が USDC 5 chain に切替
    await step1.getByRole('button', { name: /^USDC/ }).click();
    await expect(step1.getByRole('button', { name: /^Base/ })).toBeVisible();
    await expect(
      step1.getByRole('button', { name: /^Arbitrum/ }),
    ).toBeVisible();
    // Ethereum L1 — testnet env では "Sepolia"
    await expect(
      step1.getByRole('button', { name: /^(Sepolia|Ethereum)/ }),
    ).toBeVisible();
    // Kaia は USDC では消える (USDC は Kaia 未対応)
    await expect(step1.getByRole('button', { name: /^Kai/ })).toHaveCount(0);
  });

  test('ja: JPYC + Kaia 選択 → URL に chain=kaia が含まれる', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    const step1 = page.locator('section[aria-labelledby="step-1-heading"]');
    // JPYC は default、Kaia chain button を click
    await step1.getByRole('button', { name: /^Kai/ }).click();
    // 受取先 + amount を入力 (Step 2 で receiver、Step 1 で amount)
    await fillStable(
      receiverInput(page),
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
    // 金額入力 (main amount)。quick-amount 編集欄の placeholder「例: 1000」と区別するため exact。
    await page.getByPlaceholder('1000', { exact: true }).fill('500');
    // QR URL は即時表示せず「QRコードを表示する」→ 全画面 QrPreviewModal 内に表示される
    // (UX 簡潔化で QR/URL/印刷をモーダルへ集約)。desktop は右サイドバー、mobile は下部固定バーの
    // ボタン (どちらも同じ label) を押してモーダルを開く。
    await page
      .getByRole('button', { name: 'QRコードを表示する' })
      .first()
      .click();
    // モーダル (role=dialog) 内の URL 表示 box に query が焼き込まれている。
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const urlBox = dialog.locator('.font-mono.bg-slate-50').first();
    await expect(urlBox).toBeVisible();
    await expect(urlBox).toContainText('chain=kaia');
    await expect(urlBox).toContainText('token=jpyc');
    await expect(urlBox).toContainText('amount=500');
  });

  test('ja: Step 2 は collapsible — 受取先入力後に手動で折り畳むと summary が出る', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    const step2Toggle = page.getByRole('button', { name: /^受取先/ });
    // 初期 (LocalStorage 空) は default open
    await expect(step2Toggle).toHaveAttribute('aria-expanded', 'true');
    // 受取先を入力して toggle を click すると collapsed + summary 表示
    await fillStable(
      receiverInput(page),
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
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
    await page.goto('/ja/create');
    // 必要項目を入力 → Step 3 で QR + Print ボタンが現れる
    await fillStable(
      receiverInput(page),
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
    // amount 入力 (JPYC plain で 750)。quick-amount 編集欄「例: 1000」と区別するため exact。
    await page.getByPlaceholder('1000', { exact: true }).fill('750');
    // QR / 印刷ボタンは「QRコードを表示する」→ 全画面 QrPreviewModal に集約済み。先にモーダルを開く。
    await page
      .getByRole('button', { name: 'QRコードを表示する' })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // モーダル内の印刷ボタン (primary CTA)。
    const printBtn = dialog.getByRole('button', { name: /印刷/ });
    await expect(printBtn).toBeVisible();
    // toHaveClass は auto-retry するため、webkit の CSS/レンダリング遅延でも安定する
    // (一発読みの getAttribute は class 適用前に評価され flake する)。
    await expect(printBtn).toHaveClass(/bg-brand/);
    await expect(printBtn).toHaveClass(/text-white/);
    // Printer icon (lucide) が button 内に存在
    await expect(printBtn.locator('svg')).toHaveCount(1);
  });

  test('ja: Footer poweredBy は soft 文言で表示、技術詳細は <details> 展開で出る', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    const footer = page.locator('footer');
    // soft 文言 (default visible)
    await expect(
      footer.getByText('ステーブルコイン決済技術を利用しています'),
    ).toBeVisible();
    // 技術ラベルは default 折り畳まれていて DOM には存在するが <details> 内
    const techDetails = footer.locator(
      'details:has(summary:has-text("ステーブルコイン決済技術"))',
    );
    await expect(techDetails).not.toHaveAttribute('open', /.*/);
    // 展開
    await techDetails.locator('summary').click();
    await expect(techDetails).toHaveAttribute('open', '');
    await expect(footer.getByText(/ERC-4337/)).toBeVisible();
  });

  // a11y: collapsible Step 2 のキーボード操作 + focus 維持。実 browser の native
  // button semantics ([Enter] / [Space] 両対応) を保証 (jsdom では keyboard
  // 経由の click 発火を要 manual dispatch、e2e でしか実 OS イベント無理)。
  test('ja: Step 2 toggle は Enter / Space キーで開閉できる (a11y)', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    const toggle = page.getByRole('button', { name: /^受取先/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // 受取先を入力 (これで初期 state は確定し、以降は手動 toggle のみ)
    await fillStable(
      receiverInput(page),
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
    // focus → Enter で close
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Space で open
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // focus は toggle 上に保持 (キーボード操作のみで完結)
    const isFocused = await toggle.evaluate((el) => el === document.activeElement);
    expect(isFocused).toBe(true);
  });

  // ChevronDown の rotation は computed CSS で実測 (transition の race を吸収
  // する toHaveCSS auto-retry 経由)。jsdom では style 計算が乏しいので e2e 必須。
  test('ja: Step 2 toggle の ChevronDown は open/close で実 CSS transform が変わる', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    const toggle = page.getByRole('button', { name: /^受取先/ });
    // closed → chevron は未 rotate (matrix identity or none)
    await fillStable(
      receiverInput(page),
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const chevron = toggle.locator('svg.transition-transform');
    // closed 状態: rotate-180 class が剥がれた状態の matrix
    await expect(chevron).toHaveCSS(
      'transform',
      /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/,
    );
    // open → 180° rotate → matrix(-1, 0, 0, -1, 0, 0) (cosθ=-1, sinθ≈0)
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(chevron).toHaveCSS(
      'transform',
      /matrix\(\s*-1,\s*[\d.eE+-]+,\s*[\d.eE+-]+,\s*-1,\s*0,\s*0\s*\)/,
    );
  });

  // localStorage の persistence: 入力 → reload → 受取先 default 閉が再現される
  // ことを実 browser で検証 (useQrSettings + useEffect の hydrate 経路全体)。
  test('ja: 高度な設定 summary は日本語文 + 旧 mono/手数料% トークンが見えない', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    // Phase 1: default 状態 (gasless + customer) の closed summary は手数料% を
    // 含まず「ガスレス決済 / ガス代：お客様負担」のみ。
    const toggle = page.getByRole('button', { name: /高度な設定/ });
    await expect(toggle).toBeVisible();
    await expect(
      toggle.getByText(/ガスレス決済 \/ ガス代：お客様負担/),
    ).toBeVisible();
    // 旧 mono サマリ + Phase 1 で撤去した手数料% (1.0%/0.5%) は DOM 全体に存在しない
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(/1%\/gas:cust|0\.5%\/std|gas:merch/);
    expect(bodyText).not.toMatch(/手数料 1\.0%|手数料 0\.5%/);
  });

  test('ja: 手数料徴収先アドレス section は Phase 1 で撤去 (高度な設定 開でも非表示)', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    // Phase 1 (決済手数料 0%) で QrGenerator から fee 徴収先 section を撤去済。
    // default でも、高度な設定を開いた後でも「OpenPay 利用手数料の徴収先」は出ない。
    await expect(
      page.getByText(/OpenPay 利用手数料の徴収先/),
    ).toHaveCount(0);
    await page.getByRole('button', { name: /高度な設定/ }).click();
    // 開いた後も復活しない
    await expect(
      page.getByText(/OpenPay 利用手数料の徴収先/),
    ).toHaveCount(0);
  });

  test('ja: 受取先入力 → reload → Step 2 が default 折り畳まれる (returning user)', async ({
    page,
  }) => {
    await page.goto('/ja/create');
    await fillStable(
      receiverInput(page),
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
    // 設定が localStorage に保存されるまで待機 (useQrSettings の debounce 後)
    await page.waitForFunction(() => {
      const raw = window.localStorage.getItem('openpay:qr-settings:v2');
      return raw !== null && JSON.parse(raw).receiver.length > 0;
    });
    // page reload
    await page.reload();
    // reload 後 Step 2 は default closed + summary に short address
    const toggle = page.getByRole('button', { name: /^受取先/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle.getByText(/0x52d4…cA81/)).toBeVisible();
  });
});
