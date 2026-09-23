import { test, expect, TO, RECOVER_RECIPIENT, row, expectConnectAction } from './fixtures';

test('/tip — fan pays 2 JPYC, with no percentage fee even on a larger tip', async ({ page }) => {
  await page.goto(`/en/tip/${TO}?token=jpyc&chain=polygon&preset=100,1000`);
  await expect(page.locator('main').getByText('OpenPay Tip', { exact: true })).toBeVisible();
  await expect(row(page, 'Creator receives')).toHaveText('100 JPYC');
  await expect(row(page, 'Estimated network fee')).toHaveText('2 JPYC');
  await expect(row(page, 'You pay')).toHaveText('102 JPYC');

  // Interaction verifies hydration and recalculation, not just the initial server HTML.
  await page.getByRole('button', { name: '1000 JPYC', exact: true }).click();
  await expect(row(page, 'Creator receives')).toHaveText('1000 JPYC');
  await expect(row(page, 'Estimated network fee')).toHaveText('2 JPYC');
  await expect(row(page, 'You pay')).toHaveText('1002 JPYC');
  await expect(row(page, 'OpenPay service fee')).toHaveCount(0);
  await page.getByText('Only one signature is requested', { exact: true }).click();
  await expect(page.getByText(RECOVER_RECIPIENT, { exact: true })).toBeVisible();
  await expect(page.getByText('Only exactly 1002 JPYC can move (payment 1000 + fee 2), and only to this recipient', { exact: true })).toBeVisible();
  await expectConnectAction(page);
});
