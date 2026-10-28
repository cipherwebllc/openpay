import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';

// 商品のあるプロフ (/ja/@fixture・開発用の見本: 厳選 4 商品) の PC 2 列とスマホ 1 列の位置を、実際の
// レイアウトで測る (jsdom では測れない)。lg は grid の位置指定で左にプロフィールと応援・右に商品
// (2 行ぶん)。grid-rows-[auto_1fr] が外れると、商品の列が長いときにプロフィールと応援の間が空き得る。

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

function columns(page: Page) {
  const main = page.locator('main');
  return {
    // 名前の見出し (h1) の 2 つ上 = grid の 1 つ目の子 (プロフィール)。
    profile: main.locator('h1').first().locator('xpath=../..'),
    products: main.locator('section[aria-labelledby="creator-storefront-heading"]').locator('xpath=..'),
    tip: main.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: '応援する' }) }).locator('xpath=..'),
    footer: main.locator('footer'),
  };
}

test('PC (1280px): 左にプロフィールと応援・右に商品。商品の列が長くても応援はプロフィールのすぐ下・開いても重ならない', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/ja/@fixture');
  const c = columns(page);
  await expect(page.getByRole('heading', { level: 2, name: '販売中' })).toBeVisible();

  const profile = await boxOf(c.profile);
  const products = await boxOf(c.products);
  const tip = await boxOf(c.tip);
  // 前提: 商品の列が左の列 (プロフィール + 応援) より長い。
  expect(products.height).toBeGreaterThan(profile.height + tip.height);
  // 商品は右の列、応援は左の列でプロフィールの下。
  expect(products.x).toBeGreaterThanOrEqual(profile.x + profile.width);
  expect(Math.abs(tip.x - profile.x)).toBeLessThan(1);
  // 間はプロフィールの mb-7 (28px) だけ。商品の列の余りが 1 行目に足されていない。
  const gap = tip.y - (profile.y + profile.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(40);

  // 応援を開く (TipForm を展開して左の列を長くする)。
  await c.tip.getByRole('button').first().click();
  await expect.poll(async () => (await boxOf(c.tip)).height).toBeGreaterThan(tip.height + 100);
  const opened = await boxOf(c.tip);
  const productsAfter = await boxOf(c.products);
  const footer = await boxOf(c.footer);
  expect(opened.height).toBeGreaterThan(tip.height);
  expect(opened.x + opened.width).toBeLessThanOrEqual(productsAfter.x);
  expect(footer.y).toBeGreaterThanOrEqual(Math.max(opened.y + opened.height, productsAfter.y + productsAfter.height) - 1);
});

test('スマホ (375px): 従来どおり 1 列で プロフィール → 商品 → 応援 の順', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/ja/@fixture');
  const c = columns(page);
  await expect(page.getByRole('heading', { level: 2, name: '販売中' })).toBeVisible();
  const profile = await boxOf(c.profile);
  const products = await boxOf(c.products);
  const tip = await boxOf(c.tip);
  expect(products.y).toBeGreaterThanOrEqual(profile.y + profile.height);
  expect(tip.y).toBeGreaterThanOrEqual(products.y + products.height);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(375);
});
