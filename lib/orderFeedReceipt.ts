// 受注の tx の receipt を、お店の端末から RPC で 1 回読む (今ある transport = lib/chains.ts の transportForChain)。
// server は通らない。読めないときは throw する (回数の上限と、読めなかったときの扱いは lib/orderFeedHistoryRecorder.ts)。
// テストの既定は「読めない」スタブ (tests/setup.ts): テストが外の RPC を叩かない。

import { createPublicClient, type Hex, type PublicClient } from 'viem';
import { chainObjectForId, transportForChain } from './chains';
import type { OrderSaleReceipt } from './orderFeedHistory';

/** RPC 1 回の待ち時間の上限。送り直しはしない (回数は recorder が数える)。 */
export const ORDER_RECEIPT_TIMEOUT_MS = 6_000;

const clients = new Map<number, PublicClient>();

export async function readOrderReceipt(chainId: number, txHash: Hex): Promise<OrderSaleReceipt> {
  let client = clients.get(chainId);
  if (!client) {
    const chain = chainObjectForId(chainId);
    if (!chain) throw new Error('order_receipt_unsupported_chain');
    client = createPublicClient({
      chain,
      transport: transportForChain(chainId, { timeout: ORDER_RECEIPT_TIMEOUT_MS, retryCount: 0 }),
    });
    clients.set(chainId, client);
  }
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  return { status: receipt.status, blockNumber: receipt.blockNumber, logs: receipt.logs };
}
