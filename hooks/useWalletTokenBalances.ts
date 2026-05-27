'use client';

// 接続ウォレットの JPYC / USDC マルチチェーン残高を React Query で提供する hook。
// useCrossChainPayment の balancesQuery と同型 (queryKey に env.networkEnv + account を
// 含め環境横断 cache 衝突を防ぐ、staleTime 30s)。

import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import type { Address } from 'viem';
import { env } from '@/lib/env';
import {
  readWalletTokenBalances,
  type TokenChainBalance,
} from '@/lib/walletBalances';

export function useWalletTokenBalances(enabled: boolean = true) {
  const { address } = useAccount();
  return useQuery<TokenChainBalance[]>({
    queryKey: ['walletTokenBalances', env.networkEnv, address ?? null],
    queryFn: async () => {
      if (!address) throw new Error('wallet not connected');
      return readWalletTokenBalances(address as Address);
    },
    enabled: enabled && Boolean(address),
    staleTime: 30_000,
  });
}
