import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';

// 商品のあるプロフ (/ja/@fixture・開発用の見本: 厳選 4 商品) の PC 2 列とスマホ 1 列の位置を、実際の
// レイアウトで測る (jsdom では測れない)。lg は grid の位置指定で左にプロフィールと応援・右に商品
// (2 行ぶん)。grid-rows-[auto_1fr] が外れると、商品の列が長いときにプロフィールと応援の間が空く
// (2026-10-28 実測: 外すと 238px・あると 28px)。
// grid の子 (行の高さまで伸びる) ではなく中身 (プロフィールの本体・商品と応援の section) を測る —
// 子で測ると行が伸びても間が mb-7 のまま見え、退行を見逃す (Codex #924)。

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

function parts(page: Page) {
  const main = page.locator('main');
  return {
    // 名前の見出し (h1) の親 = プロフィールの本体 (HandleProfileView)。
    profile: main.locator('h1').first().locator('xpath=..'),
    products: main.locator('section[aria-labelledby="creator-storefront-heading"]'),
    tip: main.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: '応援する' }) }),
    footer: main.locator('footer'),
  };
}

async function settle(page: Page) {
  await expect(page.getByRole('heading', { level: 2, name: '販売中' })).toBeVisible();
  // 丸ゴシック (font-display: swap) の差し替えで高さが変わる前に測らない。
  await page.evaluate(() => document.fonts.ready);
}

test('PC (1280px): 左にプロフィールと応援・右に商品。商品の列が長くても応援はプロフィールのすぐ下・開いても重ならない', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/ja/@fixture');
  await settle(page);
  const p = parts(page);

  const [profile, products, tip] = await Promise.all([boxOf(p.profile), boxOf(p.products), boxOf(p.tip)]);
  // 前提: 商品の列が左の列 (プロフィール + 間 + 応援) より長い。
  expect(products.height).toBeGreaterThan(profile.height + 40 + tip.height);
  // 商品は右の列の上端 (プロフィールと同じ高さから)・応援は左の列。
  expect(products.x).toBeGreaterThanOrEqual(profile.x + profile.width);
  expect(Math.abs(products.y - profile.y)).toBeLessThan(2);
  expect(tip.x + tip.width).toBeLessThanOrEqual(products.x);
  // 応援はプロフィールのすぐ下 (間は mb-7 の 28px)。商品の列の余りが 1 行目に足されると、ここが広がる。
  const gap = tip.y - (profile.y + profile.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(40);

  // 応援を開く (TipForm を展開して左の列を長くする)。開き終わる (高さが止まる) まで待ってからまとめて測る。
  await p.tip.getByRole('button').first().click();
  let previous = -1;
  await expect
    .poll(async () => {
      const height = (await boxOf(p.tip)).height;
      const stable = height === previous && height > tip.height + 100;
      previous = height;
      return stable;
    }, { intervals: [200, 200, 300, 500] })
    .toBe(true);
  const [opened, productsAfter, footer] = await Promise.all([boxOf(p.tip), boxOf(p.products), boxOf(p.footer)]);
  // 前提: 開いた後は左の列のほうが下まで伸びる。
  expect(opened.y + opened.height).toBeGreaterThan(productsAfter.y + productsAfter.height);
  expect(opened.x + opened.width).toBeLessThanOrEqual(productsAfter.x);
  expect(footer.y).toBeGreaterThanOrEqual(opened.y + opened.height);
});

test('スマホ (375px): 従来どおり 1 列で プロフィール → 商品 → 応援 の順', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/ja/@fixture');
  await settle(page);
  const p = parts(page);
  const [profile, products, tip] = await Promise.all([boxOf(p.profile), boxOf(p.products), boxOf(p.tip)]);
  expect(products.y).toBeGreaterThanOrEqual(profile.y + profile.height);
  expect(tip.y).toBeGreaterThanOrEqual(products.y + products.height);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(375);
});
