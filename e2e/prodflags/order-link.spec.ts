import type { Locator, Page } from '@playwright/test';
import { test, expect, TO, row } from './fixtures';

// 注文リンク (/create の「注文リンク」タブ・第 9 回レビュー F-07)。本番と同じ flag の build で、お店が入れた注文の
// 明細・小計・値引き・合計・届く額を作る画面で確かめ、作られた /checkout のリンクを開いて、お客様の画面の明細と金額が
// 作る画面の表示と一致することを見る。ウォレットの接続・署名・送金はしない。
// - 期待値は手で計算した数をここに書く。アプリの関数 (lib/orderLink.ts 等) で出すと、同じ誤りを共有して見逃す。
// - 受取先は生のアドレス (fixtures の TO)。名前 (.eth) は ENS の RPC で解決するので使わない。
// - 共有の文 (OrderLinkBuilder.shareText) は文言を変える途中の PR があるので見ない。
// - 利用料は prodFlags.env の値 (NEXT_PUBLIC_RECOVER_FEE_BPS=100・NEXT_PUBLIC_RELAY_GAS_FEE_JPYC=2) = max(2 JPYC, 1%)。
//   Polygon は testnet (Amoy) で forwarder ありなので、ガスレスの注文は回収の経路 (お店の受取から利用料を引く)。

const MINUS = '\u2212'; // 値引きの「−」(作る画面もお客様の画面も U+2212)

type ExpectedLine = { label: string; amount: string };

// 注文リンクは何もサーバーへ送らない (lib/orderLink.ts)。お客様の画面も署名の前は /api/order/* に触れない。
// 呼ばれたら記録して 404 を返す (早すぎる呼び出しはテストの失敗として出る)。
async function pinOrderApi(page: Page) {
  const calls: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/order/'),
    async (route) => {
      calls.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.fulfill({ status: 404, json: { ok: false, error: 'not_found' } });
    },
  );
  return calls;
}

async function openOrderLinkTab(page: Page) {
  // /create は最初に決済QR のタブを描き (?tab= はマウント後に反映)、決済QR は市場レート (USDC→円) を読む。
  // 注文リンクの金額には関係しないので固定値で応える (orders.spec と同じ)。
  await page.route('**/api/market/rates', (route) =>
    route.fulfill({ json: { usdcJpy: 150, updatedAt: '2026-10-09T00:00:00.000Z' } }),
  );
  await page.goto('/en/create?tab=orderLink');
  // 端末の設定 (localStorage) を読み終えると自動の番号が入る。読み込みが打った受取先を上書きしないよう、その後に打つ。
  await expect(page.getByRole('textbox', { name: 'Order number', exact: true })).toHaveValue('A-001', { timeout: 15_000 });
  const receiver = page.getByRole('textbox', { name: 'Receiving wallet', exact: true });
  await receiver.fill(TO);
  await expect(receiver).toHaveValue(TO);
}

// 金額欄は 3 桁区切りで見せる (値は区切りなしで持つ)。打った値が区切りつきで定着したことまで確かめる。
async function fillAmount(field: Locator, typed: string, shown: string) {
  await field.fill(typed);
  await expect(field).toHaveValue(shown);
}

// お客様の画面の見本 (作る画面の右側)。明細の各行は「商品名 (×数量)」と「金額」。
async function expectPreviewLines(preview: Locator, lines: readonly ExpectedLine[]) {
  const items = preview.locator('ul').first().locator('> li');
  await expect(items).toHaveCount(lines.length);
  for (const [index, line] of lines.entries()) {
    await expect(items.nth(index).locator('> span').first()).toHaveText(line.label);
    await expect(items.nth(index).locator('> span').last()).toHaveText(line.amount);
  }
}

// 「開いて確かめる」のリンクを同じタブで開く (新しいタブには page.route が効かず、固定していない通信が外へ出る)。
// リンクは言語なしの /checkout?… で、開くと middleware が言語つきの URL へ転送する。この job の server
// (next start --hostname 127.0.0.1) は転送先を http://localhost:3100 で返し、baseURL と別の origin になって
// fixtures の固定が効かない (本番は同じ host へ転送する)。なので言語だけを足し、注文の中身 (query) はリンクのまま開く。
async function openCreatedLink(page: Page, baseURL: string) {
  await expect(page.getByText('Link ready', { exact: true })).toBeVisible();
  const href = await page.getByRole('link', { name: 'Open and check', exact: true }).getAttribute('href');
  expect(href, 'the builder must offer the link it made').not.toBeNull();
  const url = new URL(href!);
  expect(url.origin, 'the link must point at this deployment').toBe(new URL(baseURL).origin);
  expect(url.pathname).toBe('/checkout');
  await page.goto(`/en/checkout${url.search}`);
}

// お客様の画面の明細の各行は「商品名」「×数量」「金額」(金額は区切りなし)。
async function expectCheckoutLines(page: Page, lines: readonly { name: string; qty: string; amount: string }[]) {
  const items = page.locator('section').filter({ has: page.getByText('Items', { exact: true }) }).locator('ul > li');
  await expect(items).toHaveCount(lines.length);
  for (const [index, line] of lines.entries()) {
    const cells = items.nth(index).locator('> span');
    await expect(cells).toHaveText([line.name, line.qty, line.amount]);
  }
}

test.describe('/create order link — totals and discount reach /checkout unchanged', () => {
  test('fixed discount: 2 items + shipping, 250 JPYC off', async ({ page, baseURL }) => {
    const orderApi = await pinOrderApi(page);
    await openOrderLinkTab(page);

    // 1 行目: コーヒー豆 1,200 × 2 (数量は + で増やす)。2 行目: ドリップバッグ 350 × 1。送料 500。
    await page.getByRole('textbox', { name: 'Item name', exact: true }).first().fill('Coffee beans');
    await fillAmount(page.getByRole('textbox', { name: 'Unit price', exact: true }).first(), '1200', '1,200');
    await page.getByRole('button', { name: 'Increase quantity', exact: true }).first().click();
    await expect(page.getByRole('textbox', { name: 'Quantity', exact: true }).first()).toHaveValue('2');
    // 数量が 2 以上の行は、単価の欄の下に行の小計を出す (小計を単価の欄に入れて倍額のリンクを作らない)。
    await expect(page.getByText('1,200 each × 2 = 2,400 JPYC', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add item', exact: true }).click();
    await page.getByRole('textbox', { name: 'Item name', exact: true }).nth(1).fill('Drip bag');
    await fillAmount(page.getByRole('textbox', { name: 'Unit price', exact: true }).nth(1), '350', '350');
    await fillAmount(page.getByRole('textbox', { name: 'Shipping', exact: true }), '500', '500');

    // 値引き (金額) 250 JPYC。商品の合計 2,750 (送料を除く) より小さい。
    await page.getByRole('button', { name: 'Add discount', exact: true }).click();
    const discountInput = page.getByRole('textbox', { name: 'Discount amount', exact: true });
    await discountInput.fill('250');
    await expect(page.getByRole('group', { name: 'Discount' }).getByText(`${MINUS}250 JPYC`, { exact: true })).toBeVisible();

    // 作る画面の見本: 2,400 + 350 + 500 = 3,250 → 値引き 250 → 合計 3,000。
    // 利用料 max(2, 3,000 × 1%) = 30 → お店に届くのは 2,970。
    const preview = page.getByRole('region', { name: 'What the customer sees' });
    await expect(preview.getByText('Order #A-001', { exact: true })).toBeVisible();
    await expectPreviewLines(preview, [
      { label: 'Coffee beans×2', amount: '2,400 JPYC' },
      { label: 'Drip bag', amount: '350 JPYC' },
      { label: 'Shipping', amount: '500 JPYC' },
    ]);
    await expect(row(page, 'Subtotal')).toHaveText('3,250 JPYC');
    await expect(row(page, 'Discount')).toHaveText(`${MINUS}250 JPYC`);
    await expect(preview.getByText('Total', { exact: true }).locator('xpath=following-sibling::span')).toHaveText('3,000 JPYC');
    await expect(preview.getByText('Ship after 2,970 JPYC reaches your wallet', { exact: true })).toBeVisible();
    await expect(preview.getByText('30 JPYC fee deducted. 3,000 JPYC if paid as standard', { exact: true })).toBeVisible();

    // お客様の画面: 同じ明細・小計・値引き・お支払い額。利用料はお店の負担 (お客様が払うのは合計だけ)。
    await openCreatedLink(page, baseURL!);
    await expect(page.getByText('Order #A-001', { exact: true })).toBeVisible();
    await expect(page.getByText(`To ${TO.slice(0, 6)}…${TO.slice(-4)} · Polygon Amoy · JPYC · No gas fee`, { exact: true })).toBeVisible();
    await expectCheckoutLines(page, [
      { name: 'Coffee beans', qty: '×2', amount: '2400 JPYC' },
      { name: 'Drip bag', qty: '×1', amount: '350 JPYC' },
      { name: 'Shipping', qty: '×1', amount: '500 JPYC' },
    ]);
    await expect(row(page, 'Subtotal')).toHaveText('3250 JPYC');
    await expect(row(page, 'Discount')).toHaveText(`${MINUS}250 JPYC`);
    await expect(row(page, 'Estimated network fee (merchant pays)')).toHaveText('30 JPYC');
    await expect(row(page, 'You pay')).toHaveText('3000 JPYC');

    expect(orderApi, 'neither the builder nor the unsigned checkout may call /api/order/*').toEqual([]);
  });

  test('percent discount with consumption tax: 10% off the goods, not the shipping', async ({ page, baseURL }) => {
    const orderApi = await pinOrderApi(page);
    await openOrderLinkTab(page);

    // 1 行目に移ると受取の欄が要約の行に畳まれる。畳まれてから設定を開く (開く途中でボタンが入れ替わらないように)。
    await page.getByRole('textbox', { name: 'Item name', exact: true }).first().fill('Gift box');
    await expect(page.getByRole('textbox', { name: 'Receiving wallet', exact: true })).toHaveCount(0);
    await expect(page.getByText(`${TO.slice(0, 6)}…${TO.slice(-4)}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Order link settings' });
    await sheet.getByRole('button', { name: 'Taxable 10%', exact: true }).click();
    await expect(sheet.getByRole('button', { name: 'Taxable 10%', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(sheet).toHaveCount(0);

    // ギフトボックス 2,000 × 2。送料 800。値引きは割引率 10% (商品の合計 4,000 にかける = 400)。
    await fillAmount(page.getByRole('textbox', { name: 'Unit price', exact: true }).first(), '2000', '2,000');
    await page.getByRole('button', { name: 'Increase quantity', exact: true }).first().click();
    await expect(page.getByRole('textbox', { name: 'Quantity', exact: true }).first()).toHaveValue('2');
    await fillAmount(page.getByRole('textbox', { name: 'Shipping', exact: true }), '800', '800');
    await page.getByRole('button', { name: 'Add discount', exact: true }).click();
    const discount = page.getByRole('group', { name: 'Discount' });
    await discount.getByRole('button', { name: 'Percent', exact: true }).click();
    await page.getByRole('textbox', { name: 'Discount rate (%)', exact: true }).fill('10');
    await expect(discount.getByText(`${MINUS}400 JPYC`, { exact: true })).toBeVisible();

    // 4,000 + 800 = 4,800 → 値引き 400 → 合計 4,400。うち消費税 (全部 10%・内税) 4,400 × 10/110 = 400。
    // 利用料 max(2, 4,400 × 1%) = 44 → お店に届くのは 4,356。
    const preview = page.getByRole('region', { name: 'What the customer sees' });
    await expectPreviewLines(preview, [
      { label: 'Gift box×2', amount: '4,000 JPYC' },
      { label: 'Shipping', amount: '800 JPYC' },
    ]);
    await expect(row(page, 'Subtotal')).toHaveText('4,800 JPYC');
    await expect(row(page, 'Discount')).toHaveText(`${MINUS}400 JPYC`);
    await expect(preview.getByText('Total', { exact: true }).locator('xpath=following-sibling::span')).toHaveText('4,400 JPYC');
    await expect(preview.getByText('Includes 400 JPYC consumption tax', { exact: true })).toBeVisible();
    await expect(preview.getByText('Ship after 4,356 JPYC reaches your wallet', { exact: true })).toBeVisible();
    await expect(preview.getByText('44 JPYC fee deducted. 4,400 JPYC if paid as standard', { exact: true })).toBeVisible();

    await openCreatedLink(page, baseURL!);
    await expect(page.getByText('Order #A-001', { exact: true })).toBeVisible();
    await expectCheckoutLines(page, [
      { name: 'Gift box', qty: '×2', amount: '4000 JPYC' },
      { name: 'Shipping', qty: '×1', amount: '800 JPYC' },
    ]);
    await expect(row(page, 'Subtotal')).toHaveText('4800 JPYC');
    await expect(row(page, 'Discount')).toHaveText(`${MINUS}400 JPYC`);
    await expect(row(page, 'Estimated network fee (merchant pays)')).toHaveText('44 JPYC');
    await expect(row(page, 'You pay')).toHaveText('4400 JPYC');

    expect(orderApi, 'neither the builder nor the unsigned checkout may call /api/order/*').toEqual([]);
  });
});
