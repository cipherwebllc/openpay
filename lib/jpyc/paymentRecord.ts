import 'server-only';

import { TransactionReceiptNotFoundError, formatUnits, parseEventLogs, type Hex } from 'viem';
import type { JpycChainSlug } from '@/lib/chains';
import { readJpycFinality, usesFinalizedTag } from './finality';
import { clientFor, deploymentFor, TRANSFER_EVENT, withTimeout } from './live';

const HASH32 = /^0x[0-9a-fA-F]{64}$/;

// 2 つの block hash が同じか。どちらかが 32 byte の hash の形でなければ比べられない (null)。
function sameBlockHash(a: unknown, b: unknown): boolean | null {
  if (typeof a !== 'string' || typeof b !== 'string' || !HASH32.test(a) || !HASH32.test(b)) return null;
  return a.toLowerCase() === b.toLowerCase();
}

export async function readJpycPaymentRecord(slug: JpycChainSlug, txHash: Hex) {
  const deployment = deploymentFor(slug);
  const client = clientFor(deployment.chainId);
  try {
    const receipt = await withTimeout(client.getTransactionReceipt({ hash: txHash })).catch((error: unknown) => {
      // Missing receipts are a content miss; other RPC failures must remain unavailable.
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    });
    if (!receipt) return { kind: 'not_found' } as const;
    if (receipt.status !== 'success') return { kind: 'no_jpyc_transfer' } as const;
    const logs = parseEventLogs({
      abi: [TRANSFER_EVENT],
      logs: receipt.logs.filter((log) => log.address.toLowerCase() === deployment.address.toLowerCase()),
      strict: true,
    });
    if (!logs.length) return { kind: 'no_jpyc_transfer' } as const;
    const transfers = logs.map((log) => ({
      logIndex: log.logIndex,
      from: log.args.from,
      to: log.args.to,
      value: log.args.value.toString(),
      valueJpyc: formatUnits(log.args.value, 18),
    }));
    const [block, latest] = await Promise.all([
      withTimeout(client.getBlock({ blockHash: receipt.blockHash })),
      withTimeout(client.getBlockNumber({ cacheTime: 0 })),
    ]);
    // 確定の高さに届いていても、receipt のブロックが組み替えで外れたもの (別のフォーク) なら確定ではない (2026-11-25 外部
    // レビュー #8)。同じ高さの今の正規のブロックの hash と比べ、読めない・形の違う hash なら「分からない」(null)。
    // この記録は settle の前に作るので、正規のブロックは確定の高さと同時に読む (settle を待たせる時間を足さない・Codex)。
    // 先に正規のブロックを読んで、その後で確定の高さが届くまでの間に組み替えが起きる窓は、確定の高さが秒単位で遅れて
    // 進むので実際には無い (lib/orderLinkVerify.ts は順に読むが、こちらは settle の前なので待ちを増やさない方を取る)。
    // finality は署名の外の参考の欄なので、settle と署名の対象 (blockNumber 等) は変えない。Kaia・Avalanche は読まない。
    const canonicalRead = usesFinalizedTag(slug)
      ? withTimeout(client.getBlock({ blockNumber: receipt.blockNumber })).then(
          (canonicalBlock) => sameBlockHash(canonicalBlock.hash, receipt.blockHash),
          () => null,
        )
      : Promise.resolve(true as boolean | null);
    // Unsupported finalized tags must not hide an otherwise readable payment record (finalized: null).
    const [tagFinality, canonical] = await Promise.all([
      readJpycFinality({
        slug,
        blockNumber: receipt.blockNumber,
        readFinalizedBlock: () => withTimeout(client.getBlock({ blockTag: 'finalized' })),
      }),
      canonicalRead,
    ]);
    // 確定の高さに届いた (true) ときだけ、正規のブロックの結果で確定を絞る (届いていない・分からないはそのまま)。
    const finality =
      tagFinality.finalized === true && canonical !== true
        ? { ...tagFinality, finalized: canonical === false ? false : null }
        : tagFinality;
    return {
      kind: 'ok',
      record: {
        chain: slug, chainId: deployment.chainId, txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
        blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
        txStatus: 'success', from: receipt.from, to: receipt.to,
        confirmations: (latest - receipt.blockNumber + 1n).toString(), finality,
        token: { symbol: 'JPYC', decimals: 18, contract: deployment.address },
        transfers,
        totals: { count: transfers.length, valueJpyc: formatUnits(logs.reduce((sum, log) => sum + log.args.value, 0n), 18) },
        observedAt: new Date().toISOString(),
      },
    } as const;
  } catch {
    // RPC outages become a non-settling content error; never expose RPC URLs.
    return { kind: 'rpc_error' } as const;
  }
}
