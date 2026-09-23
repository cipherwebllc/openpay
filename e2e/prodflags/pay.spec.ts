import { test, expect, TO, RECOVER_RECIPIENT, row, expectConnectAction } from './fixtures';

test.describe('/pay — production JPYC relay/recover', () => {
  for (const { amount, fee, merchant } of [
    { amount: '100', fee: '2', merchant: '98' },
    { amount: '1000', fee: '10', merchant: '990' },
  ]) {
    test(`${amount} JPYC: merchant bears max(2 JPYC, 1%)`, async ({ page, network }) => {
      // Old customer-pays URLs must still use the production merchant-borne schedule.
      await page.goto(`/en/pay?to=${TO}&token=jpyc&chain=polygon&amount=${amount}&gas=customer`);
      await expect(page.locator('main').getByText('OpenPay Payment', { exact: true })).toBeVisible();
      await expect(page.getByText('Polygon Amoy', { exact: true })).toBeVisible();
      await expect(row(page, 'Merchant receives')).toHaveText(`${merchant} JPYC`);
      await expect(row(page, 'Estimated network fee (merchant pays)')).toHaveText(`${fee} JPYC`);
      await expect(row(page, 'You pay')).toHaveText(`${amount} JPYC`);
      await expect(page.getByText(RECOVER_RECIPIENT, { exact: true })).toBeVisible();
      await expect.poll(() => network.relayHealthRequests).toBeGreaterThan(0);
      await expectConnectAction(page);
    });
  }
});
