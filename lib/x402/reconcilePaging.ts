import type { Hex } from 'viem';

// Bounded scan mechanics shared by the rails. Callers retain RPC error handling,
// leases, candidate verification/adoption and cursor persistence policy.
type ScanRange = {
  anchor: bigint;
  fromBlock: bigint;
  latest: bigint;
  pageBlocks: bigint;
  maxPages: number;
  // 経過時間の予算 (第 7 回レビュー B4): 各ページ取得の前に呼び、null なら取りに行かず (そのページの先頭を
  // cursor として返す)、number ならその timeout で fetchPage を呼ぶ (RPC 1 回が予算を越えない)。呼出側は
  // lib/x402/reconcileBudget の pageFetchTimeout (残り時間 − cursor 保存の予約) を渡す。打ち切りは失敗ではない。
  pageTimeout?: () => number | null;
};
// interrupted = ページ取得の失敗/timeout。取得済みページの候補はそのまま返し、nextFromBlock は失敗したページの先頭
// (呼出側は候補を照合してからそこを cursor に保存する = 前進を保証・B4 follow-up 2)。
export type ScanInterruption = { reason: 'unavailable' } | { reason: 'error'; error: unknown };
type ScanResult = {
  candidates: Map<Hex, bigint>;
  nextFromBlock: bigint;
  interrupted?: ScanInterruption;
};
export type PageFetchOptions = { timeoutMs: number };
// The JPYC adapter throws on failure; USDC returns an unavailable sentinel. Both end the scan the same way.
type FetchPage = (fromBlock: bigint, toBlock: bigint, options?: PageFetchOptions) => Promise<Hex[] | 'unavailable'>;

export async function scanReconcileBlockPages(
  { anchor, fromBlock, latest, pageBlocks, maxPages, pageTimeout }: ScanRange,
  fetchPage: FetchPage,
): Promise<ScanResult> {
  if (fromBlock < anchor) fromBlock = anchor;
  const candidates = new Map<Hex, bigint>();
  let pages = 0;
  while (fromBlock <= latest && pages < maxPages) {
    // 予算切れは取得前に見る: 取得済みページの候補は呼出側が照合し、未取得ページの先頭が次回の cursor になる。
    const timeoutMs = pageTimeout?.();
    if (timeoutMs === null) break;
    const pageEnd = fromBlock + pageBlocks - 1n;
    const toBlock = pageEnd > latest ? latest : pageEnd;
    let hashes: Hex[] | 'unavailable';
    try {
      hashes = timeoutMs === undefined
        ? await fetchPage(fromBlock, toBlock)
        : await fetchPage(fromBlock, toBlock, { timeoutMs });
    } catch (error) {
      return { candidates, nextFromBlock: fromBlock, interrupted: { reason: 'error', error } };
    }
    if (hashes === 'unavailable') return { candidates, nextFromBlock: fromBlock, interrupted: { reason: 'unavailable' } };
    for (const hash of hashes) {
      if (!candidates.has(hash)) candidates.set(hash, fromBlock);
    }
    fromBlock = toBlock + 1n;
    pages += 1;
  }
  return { candidates, nextFromBlock: fromBlock <= latest ? fromBlock : anchor };
}
