// JPYC の取引が確定したか (チェーンの組み替え = reorg で消えないか) の読み方の単一情報源。
// - Polygon と Ethereum は RPC の `finalized` タグを読み、確定したブロックが取引のブロックまで進んだかを見る。
// - それ以外 (Kaia・Avalanche) はブロックが出た時点で確定するチェーンなので、読めた時点で確定とする。
// - タグを読めない (未対応の RPC・問い合わせの失敗) ときは確定を「分からない」(finalized: null) とし、確定とも
//   未確定とも言わない。
// 使う所: lib/jpyc/paymentRecord.ts (有料 API の支払いの記録)・lib/orderLinkVerify.ts (注文リンクの入金を確かめる)。
// server と browser の両方から読むので server-only にしない (RPC は呼び出し側が渡す)。

import type { ChainSlug } from '@/lib/chains';

export type JpycFinality = {
  finalized: boolean | null;
  method: 'finalized-tag' | 'confirmations';
  finalizedBlock?: string;
};

/** `finalized` タグで確定を見るチェーン。ほかのチェーンはブロックが出た時点で確定する。 */
export function usesFinalizedTag(slug: ChainSlug): boolean {
  return slug === 'polygon' || slug === 'ethereum';
}

/** blockNumber のブロックに入った取引が確定したか。readFinalizedBlock は呼び出し側の RPC (と時間切れ) で読む。 */
export async function readJpycFinality(input: {
  slug: ChainSlug;
  blockNumber: bigint;
  readFinalizedBlock: () => Promise<{ number: bigint }>;
}): Promise<JpycFinality> {
  if (!usesFinalizedTag(input.slug)) return { finalized: true, method: 'confirmations' };
  try {
    const finalized = await input.readFinalizedBlock();
    return {
      finalized: finalized.number >= input.blockNumber,
      method: 'finalized-tag',
      finalizedBlock: finalized.number.toString(),
    };
  } catch {
    // タグ未対応の RPC・問い合わせの失敗は「分からない」にする (読めた支払いそのものは隠さない)。
    return { finalized: null, method: 'confirmations' };
  }
}
