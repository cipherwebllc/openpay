import { test, expect, type Page } from '@playwright/test';

// home の Tip widget タブ (TipEmbedGenerator) のクリエイター向け UX を実 browser で smoke。
// /tip/[address] 消費側 (tip.spec.ts) とは別。生成側の再構成 (Step1/2/3・公開2択・
// 開発者向け折りたたみ・プリセット編集 UI・プレビュー位置) を検証する。
const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

async function openTipTab(page: Page) {
  await page.goto('/ja/create');
  await page.getByRole('button', { name: 'Tip widget (クリエイター)' }).click();
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

    // USDC に切替 → プリセット chip が USDC 既定 (5/20/50) に変わる (JPYC と連動しない)
    await page.getByRole('button', { name: /^USDC/ }).click();
    await expect(page.getByPlaceholder('例: 1000').nth(0)).toHaveValue('5');
  });

  test('プレビューがクリエイター向けに表示される (見出し + 既定プリセット)', async ({
    page,
  }) => {
    await openTipTab(page);
    await expect(page.getByText('プレビュー')).toBeVisible();
    // プレビュー内に既定プリセット (300 JPYC) が chip 表示
    await expect(page.getByText('300 JPYC')).toBeVisible();
  });
});
