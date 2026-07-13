import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadFirstPartyResources(flag: string) {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', flag);
  vi.resetModules();
  return (await import('@/lib/x402/firstParty')).FIRST_PARTY_RESOURCES;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('x402 first-party directory resources', () => {
  it('directory flag OFF では従来の 2 件だけを掲載する', async () => {
    const resources = await loadFirstPartyResources('');
    expect(resources.map((resource) => resource.path)).toEqual([
      '/api/paid/demo',
      '/api/paid/stores',
    ]);
  });

  it('directory flag ON では固定 URL の一覧/検索だけを data として追加する', async () => {
    const resources = await loadFirstPartyResources('1');
    expect(resources.map((resource) => resource.path)).toEqual([
      '/api/paid/demo',
      '/api/paid/stores',
      '/api/paid/japan-web3-directory',
      '/api/paid/japan-web3-directory/search',
    ]);
    expect(resources.slice(2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ priceJpyc: '2', category: 'data' }),
        expect.objectContaining({ priceJpyc: '2', category: 'data' }),
      ]),
    );
    expect(
      resources.some((resource) =>
        resource.path.startsWith('/api/paid/japan-web3-directory/jpyc'),
      ),
    ).toBe(false);
  });

  it('Shops の4 flag AND が ON のとき search 1 本だけを追加する', async () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', '1');
    vi.stubEnv('ENABLE_AGENT_ORDER', '1');
    vi.resetModules();
    const resources = (await import('@/lib/x402/firstParty'))
      .FIRST_PARTY_RESOURCES;
    expect(resources.map((resource) => resource.path)).toEqual([
      '/api/paid/demo',
      '/api/paid/stores',
      '/api/paid/jpyc-shops/search',
    ]);
    expect(resources[2]).toMatchObject({ priceJpyc: '2', category: 'data' });
  });

  it('Shops flag ON でも relay/agent の片方 OFF なら従来件数のまま', async () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', '');
    vi.stubEnv('ENABLE_AGENT_ORDER', '1');
    vi.resetModules();
    const resources = (await import('@/lib/x402/firstParty'))
      .FIRST_PARTY_RESOURCES;
    expect(resources.map((resource) => resource.path)).toEqual([
      '/api/paid/demo',
      '/api/paid/stores',
    ]);
  });
});
