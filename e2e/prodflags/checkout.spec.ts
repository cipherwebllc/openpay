import { test, expect, TO, RECOVER_RECIPIENT, row, expectConnectAction } from './fixtures';

test.describe('/checkout — production relay/recover and mobile orders', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const { amount, fee } of [
    { amount: '100', fee: '2' },
    { amount: '1000', fee: '10' },
  ]) {
    test(`ordinary checkout ${amount} JPYC: recover fee stays within the price`, async ({ page, network }) => {
      await page.goto(`/en/checkout?to=${TO}&token=jpyc&items=Lunch:1:${amount}`);
      await expect(page.locator('main').getByText('OpenPay Checkout', { exact: true })).toBeVisible();
      await expect(page.getByText('Lunch', { exact: true })).toBeVisible();
      await expect(row(page, 'Subtotal')).toHaveText(`${amount} JPYC`);
      await expect(row(page, 'Estimated network fee (merchant pays)')).toHaveText(`${fee} JPYC`);
      await expect(row(page, 'You pay')).toHaveText(`${amount} JPYC`);
      await expect(page.getByText(RECOVER_RECIPIENT, { exact: true })).toBeVisible();
      await expect.poll(() => network.relayHealthRequests).toBeGreaterThan(0);
      await expectConnectAction(page);
    });
  }

  for (const scenario of [
    { kind: 'storefront', payer: 'merchant', amount: '100', fee: '1', total: '100' },
    { kind: 'preorder', payer: 'merchant', amount: '1000', fee: '30', total: '1000' },
    { kind: 'preorder', payer: 'customer', amount: '1000', fee: '30', total: '1030' },
  ]) {
    test(`${scenario.kind}, ${scenario.payer} pays: mobile fee replaces recover fee`, async ({ page, network }) => {
      const { kind, payer, amount, fee, total } = scenario;
      await page.goto(`/en/checkout?to=${TO}&token=jpyc&items=Lunch:1:${amount}&fee_kind=${kind}&fee_payer=${payer}`);
      await expect(page.locator('main').getByText('OpenPay Checkout', { exact: true })).toBeVisible();
      await expect(page.getByText('Lunch', { exact: true })).toBeVisible();
      await expect(row(page, 'Subtotal')).toHaveText(`${amount} JPYC`);
      const feeLabel = payer === 'merchant' ? 'OpenPay service fee (merchant pays)' : 'OpenPay service fee';
      await expect(row(page, feeLabel)).toHaveText(`${fee} JPYC`);
      await expect(row(page, 'You pay')).toHaveText(`${total} JPYC`);
      // No second recover/gas row: mobile-order fees already include sponsored gas.
      await expect(page.locator('dl dt').filter({ hasText: /network fee/i })).toHaveCount(0);
      await expect(page.getByText(RECOVER_RECIPIENT, { exact: true })).toBeVisible();
      await expect.poll(() => network.relayHealthRequests).toBeGreaterThan(0);
      await expectConnectAction(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(overflow, 'mobile checkout must not scroll horizontally').toBe(false);
    });
  }
});
