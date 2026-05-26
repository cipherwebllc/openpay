import { test, expect } from '@playwright/test';

// 「高度な設定 > レジ用クイック金額」が token (JPYC=円 / USDC=ドル) ごとに
// 独立していること、旧 schema (単一 array 共有) からの migration が正しいことを
// 実 browser で検証する。jsdom 単体テストでは拾えない hydrate + localStorage 経路
// 全体を本物で走らせる。
const KEY = 'openpay:qr-settings:v2';

test.describe('レジ用クイック金額: token ごと独立 (JPYC/USDC 連動しない)', () => {
  test('fresh: JPYC は 500/1000/1500/3000、USDC へ切替で 5/10/20/50 に変わる', async ({
    page,
  }) => {
    await page.goto('/ja');
    const step1 = page.locator('section[aria-labelledby="step-1-heading"]');

    // JPYC default のクイックボタン (amount 入力上の chip)
    await expect(page.getByRole('button', { name: /^1000 JPYC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^3000 JPYC/ })).toBeVisible();

    // USDC へ切替
    await step1.getByRole('button', { name: /^USDC/ }).click();

    // USDC のクイックボタンに変わる (¥のリストが $ に連動しない)
    await expect(page.getByRole('button', { name: /^5 USDC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^50 USDC/ })).toBeVisible();
    // JPYC の数値付きボタンは消える (bare な "JPYC" token tab は \d+ 接頭で除外)
    await expect(page.getByRole('button', { name: /\d+ JPYC$/ })).toHaveCount(0);
    // ¥1000 が $1000 として残っていないこと (本バグの中核)
    await expect(page.getByRole('button', { name: /^1000 USDC/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^3000 USDC/ })).toHaveCount(0);
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
    await page.goto('/ja');
    const step1 = page.locator('section[aria-labelledby="step-1-heading"]');

    // JPYC は保存したカスタム値
    await expect(page.getByRole('button', { name: /^2000 JPYC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^6000 JPYC/ })).toBeVisible();

    // USDC へ切替 → カスタム値は引き継がず USDC 既定
    await step1.getByRole('button', { name: /^USDC/ }).click();
    await expect(page.getByRole('button', { name: /^5 USDC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^2000 USDC/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^6000 USDC/ })).toHaveCount(0);
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
    await page.goto('/ja');

    // USDC 表示で $500/$1000 等の過大ボタンが出ない (本バグの returning user 版)
    await expect(page.getByRole('button', { name: /^5 USDC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^50 USDC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^500 USDC/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^1000 USDC/ })).toHaveCount(0);
  });
});
