import 'server-only';

import { createPublicClient, http, type Transport } from 'viem';
import { chainObjectForId, customRpcUrlForChain, rpcRequestSignal } from '@/lib/chains';

export const LICENSE_RPC_TIMEOUT_MS = 2_000;

/**
 * RPC の停止を cron の lease 超過・公開 API の接続占有へ波及させない。
 * deadline (絶対・epoch ms) は dispatch 前の確認に加えて、RPC の開始時に「残り時間と 2 秒の小さい方」から作った
 * 本文受信まで効く abort signal にもする (第 7 回レビュー B13 follow-up: http.timeout はヘッダー受信までなので、
 * 本文が止まるとページ期限を越えて待ち続け、RPC 枠も持ち続けていた)。signal は RPC ごとに作る。
 */
export function licenseTransport(chainId: number, deadline = Infinity): Transport {
  const transport = http(customRpcUrlForChain(chainId), {
    timeout: LICENSE_RPC_TIMEOUT_MS,
    retryCount: 0,
    onFetchRequest: (request, init) => ({
      ...init,
      url: request.url,
      signal: rpcRequestSignal(Number.isFinite(deadline) ? deadline : undefined, LICENSE_RPC_TIMEOUT_MS),
    }),
  });
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
