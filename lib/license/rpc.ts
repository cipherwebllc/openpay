import 'server-only';

import { createPublicClient, http, type Transport } from 'viem';
import { chainObjectForId, customRpcUrlForChain } from '@/lib/chains';

export const LICENSE_RPC_TIMEOUT_MS = 2_000;

/** RPC の停止を cron の lease 超過・公開 API の接続占有へ波及させない。 */
export function licenseTransport(chainId: number, deadline = Infinity): Transport {
  const transport = http(customRpcUrlForChain(chainId), { timeout: LICENSE_RPC_TIMEOUT_MS, retryCount: 0 });
  return (options) => {
    const base = transport(options);
    return { ...base, request: ((...args: Parameters<typeof base.request>) => {
      // prepareTransactionRequest 内の複数 RPC も、dispatch 期限を越えて発行しない。
      if (Date.now() >= deadline) throw new Error('license dispatch deadline');
      return base.request(...args);
    }) as typeof base.request };
  };
}

export function licenseRpc(chainId: number, deadline = Infinity) {
  const chain = chainObjectForId(chainId);
  if (!chain) throw new Error('unsupported license chain');
  return createPublicClient({
    chain,
    transport: licenseTransport(chainId, deadline),
  });
}
