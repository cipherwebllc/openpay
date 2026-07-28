// USDC (Base) で販売する stores リソースの単一情報源 (route と /openapi.json が共用)。
// JPYC 版 (/api/paid/stores・5 JPYC + 手数料 1 JPYC = 買い手総額 6 JPYC ≈ ¥6) と
// 概ね等価の $0.04。データは lib/explore の EXPLORE_ENTRIES (JPYC 版と同一)。
export const USDC_STORES = {
  path: '/api/paid/usdc/stores',
  price: '$0.04',
  priceUsd: '0.04',
  description:
    'Directory of JPYC-accepting exchanges, dApps and bridges (curated JSON with attribution). Standard x402, USDC on Base.',
} as const;
