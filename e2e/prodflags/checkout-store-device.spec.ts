import { test, expect, TO, RECOVER_RECIPIENT, row } from './fixtures';
import type { Page } from '@playwright/test';

// 「お店がガス代を肩代わりして送る」(内部名「お店の端末で送る」・NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET・2026-10-08 本番点灯)。
// お客様が読み取る /checkout?submit=store&hs=… (StoreDeviceCheckoutForm) を、本番と同じ flag の build で署名の直前まで描画する。
// 入口をお客様の画面にした理由: お店側の全画面 QR は、端末のガス用ウォレット (ブラウザでの鍵の生成とチェーンの残高 RPC) と
// 受け渡しの作成 (server-only の IP_HASH_SECRET が要る POST /api/register/handoff) を経ないと出ず、固定する通信が多い。
// お客様の画面は署名するまで受け渡しにも RPC にも触れないので、money-path の表示 (請求額・利用料 0 + 1 wei の開示・
// OpenPay の中継を使わないこと) を本番の flag のまま確かめられる。署名・送信はしない。

const HANDOFF_ID = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 chars (lib/storeDevicePayment.ts STORE_HANDOFF_ID_PATTERN)
const BASE = `/en/checkout?to=${TO}&token=jpyc&chain=polygon&store=Test%20Cafe&submit=store&hs=${HANDOFF_ID}`;
const FEE_NOTE =
  'The shop’s device pays the gas and the OpenPay usage fee is 0 (by design, 1 wei = 0.000000000000000001 JPYC is added to each transfer and sent to OpenPay).';
const SIGN_NOTE =
  "Your wallet will show OpenPay's intermediary contract as the recipient and the amount plus 1 wei. After you sign, the shop's device sends it.";

// お客様の画面が受け渡しに触れるのは署名した後だけ (hooks/useStoreDevicePayment.ts)。それでも固定する: 呼ばれたら記録し、
// セッションが無いときの応答を返す (早すぎる呼び出しは支払いに進まず止まり、テストの失敗として出る)。
async function pinHandoff(page: Page) {
  const calls: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/register/handoff'),
    async (route) => {
      calls.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.fulfill({ status: 404, json: { ok: false, error: 'not_found' } });
    },
  );
  return calls;
}

test.describe('/checkout?submit=store — the shop pays the gas', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const scenario of [
    { name: 'no discount', items: 'Lunch:1:500', line: '500', disc: null, bill: '500' },
    { name: 'register discount', items: 'Lunch:1:1000', line: '1000', disc: '100', bill: '900' },
  ]) {
    test(`${scenario.name}: the customer signs ${scenario.bill} JPYC with no OpenPay fee row`, async ({ page, network }) => {
      const { items, line, disc, bill } = scenario;
      const handoff = await pinHandoff(page);
      await page.goto(`${BASE}&items=${items}${disc ? `&disc=${disc}` : ''}`);

      await expect(page.getByText('Test Cafe', { exact: true })).toBeVisible();
      const item = page.getByRole('listitem');
      await expect(item).toHaveCount(1);
      await expect(item.getByText('Lunch ×1', { exact: true })).toBeVisible();
      await expect(item.getByText(`${line} JPYC`, { exact: true })).toBeVisible();
      if (disc) {
        await expect(row(page, 'Subtotal')).toHaveText(`${line} JPYC`);
        await expect(row(page, 'Discount')).toHaveText(`−${disc} JPYC`);
      } else {
        await expect(row(page, 'Discount')).toHaveCount(0);
      }
      const total = page.getByText('Amount to pay', { exact: true });
      await expect(total).toBeVisible();
      await expect(total.locator('xpath=following-sibling::span')).toHaveText(`${bill} JPYC`);

      // この経路の開示: 利用料 0 円と仕組み上の 1 wei・ウォレットの署名画面に出るもの。
      await expect(page.getByText(FEE_NOTE, { exact: true })).toBeVisible();
      await expect(page.getByText(SIGN_NOTE, { exact: true })).toBeVisible();
      // 回収 (recover) の経路ではない: 手数料の行も OpenPay の中継も無い (送るのはお店の端末)。
      await expect(page.locator('dl dt').filter({ hasText: /network fee|service fee/i })).toHaveCount(0);
      await expect(page.getByText(RECOVER_RECIPIENT, { exact: true })).toHaveCount(0);

      // 署名の直前で止める: ウォレット未接続なので支払いボタンは押せず、ウォレットの欄 (接続先の一覧) だけが押せる。
      // この画面は CheckoutForm の「ウォレットを接続」ボタンを持たず、ConnectButton の一覧をそのまま出す。押すと
      // ウォレットの SDK が外部と通信するので押さない。
      await expect(page.getByRole('button', { name: `Pay ${bill} JPYC`, exact: true })).toBeDisabled();
      await expect(page.getByText('Wallet', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Coinbase Wallet', exact: true })).toBeEnabled();

      expect(network.relayHealthRequests, 'this path must not use the OpenPay relay').toBe(0);
      expect(handoff, 'the hand-off is contacted only after signing').toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(overflow, 'mobile checkout must not scroll horizontally').toBe(false);
    });
  }

  // fail-closed: 条件に合わない submit=store を通常の経路 (回収 1%) に倒さず「使えない」と止める (lib/url/checkout.ts)。
  test('a store-device URL that also asks for a mobile-order fee stops instead of falling back to the 1% path', async ({ page, network }) => {
    const handoff = await pinHandoff(page);
    await page.goto(`${BASE}&items=Lunch:1:500&fee_kind=storefront`);
    await expect(page.getByText('Invalid Checkout URL', { exact: true })).toBeVisible();
    await expect(page.getByText("This QR code can't be used. Ask the shop to show a new one.", { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pay 500 JPYC', exact: true })).toHaveCount(0);
    await expect(page.getByText(RECOVER_RECIPIENT, { exact: true })).toHaveCount(0);
    expect(network.relayHealthRequests).toBe(0);
    expect(handoff).toEqual([]);
  });
});
