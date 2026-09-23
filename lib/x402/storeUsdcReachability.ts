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
 * Polygon 上で実コントラクトの code を持つ address は、同じ address が Base でも
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
    // 7702 の正確な 23-byte designator は EOA の委任先を示すだけで、秘密鍵の支配は残る。
    // 委任済み EOA を実コントラクトと誤認して USDC 公開を拒否する波及を断つ (accountDetection と同形式)。
    // keyless 7702 の例外は識別しない。この fence だけで Base 上の鍵/委任先の操作可能性までは証明しない。
    const delegatedEoa = code !== undefined && /^0xef0100[0-9a-f]{40}$/i.test(code);
    return code && code !== '0x' && !delegatedEoa
      ? { ok: false, reason: 'contract_wallet' }
      : { ok: true, payTo };
  } catch {
    // RPC 障害を EOA と誤認すると回収不能な USDC rail を公開するため fail-closed。
    return { ok: false, reason: 'rpc_unavailable' };
  }
}
