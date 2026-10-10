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
export const RECONCILE_BATCH_MAX = 10;

/** 照合の対象 = 確認待ち (pending) で、照会できる txHash と chainId を持つ控え。 */
export function isReconcilableReceipt(r: PayerReceipt): boolean {
  return r.status === 'pending' && r.txHash != null && r.chainId != null;
}

/** 照会した控え 1 件の結果。status 'unknown' (未着・RPC 失敗) は確定していない (呼び出し側が後で再照会する)。 */
export type ReceiptReconcileResult = {
  receiptId: string;
  status: ReceiptTxStatus;
  /** ストアの控えを昇格して保存できたか (既に pending でない・控えの tx が付け替わった・保存できなかったら false)。 */
  promoted: boolean;
};

/**
 * pending 控えを on-chain receipt と突き合わせ、確定済みを昇格する。戻り値 = 実際に照会した控えと結果
 * (対象外・max を超えて照会しなかった控えは含まない = 呼び出し側は「照合済み」と扱わない)。
 *
 * 対象は isReconcilableReceipt の控え。新しい順 (受け取った配列順) に最大 max 件 (既定 10) を並列に
 * fetchStatus し、'success' → confirmed、'reverted' → failed に昇格、'unknown' は何もしない (pending のまま)。
 */
export async function reconcilePendingReceipts(
  receipts: PayerReceipt[],
  fetchStatus: ReceiptStatusFetcher,
  opts: { max?: number } = {},
): Promise<ReceiptReconcileResult[]> {
  const max = opts.max ?? RECONCILE_BATCH_MAX;
  const targets = receipts.filter(isReconcilableReceipt).slice(0, max);
  return Promise.all(
    targets.map(async (r) => {
      // 照会した tx。昇格はストアの控えがまだこの tx を指しているときだけ (照会の間の付け替えで古い結果を書かない)。
      const tx = { chainId: r.chainId as number, txHash: r.txHash as string };
      const status = await fetchStatus(tx.chainId, tx.txHash);
      const promoted =
        status === 'success'
          ? promotePayerReceiptStatus(r.receiptId, 'confirmed', tx)
          : status === 'reverted'
            ? promotePayerReceiptStatus(r.receiptId, 'failed', tx)
            : false;
      return { receiptId: r.receiptId, status, promoted };
    }),
  );
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
