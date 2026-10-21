import { afterEach, describe, expect, it, vi } from 'vitest';

// 公式商品の JPYC 面と USDC 面 (path が違う双子) の対応表の契約。表示専用で、/api/discovery・402・Bazaar は変えない。
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load() {
  // FIRST_PARTY_RESOURCES は flag で増減する。全 flag を ON にして全件を対象にする。
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', '1');
  vi.stubEnv('ENABLE_AGENT_ORDER', '1');
  vi.resetModules();
  const { FIRST_PARTY_RESOURCES } = await import('@/lib/x402/firstParty');
  const { USDC_CATALOG_ITEMS } = await import('@/lib/x402/usdcCatalog');
  const twins = await import('@/lib/x402/catalogTwins');
  return { FIRST_PARTY_RESOURCES, USDC_CATALOG_ITEMS, ...twins };
}

describe('JPYC_TWIN_BY_USDC_PATH', () => {
  it('key は USDC 商品の path、value は公式 (JPYC) 商品の path', async () => {
    const { FIRST_PARTY_RESOURCES, USDC_CATALOG_ITEMS, JPYC_TWIN_BY_USDC_PATH } = await load();
    expect(FIRST_PARTY_RESOURCES.length).toBe(7);
    const usdcPaths = USDC_CATALOG_ITEMS.map((item) => new URL(item.resource).pathname);
    const jpycPaths = FIRST_PARTY_RESOURCES.map((r) => r.path as string);
    const entries = Object.entries(JPYC_TWIN_BY_USDC_PATH);
    expect(entries.length).toBeGreaterThan(0);
    for (const [usdcPath, jpycPath] of entries) {
      expect(usdcPaths, `key ${usdcPath}`).toContain(usdcPath);
      expect(jpycPaths, `value ${jpycPath}`).toContain(jpycPath);
    }
  });

  it('1 つの JPYC 面に USDC 面は 1 つだけ (1 枚にまとめるとき相手が曖昧にならない)', async () => {
    const { JPYC_TWIN_BY_USDC_PATH } = await load();
    const values = Object.values(JPYC_TWIN_BY_USDC_PATH);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('withJpycTwins', () => {
  it('対応表にある USDC 商品にだけ jpycTwinPath を付け、他は同じ object のまま返す', async () => {
    const { USDC_CATALOG_ITEMS, JPYC_TWIN_BY_USDC_PATH, withJpycTwins } = await load();
    const result = withJpycTwins(USDC_CATALOG_ITEMS);
    expect(result).toHaveLength(USDC_CATALOG_ITEMS.length);
    result.forEach((item, index) => {
      const original = USDC_CATALOG_ITEMS[index];
      const twin = JPYC_TWIN_BY_USDC_PATH[new URL(original.resource).pathname];
      if (twin) {
        expect(item.jpycTwinPath, original.resource).toBe(twin);
        expect({ ...item, jpycTwinPath: undefined }).toEqual({ ...original, jpycTwinPath: undefined });
      } else {
        expect(item, original.resource).toBe(original);
        expect(item).not.toHaveProperty('jpycTwinPath');
      }
    });
    expect(result.some((item) => item.jpycTwinPath)).toBe(true);
    expect(result.some((item) => !item.jpycTwinPath)).toBe(true);
  });

  it('元の配列と商品を書き換えない', async () => {
    const { USDC_CATALOG_ITEMS, withJpycTwins } = await load();
    const before = JSON.stringify(USDC_CATALOG_ITEMS);
    withJpycTwins(USDC_CATALOG_ITEMS);
    expect(JSON.stringify(USDC_CATALOG_ITEMS)).toBe(before);
  });
});
