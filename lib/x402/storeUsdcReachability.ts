import 'server-only';

import { createPublicClient, getAddress, isAddress, type Address } from 'viem';
import { polygon } from 'viem/chains';
import { transportForChain } from '@/lib/chains';

export type StoreUsdcPayToReachability =
  | { ok: true; payTo: Address }
  | { ok: false; reason: 'contract_wallet' | 'rpc_unavailable' | 'invalid' };

/**
 * USDC 公開時の payTo fence。
 *
 * Polygon 上で code を持つ address は contract wallet であり、同じ address が Base でも
 * 操作可能とは限らない。Base USDC を回収不能にする設定を署名前に止め、EOA だけを許可する。
 */
export async function checkStoreUsdcPayToReachability(
  rawPayTo: string,
): Promise<StoreUsdcPayToReachability> {
  if (!isAddress(rawPayTo)) return { ok: false, reason: 'invalid' };
  const payTo = getAddress(rawPayTo);
  const client = createPublicClient({
    chain: polygon,
    transport: transportForChain(polygon.id),
  });
  try {
    const code = await client.getBytecode({ address: payTo });
    return code && code !== '0x'
      ? { ok: false, reason: 'contract_wallet' }
      : { ok: true, payTo };
  } catch {
    // RPC 障害を EOA と誤認すると回収不能な USDC rail を公開するため fail-closed。
    return { ok: false, reason: 'rpc_unavailable' };
  }
}
