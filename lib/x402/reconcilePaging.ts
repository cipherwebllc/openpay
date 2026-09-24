import type { Hex } from 'viem';

// Bounded scan mechanics shared by the rails. Callers retain RPC error handling,
// leases, candidate verification/adoption and cursor persistence policy.
type ScanRange = {
  anchor: bigint;
  fromBlock: bigint;
  latest: bigint;
  pageBlocks: bigint;
  maxPages: number;
};
type ScanResult = {
  candidates: Map<Hex, bigint>;
  nextFromBlock: bigint;
};
type FetchPage = (fromBlock: bigint, toBlock: bigint) => Promise<Hex[] | 'unavailable'>;

// The JPYC adapter throws on failure; USDC returns an unavailable sentinel.
// Keep those contracts without requiring an unreachable failure branch in JPYC.
export function scanReconcileBlockPages(
  range: ScanRange,
  fetchPage: (fromBlock: bigint, toBlock: bigint) => Promise<Hex[]>,
): Promise<ScanResult>;
export function scanReconcileBlockPages(
  range: ScanRange,
  fetchPage: FetchPage,
): Promise<ScanResult | 'unavailable'>;
export async function scanReconcileBlockPages(
  { anchor, fromBlock, latest, pageBlocks, maxPages }: ScanRange,
  fetchPage: FetchPage,
): Promise<ScanResult | 'unavailable'> {
  if (fromBlock < anchor) fromBlock = anchor;
  const candidates = new Map<Hex, bigint>();
  let pages = 0;
  while (fromBlock <= latest && pages < maxPages) {
    const pageEnd = fromBlock + pageBlocks - 1n;
    const toBlock = pageEnd > latest ? latest : pageEnd;
    const hashes = await fetchPage(fromBlock, toBlock);
    if (hashes === 'unavailable') return 'unavailable';
    for (const hash of hashes) {
      if (!candidates.has(hash)) candidates.set(hash, fromBlock);
    }
    fromBlock = toBlock + 1n;
    pages += 1;
  }
  return { candidates, nextFromBlock: fromBlock <= latest ? fromBlock : anchor };
}
