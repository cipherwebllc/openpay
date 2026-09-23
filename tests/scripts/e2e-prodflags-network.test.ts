// @vitest-environment node
import type { Page, Route } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

const { extend } = vi.hoisted(() => ({ extend: vi.fn() }));
vi.mock('@playwright/test', async () => ({
  test: { extend },
  expect: (await import('vitest')).expect,
}));
// Exercise the actual auto-fixture callback, including its teardown assertion.
import '../../e2e/prodflags/fixtures';

type Setup = (
  args: { page: Page; baseURL: string },
  use: (network: { relayHealthRequests: number }) => Promise<void>,
) => Promise<void>;
const setup = extend.mock.calls[0][0].network[0] as Setup;
const origin = 'http://127.0.0.1:3100';

function exercise(method: string, url: string) {
  const route = {
    request: () => ({ method: () => method, url: () => url }),
    continue: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    fulfill: vi.fn().mockResolvedValue(undefined),
  };
  const registerRoute = vi.fn<(pattern: string, handler: (route: Route) => Promise<void>) => Promise<void>>()
    .mockResolvedValue(undefined);
  const page = { on: vi.fn(), route: registerRoute };
  const run = setup({ page: page as unknown as Page, baseURL: origin }, async () => {
    const handler = registerRoute.mock.calls[0][1];
    await handler(route as unknown as Route);
  });
  return { route, run };
}

describe('production-flag network fixture', () => {
  it.each([
    ['GET', '/en/pay'],
    ['GET', '/_next/static/chunk.js'],
    ['HEAD', '/en/pay'],
    ['HEAD', '/en/checkout'],
    ['HEAD', '/en/tip/0x0000000000000000000000000000000000000123'],
  ])('continues local %s %s without failing teardown', async (method, path) => {
    const { route, run } = exercise(method, `${origin}${path}`);
    await run;
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it.each(['/amp', '/metrics'])('silently aborts Coinbase telemetry %s', async (path) => {
    const { route, run } = exercise('POST', `https://cca-lite.coinbase.com${path}`);
    await run;
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/auth/siwe/me', { ok: true, address: null }],
    ['/api/relay/jpyc/health?chainId=80002', { degraded: false }],
  ])('still mocks GET %s', async (path, json) => {
    const { route, run } = exercise('GET', `${origin}${path}`);
    await run;
    expect(route.fulfill).toHaveBeenCalledWith({ json });
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it.each([
    ['HEAD', `${origin}/api/auth/siwe/me`],
    ['GET', `${origin}/api/unmocked`],
    ['GET', `${origin}/api/relay/jpyc/health?chainId=137`],
    ['POST', `${origin}/en/pay`],
    ['POST', 'https://rpc.example.test/'],
    ['HEAD', 'https://example.test/en/pay'],
    ['POST', 'https://cca-lite.coinbase.com.example.test/amp'],
    ['POST', 'https://other.coinbase.com/metrics'],
  ])('still aborts and fails on unexpected %s %s', async (method, url) => {
    const { route, run } = exercise(method, url);
    await expect(run).rejects.toThrow('every API/external request must have an explicit fixture');
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
  });
});
