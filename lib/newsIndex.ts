// お知らせの索引 (id + date だけ)。ヘッダの未読バッジ (hooks/useNewsRead.ts) は全ページに載るので、
// 本文 (ja/en) を持つ lib/news.ts をここから import しない — 本文が全ルートの First Load JS に入り、
// お知らせが増えるたびに bundle 予算 (scripts/check-bundle-budget.mjs) を圧迫する (2026-09-14 /create が
// 393/392 kB で CI fail)。本文は /news ページ (components/NewsList) だけが lib/news.ts から読む。
//
// SOT は lib/news.ts の NEWS_ITEMS。この索引は同じ id/date を同じ順で複製したもので、
// tests/lib/newsIndex.test.ts が両者の一致をフェンスする (お知らせを足したら両方に追記)。

export type NewsIndexEntry = { id: string; date: string };

export const NEWS_INDEX: readonly NewsIndexEntry[] = [
  { id: 'agent-page-local-wallet-2026-09-21', date: '2026-09-21' },
  { id: 'store-product-details-2026-09-18', date: '2026-09-18' },
  { id: 'x402-arc-gateway-2026-09-17', date: '2026-09-17' },
  { id: 'usdc-arc-crosschain-2026-09-17', date: '2026-09-17' },
  { id: 'usdc-arc-tip-2026-09-17', date: '2026-09-17' },
  { id: 'usdc-arc-2026-09-17', date: '2026-09-17' },
  { id: 'license-nft-protected-delivery-2026-09-14', date: '2026-09-14' },
  { id: 'profile-branding-2026-09-12', date: '2026-09-12' },
  { id: 'transparency-external-purchases-2026-09-11', date: '2026-09-11' },
  { id: 'ai-data-products-2026-09-01', date: '2026-09-01' },
  { id: 'store-usdc-2026-08-17', date: '2026-08-17' },
  { id: 'store-marketplace-guides-2026-08-09', date: '2026-08-09' },
  { id: 'handle-embeds-2026-08-01', date: '2026-08-01' },
  { id: 'creator-store-launch-2026-07-30', date: '2026-07-30' },
  { id: 'tip-question-box-2026-07-29', date: '2026-07-29' },
  { id: 'x402-fee-floor-2026-07-05', date: '2026-07-05' },
  { id: 'x402-facilitator-launch-2026-06-28', date: '2026-06-28' },
  { id: 'x402-facilitator-2026-06-24', date: '2026-06-24' },
  { id: 'mobile-order-fee-2026-06-18', date: '2026-06-18' },
  { id: 'per-tx-fee-2026-06-12', date: '2026-06-12' },
  { id: 'jpyc-map-added', date: '2026-06-10' },
  { id: 'usage-fee-2026-07', date: '2026-06-09' },
  { id: 'jpyc-gasless-free', date: '2026-06-05' },
];

/** date 降順 (新しい順)。lib/news.ts の sortedNews と同じ比較。 */
export function sortedNewsIndex(): readonly NewsIndexEntry[] {
  return [...NEWS_INDEX].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 最新 (sortedNewsIndex の先頭) の id。未読判定の基準。空なら null。 */
export function latestNewsId(): string | null {
  return sortedNewsIndex()[0]?.id ?? null;
}
