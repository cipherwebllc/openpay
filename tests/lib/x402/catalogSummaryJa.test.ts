import { afterEach, describe, expect, it, vi } from 'vitest';

// 日本語の要約 (表示専用) の対応表の契約: 全公式商品に項目があり、余分な key (消えた商品の残骸・
// 綴り違い) が無い。公式商品を足したのに要約を足し忘れると、日本語ページだけ英文が主役のまま残る。
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadAll() {
  // FIRST_PARTY_RESOURCES は flag で増減する。全 flag を ON にして全件を網羅する。
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_ORDER_RELAY', '1');
  vi.stubEnv('ENABLE_AGENT_ORDER', '1');
  vi.resetModules();
  const { FIRST_PARTY_RESOURCES } = await import('@/lib/x402/firstParty');
  const { USDC_CATALOG_ITEMS } = await import('@/lib/x402/usdcCatalog');
  const { FIRST_PARTY_SUMMARY_JA } = await import('@/lib/x402/catalogSummaryJa');
  const { X402_DEMO_PATH } = await import('@/lib/x402/demoPath');
  return { FIRST_PARTY_RESOURCES, USDC_CATALOG_ITEMS, FIRST_PARTY_SUMMARY_JA, X402_DEMO_PATH };
}

describe('FIRST_PARTY_SUMMARY_JA', () => {
  it('JPYC の公式商品 (デモを除く) と USDC 商品の全 path に項目があり、余分な key が無い', async () => {
    const { FIRST_PARTY_RESOURCES, USDC_CATALOG_ITEMS, FIRST_PARTY_SUMMARY_JA, X402_DEMO_PATH } = await loadAll();
    // flag の stub 漏れで一覧が縮んだまま通るのを防ぐ (tests/lib/llmsTxtDisclosure.test.ts と同じ数)。
    expect(FIRST_PARTY_RESOURCES.length).toBe(7);
    const expected = [
      ...FIRST_PARTY_RESOURCES.map((r) => r.path as string).filter((path) => path !== X402_DEMO_PATH),
      ...USDC_CATALOG_ITEMS.map((item) => new URL(item.resource).pathname),
    ];
    expect(new Set(expected).size).toBe(expected.length);
    const missing = expected.filter((path) => !(path in FIRST_PARTY_SUMMARY_JA));
    expect(missing).toEqual([]);
    const extra = Object.keys(FIRST_PARTY_SUMMARY_JA).filter((path) => !expected.includes(path));
    expect(extra).toEqual([]);
  });

  it('デモは「2円で試す」が受け持つので要約を持たない', async () => {
    const { FIRST_PARTY_SUMMARY_JA, X402_DEMO_PATH } = await loadAll();
    expect(FIRST_PARTY_SUMMARY_JA).not.toHaveProperty(X402_DEMO_PATH);
  });

  it('どの要約も日本語の 1〜2 行 (空でなく、長すぎない)', async () => {
    const { FIRST_PARTY_SUMMARY_JA } = await loadAll();
    for (const [path, text] of Object.entries(FIRST_PARTY_SUMMARY_JA)) {
      expect(text.trim(), path).toBe(text);
      expect(text, path).toMatch(/[぀-ヿ一-鿿]/);
      expect(text.length, path).toBeLessThanOrEqual(80);
    }
  });
});
