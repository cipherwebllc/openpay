// pending 控え (PayerReceipt) を on-chain receipt と突き合わせ、確定済みを昇格する。
//
// relay/gasless 経路は tx を broadcast した後 receipt を待たず pending (txHash あり) を
// 返すことがある。その控えは status='pending' (青ドット) で保存されるが、後から confirmed
// を再 emit する仕組みが無いため永久に「確認待ち」のまま残る。本モジュールは hydrate 後に
// pending 控えの txHash を on-chain receipt で照合し、確定済みを promotePayerReceiptStatus
// で昇格する (lib/jpycRelay の DI 様式に倣い fetchStatus を注入可能にする)。

import { createPublicClient } from 'viem';
import { chainObjectForId, transportForChain } from './chains';
import {
  promotePayerReceiptStatus,
  type PayerReceipt,
} from './payerReceipt';

export type ReceiptTxStatus = 'success' | 'reverted' | 'unknown';
export type ReceiptStatusFetcher = (
  chainId: number,
  txHash: string,
) => Promise<ReceiptTxStatus>;

/** reconcile が一度に照合する pending 控えの既定上限 (新しい順)。 */
const DEFAULT_MAX = 10;

/**
 * pending 控えを on-chain receipt と突き合わせ、確定済みを昇格する。戻り値 = 昇格件数。
 *
 * 対象は status==='pending' かつ txHash / chainId を持つ控え。新しい順 (受け取った配列順)
 * に最大 max 件 (既定 10) を並列に fetchStatus し、'success' → confirmed、'reverted' →
 * failed に昇格、'unknown' は何もしない (pending のまま = 既存セマンティクス)。
 */
export async function reconcilePendingReceipts(
  receipts: PayerReceipt[],
  fetchStatus: ReceiptStatusFetcher,
  opts: { max?: number } = {},
): Promise<number> {
  const max = opts.max ?? DEFAULT_MAX;
  const targets = receipts
    .filter(
      (r) => r.status === 'pending' && r.txHash != null && r.chainId != null,
    )
    .slice(0, max);
  if (targets.length === 0) return 0;

  const results = await Promise.all(
    targets.map(async (r) => {
      const status = await fetchStatus(r.chainId as number, r.txHash as string);
      if (status === 'success') {
        return promotePayerReceiptStatus(r.receiptId, 'confirmed');
      }
      if (status === 'reverted') {
        return promotePayerReceiptStatus(r.receiptId, 'failed');
      }
      return false;
    }),
  );
  return results.filter(Boolean).length;
}

/**
 * 既定 fetcher: chainId の RPC で getTransactionReceipt し on-chain status を返す。
 * 未対応 chainId (chainObjectForId が undefined) は 'unknown'。viem は receipt 未発見で
 * throw する (TransactionReceiptNotFoundError) ため catch して 'unknown' を返す — これは
 * 「未だ採掘されていない pending を pending のまま残す」ための必要な制御フローであり、
 * RPC 失敗も同様に 'unknown' へ倒す (確定情報が得られないので昇格しない)。
 */
export async function fetchReceiptTxStatus(
  chainId: number,
  txHash: string,
): Promise<ReceiptTxStatus> {
  const chain = chainObjectForId(chainId);
  if (!chain) return 'unknown';
  try {
    const client = createPublicClient({
      chain,
      transport: transportForChain(chain.id),
    });
    const receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });
    return receipt.status === 'success' ? 'success' : 'reverted';
  } catch {
    return 'unknown';
  }
}
