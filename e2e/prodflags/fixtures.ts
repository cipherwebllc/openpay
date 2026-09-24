import { test as base, expect, type Page } from '@playwright/test';

export const TO = '0x0000000000000000000000000000000000000123';
export const RECOVER_RECIPIENT = "OpenPay's payment contract routes the funds to the store instantly within the same transaction (the store's receipt is never delayed)";

type Network = { relayHealthRequests: number };

export const test = base.extend<{ network: Network }>({
  network: [async ({ page, baseURL }, use) => {
    const network: Network = { relayHealthRequests: 0 };
    const unexpected: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const local = url.origin === new URL(baseURL!).origin;
      if (url.hostname === 'cca-lite.coinbase.com') {
        // Drop known SDK telemetry so its timing cannot fail smoke or send data externally.
        await route.abort('blockedbyclient');
        return;
      }
      if (local && request.method() === 'HEAD' && !url.pathname.startsWith('/api/')) {
        // Coinbase Wallet probes the current page's COOP headers during connector setup.
        await route.continue();
        return;
      }
      if (local && request.method() === 'GET') {
        if (url.pathname === '/api/auth/siwe/me') {
          await route.fulfill({ json: { ok: true, address: null } });
          return;
        }
        if (url.pathname === '/api/relay/jpyc/health' && url.searchParams.get('chainId') === '80002') {
          network.relayHealthRequests += 1;
          await route.fulfill({ json: { degraded: false } });
          return;
        }
        if (!url.pathname.startsWith('/api/')) {
          // Serve real Next pages, RSC responses and static assets from the built app.
          await route.continue();
          return;
        }
      }
      // Stop unexpected RPC/API traffic from reaching a real service. Record it
      // as a test failure so an omitted mock cannot silently make the smoke pass.
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
    });
    await use(network);
    expect(unexpected, 'every API/external request must have an explicit fixture').toEqual([]);
    expect(pageErrors, 'built pages must hydrate without uncaught errors').toEqual([]);
  }, { auto: true }],
});

export { expect };

// Pin values to their semantic definition-list row, not another amount on the page.
export function row(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // InfoTooltip appends a literal '?' button inside some dt elements.
  const term = page.locator('dt').filter({ hasText: new RegExp(`^${escaped}(?:\\s*\\?)?$`) });
  return page.locator('dl > div').filter({ has: term }).locator('dd');
}

export async function expectConnectAction(page: Page) {
  const connect = page.getByRole('button', { name: 'Connect a wallet', exact: true });
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(page.getByText('Wallet', { exact: true })).toBeInViewport();
}
