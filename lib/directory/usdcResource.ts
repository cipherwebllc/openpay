// USDC (Base mainnet) で販売する Japan Web3 Directory リソースの単一情報源。
// route (app/api/paid/usdc/japan-web3-directory) と /openapi.json が共用する。
//
// JPYC 版 (/api/paid/japan-web3-directory・forwarder-split・自前 facilitator) とは**別 money-path**:
// こちらは vanilla x402 (x402-next + 外部 facilitator) の直接販売で、OpenPay 手数料は存在せず
// 表示価格の 100% が payTo に届く。x402scan (Base/USDC のみ index・Polygon 拒否を 2026-07-28 実測)
// への掲載面として新設した。
//
// 価格 $0.02 の根拠: JPYC 版の買い手総額 (2 JPYC + facilitator 手数料 1 JPYC = 3 JPYC ≈ ¥3) と
// 概ね等価。同じデータを通貨面で安売り/高売りしない。

export const USDC_DIRECTORY_LIST = {
  path: '/api/paid/usdc/japan-web3-directory',
  /** x402-next の Money 形式 (USD 表記・base network では USDC 6 桁 atomic へ変換される)。 */
  price: '$0.02',
  /** openapi の x-payment-info (機械可読) 用の数値文字列。price と一致させること。 */
  priceUsd: '0.02',
  description:
    "Japan Web3 Directory (full list) — curated structured records covering Japan's JPYC, USDC, Web3 and AI-agent ecosystem. Standard x402, USDC on Base.",
} as const;
