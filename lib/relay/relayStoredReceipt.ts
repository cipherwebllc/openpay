import { createPublicClient, type Hex } from 'viem';
import {
  chainObjectForId,
  transportForChain,
} from '@/lib/chains';

/**
 * 現在ページと異なる chain の保存済み relay intent を read-only で終端確認する。
 * current deployment の client だけに束縛して成立済み intent が unknown へ永久固着し、
 * タブ内の全決済を塞ぎ続ける波及を断つ。
 */
export async function waitForStoredRelayReceipt(
  chainId: number,
  hash: Hex,
  timeout: number,
): Promise<{ status: 'success' | 'reverted' }> {
  const chain = chainObjectForId(chainId);
  if (!chain) throw new Error('unsupported_stored_chain');
  const client = createPublicClient({
    chain,
    transport: transportForChain(chainId),
  });
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout,
  });
  return { status: receipt.status };
}
