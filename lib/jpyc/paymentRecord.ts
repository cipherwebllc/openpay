import 'server-only';

import { TransactionReceiptNotFoundError, formatUnits, parseEventLogs, type Hex } from 'viem';
import type { JpycChainSlug } from '@/lib/chains';
import { clientFor, deploymentFor, TRANSFER_EVENT, withTimeout } from './live';

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
    let finality: { finalized: boolean | null; method: 'finalized-tag' | 'confirmations'; finalizedBlock?: string } = {
      finalized: true, method: 'confirmations',
    };
    if (slug === 'polygon' || slug === 'ethereum') {
      try {
        const finalized = await withTimeout(client.getBlock({ blockTag: 'finalized' }));
        finality = {
          finalized: finalized.number >= receipt.blockNumber,
          method: 'finalized-tag', finalizedBlock: finalized.number.toString(),
        };
      } catch {
        // Unsupported finalized tags must not hide an otherwise readable payment record.
        finality = { finalized: null, method: 'confirmations' };
      }
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
