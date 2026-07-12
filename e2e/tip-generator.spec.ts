import { test, expect, type Page } from '@playwright/test';

// home の Tip widget タブ (TipEmbedGenerator) のクリエイター向け UX を実 browser で smoke。
// /tip/[address] 消費側 (tip.spec.ts) とは別。生成側の再構成 (Step1/2/3・公開2択・
// 開発者向け折りたたみ・プリセット編集 UI・プレビュー位置) を検証する。
const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

async function openTipTab(page: Page) {
  await page.goto('/ja/create');
  // タブラベルは短縮済み (旧「Tip widget (クリエイター)」→「チップ」)。
  await page.getByRole('button', { name: 'チップ' }).click();
  await expect(
    page.getByRole('heading', { name: /応援を受け取る Tip widget を作成/ }),
  ).toBeVisible();
}

test.describe('Tip widget generator (creator UX)', () => {
  test('公開は default リンク共有、サイト埋め込みタブで iframe に切替', async ({
    page,
  }) => {
    await openTipTab(page);
    await page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/).fill(TO);

    // share タブ (default): Tip URL 見出し + URL 本文
    await expect(page.getByRole('heading', { name: 'Tip URL' })).toBeVisible();
    await expect(page.getByText(new RegExp(`/tip/${TO}`)).first()).toBeVisible();

    // embed タブへ → iframe snippet が出て URL 見出しは消える
    await page.getByRole('tab', { name: 'サイトに埋め込む' }).click();
    await expect(page.getByText(/<iframe/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tip URL' })).toHaveCount(0);
  });

  test('開発者向け設定は default 閉、開くと webhook 入力が出る', async ({
    page,
  }) => {
    await openTipTab(page);
    const toggle = page.getByRole('button', { name: /開発者向け設定/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(
      page.getByPlaceholder(/discord\.com\/api\/webhooks/),
    ).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page.getByPlaceholder(/discord\.com\/api\/webhooks/),
    ).toBeVisible();
  });

  test('プリセット編集 → URL に preset= 反映、token 切替で独立リスト', async ({
    page,
  }) => {
    await openTipTab(page);
    await page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/).fill(TO);

    const presetInputs = page.getByPlaceholder('例: 1000');
    await expect(presetInputs).toHaveCount(3);
    await presetInputs.nth(0).fill('777');
    await expect(page.getByText(/preset=777/).first()).toBeVisible();

    const labelInputs = page.getByPlaceholder('☕ コーヒー1杯');
    await expect(labelInputs).toHaveCount(3);
    await labelInputs.nth(0).fill('☕ コーヒー1杯');
    await expect(page.getByText(/preset=777%7C/).first()).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: '☕ コーヒー1杯 777 JPYC',
        exact: true,
      }),
    ).toBeVisible();

    // USDC に切替 → プリセット chip が USDC 既定 (5/20/50) に変わる (JPYC と連動しない)
    await page.getByRole('button', { name: /^USDC/ }).click();
    await expect(page.getByPlaceholder('例: 1000').nth(0)).toHaveValue('5');
  });

  test('受取先入力 → reload で Step1 折りたたみ、変更で入力値を保ったまま展開', async ({
    page,
  }) => {
    await openTipTab(page);
    const receiver = page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/);
    await receiver.fill(TO);
    await page.waitForFunction(() => {
      const raw = window.localStorage.getItem('openpay:tip-settings:v2');
      return raw !== null && JSON.parse(raw).receiver.length > 0;
    });

    await page.reload();
    await page.getByRole('button', { name: 'チップ' }).click();
    // toggle の accessible name は折りたたみ中のみ summary (アドレス+変更) を含む。
    // 展開すると「受取先」だけに戻るため、両状態で一致する ^受取先 で特定する。
    const toggle = page.getByRole('button', { name: /^受取先/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('0x52d4…cA81');
    await expect(toggle).toContainText('変更');
    await expect(receiver).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/),
    ).toHaveValue(TO);
  });

  test('リンク共有はコピー主 CTA + QR/X/新しいタブのセカンダリ行', async ({
    page,
  }) => {
    await openTipTab(page);
    await page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/).fill(TO);

    const primary = page.getByTestId('tip-copy-primary');
    await expect(primary).toHaveText('リンクをコピー');
    await expect(primary).toHaveClass(/bg-brand/);
    const secondary = page.getByTestId('tip-share-secondary');
    await expect(
      secondary.getByRole('button', { name: 'QR', exact: true }),
    ).toBeVisible();
    await expect(
      secondary.getByRole('link', { name: 'X シェア', exact: true }),
    ).toBeVisible();
    await expect(
      secondary.getByRole('link', { name: '新しいタブ', exact: true }),
    ).toBeVisible();
  });

  test('プレビューがクリエイター向けに表示される (見出し + 既定プリセット)', async ({
    page,
  }) => {
    await openTipTab(page);
    await expect(page.getByText('プレビュー')).toBeVisible();
    // プレビュー (実 TipForm) 内に既定プリセット (300 JPYC) が金額 pill として表示。
    // 実 TipForm 化で明細 dd にも同文言が出るため button role に scope し、さらに
    // exact 指定にする — role name は部分一致のため送信ボタン「300 JPYC を送る」にも当たる
    // (CI 最小 env はガス無料でラベルが 300 のまま・ローカル recover ON は 302 になる env 差)。
    await expect(
      page.getByRole('button', { name: '300 JPYC', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/チップの受け取りに手数料はかかりません/),
    ).toBeVisible();
  });

  test('テーマ選択が実 TipForm プレビューと URL に即時反映', async ({ page }) => {
    await openTipTab(page);
    await page.getByPlaceholder(/0x\.\.\. または vitalik\.eth/).fill(TO);
    await page.getByRole('button', { name: 'Night' }).click();

    const frame = page.getByTestId('tip-preview-frame');
    await expect(frame.locator('[data-tip-preview="true"]')).toBeVisible();
    await expect(frame.locator('[data-tip-theme="night"]')).toBeVisible();
    await expect(page.getByText(/theme=night/).first()).toBeVisible();
  });

  test('mobile は Step1 → Step2 → プレビュー → 高度な設定 → Step3、設定は USDC のみ', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTipTab(page);

    await expect(
      page.getByRole('button', { name: /高度な設定/ }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: /^USDC/ }).click();

    const items = [
      page.getByRole('heading', { name: '受取先' }),
      page.getByRole('heading', { name: '表示をカスタマイズ' }),
      page.getByRole('heading', { name: 'プレビュー' }),
      page.getByRole('button', { name: /高度な設定/ }),
      page.getByRole('heading', { name: '公開する' }),
    ];
    const positions = await Promise.all(
      items.map(async (item) => (await item.boundingBox())?.y ?? -1),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    await items[3].click();
    await expect(page.getByText('決済方法')).toHaveCount(0);
    await expect(
      page.getByRole('checkbox', { name: /他チェーンからの tip を許可/ }),
    ).toBeVisible();
  });
});
