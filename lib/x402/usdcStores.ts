// USDC (Base) で販売する stores リソースの単一情報源 (route と /openapi.json が共用)。
// JPYC 版 (/api/paid/stores・5 JPYC + 手数料 1 JPYC = 買い手総額 6 JPYC ≈ ¥6) と
// 概ね等価の $0.04。データは lib/explore の EXPLORE_ENTRIES (JPYC 版と同一)。
export const USDC_STORES = {
  path: '/api/paid/usdc/stores',
  price: '$0.04',
  priceUsd: '0.04',
  // 掲載面 (CDP Bazaar / agentic.market) のカード文言はこの description がそのまま出る
  // (2026-08-20 実測)。買い手は英語圏の AI エージェントなので、①何が返るか ②JPYC が何か
  // ③検索キーワード (JPYC/Japan/stablecoin) を優先し、カード側に別フィールドがある
  // 「x402・USDC on Base」の重複は削る。
  description:
    "Where JPYC (Japan's yen-pegged stablecoin) is accepted: curated exchanges, DEXes, dApps and bridges as JSON, each with category, supported assets and an official URL.",
} as const;

/** CDP Bazaar / agentic.market 向けの応答例 (実データ先頭 2 件・形は route と同一)。 */
export const USDC_STORES_BAZAAR = {
  output: {
    example: {
      items: [
        {
          name: 'JPYC EX',
          category: 'exchange',
          url: 'https://jpyc.co.jp/',
          badges: ['jp-only'],
          assets: ['jpyc'],
        },
        {
          name: 'Uniswap',
          category: 'dex',
          url: 'https://app.uniswap.org/',
          badges: ['global'],
          assets: ['usdc'],
        },
      ],
    },
  },
} as const;
