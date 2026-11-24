import 'server-only';

import { TransactionReceiptNotFoundError, formatUnits, parseEventLogs, type Hex } from 'viem';
import type { JpycChainSlug } from '@/lib/chains';
import { readJpycFinality, usesFinalizedTag } from './finality';
import { clientFor, deploymentFor, TRANSFER_EVENT, withTimeout } from './live';

const HASH32 = /^0x[0-9a-fA-F]{64}$/;
// 確定の高さに届いたとき、正規のブロックの読み取りを待つ上限 (settle の前に足す待ちの上限)。
export const CANONICAL_WAIT_MS = 1_000;

function isBlockHash(value: unknown): value is Hex {
  return typeof value === 'string' && HASH32.test(value);
}

// 2 つの block hash が同じか。どちらかが 32 byte の hash の形でなければ比べられない (null)。
function sameBlockHash(a: unknown, b: unknown): boolean | null {
  if (!isBlockHash(a) || !isBlockHash(b)) return null;
  return a.toLowerCase() === b.toLowerCase();
}

// p を最大 ms だけ待つ。間に合わなければ null (p は止めない・失敗は p の側で null にしてある)。
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
    // receipt のブロックの hash が 32 byte の形でなければ、スキーマどおりの記録 (blockHash は必須) を作れない。壊れた RPC の
    // 応答なので、既存の RPC の失敗と同じく返す (settle しない・Codex)。
    if (!isBlockHash(receipt.blockHash)) return { kind: 'rpc_error' } as const;
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
    // この記録は settle の前に作るので、settle の前に足す待ちを決めておく (Codex):
    // - 正規のブロックは確定の高さと同時に読み始める。
    // - 確定の高さに届いていない・分からないときは、正規のブロックを待たない (結果は要らない)。
    // - 届いたときだけ、確定の高さが返ってから最大 CANONICAL_WAIT_MS 待つ。間に合わなければ「分からない」(null)。
    // 先に読んだ正規のブロックと後で届く確定の高さの間に組み替えが起きる窓は、確定の高さが秒単位で遅れて進むので実際には
    // 無い (lib/orderLinkVerify.ts は順に読むが、こちらは settle の前なので待ちを増やさない方を取る)。
    // finality は署名の外の参考の欄なので、settle と署名の対象 (blockNumber 等) は変えない。Kaia・Avalanche は読まない。
    const canonicalRead = usesFinalizedTag(slug)
      ? withTimeout(client.getBlock({ blockNumber: receipt.blockNumber })).then(
          (canonicalBlock) => sameBlockHash(canonicalBlock.hash, receipt.blockHash),
          () => null,
        )
      : null;
    // Unsupported finalized tags must not hide an otherwise readable payment record (finalized: null).
    const tagFinality = await readJpycFinality({
      slug,
      blockNumber: receipt.blockNumber,
      readFinalizedBlock: () => withTimeout(client.getBlock({ blockTag: 'finalized' })),
    });
    let finality = tagFinality;
    if (tagFinality.finalized === true && canonicalRead) {
      const canonical = await within(canonicalRead, CANONICAL_WAIT_MS);
      if (canonical !== true) finality = { ...tagFinality, finalized: canonical === false ? false : null };
    }
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
