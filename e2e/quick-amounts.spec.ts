import { test, expect, type Page } from '@playwright/test';

// 「高度な設定 > レジ用クイック金額」が token (JPYC=円 / USDC=ドル) ごとに
// 独立していること、旧 schema (単一 array 共有) からの migration が正しいことを
// 実 browser で検証する。jsdom 単体テストでは拾えない hydrate + localStorage 経路
// 全体を本物で走らせる。
const KEY = 'openpay:qr-settings:v2';

// 通貨は「お店の設定」シートの中 (2026-10 磨き上げ P2)。開いて USDC を選び、閉じて会計画面に戻る。
async function switchToUsdc(page: Page) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'お店の設定' });
  await sheet.getByRole('button', { name: /^USDC/ }).click();
  await sheet.getByRole('button', { name: '完了' }).click();
  await expect(sheet).toHaveCount(0);
}

test.describe('レジ用クイック金額: token ごと独立 (JPYC/USDC 連動しない)', () => {
  test('fresh: JPYC は 500/1000/1500/3000、USDC へ切替で 5/10/20/50 に変わる', async ({
    page,
  }) => {
    await page.goto('/ja/create');

    // JPYC default のよく使う金額 (金額欄の下のチップ・表示は桁区切り・通貨記号は読み上げ用に付く)
    await expect(page.getByRole('button', { name: /^1,000 JPYC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^3,000 JPYC/ })).toBeVisible();

    // USDC へ切替 (2026-10 磨き上げ P2: 通貨は「お店の設定」の中)
    await switchToUsdc(page);

    // USDC のクイックボタンに変わる (¥のリストが $ に連動しない)
    await expect(page.getByRole('button', { name: /^5 USDC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^50 USDC/ })).toBeVisible();
    // JPYC の数値付きボタンは消える (bare な "JPYC" token tab は \d+ 接頭で除外)
    await expect(page.getByRole('button', { name: /\d+ JPYC$/ })).toHaveCount(0);
    // ¥1000 が $1000 として残っていないこと (本バグの中核)
    await expect(page.getByRole('button', { name: /^1,000 USDC/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^3,000 USDC/ })).toHaveCount(0);
  });

  test('returning: 旧 array をカスタムした JPYC 利用者 → JPYC=カスタム / USDC=既定', async ({
    page,
  }) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key, value);
      },
      [
        KEY,
        JSON.stringify({
          token: 'jpyc',
          chain: 'polygon',
          receiver: '',
          quickAmounts: ['2000', '4000', '6000'],
        }),
      ],
    );
    await page.goto('/ja/create');

    // JPYC は保存したカスタム値
    await expect(page.getByRole('button', { name: /^2,000 JPYC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^6,000 JPYC/ })).toBeVisible();

    // USDC へ切替 → カスタム値は引き継がず USDC 既定
    await switchToUsdc(page);
    await expect(page.getByRole('button', { name: /^5 USDC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^2,000 USDC/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^6,000 USDC/ })).toHaveCount(0);
  });

  test('returning: 旧共有既定のまま token=usdc → ¥既定を引き継がず $5/$10/$20/$50', async ({
    page,
  }) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key, value);
      },
      [
        KEY,
        JSON.stringify({
          token: 'usdc',
          chain: 'base',
          receiver: '',
          // 旧 hook が未カスタム returning user にも永続化していた共有既定
          quickAmounts: ['500', '1000', '1500', '3000'],
        }),
      ],
    );
    await page.goto('/ja/create');

    // USDC 表示で $500/$1000 等の過大ボタンが出ない (本バグの returning user 版)
    await expect(page.getByRole('button', { name: /^5 USDC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^50 USDC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^500 USDC/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^1,000 USDC/ })).toHaveCount(0);
  });
});
