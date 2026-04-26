'use client';

// ERC-7702 により EOA アドレスがそのまま Smart Account として振る舞うので、
// 顧客は別アドレスへ事前送金する必要がない。初回 UserOp 時にウォレットが
// signAuthorization を求められる (permissionless が Authorization List を組成)。

import { useQuery } from '@tanstack/react-query';
import { http } from 'viem';
import { createSmartAccountClient } from 'permissionless';
import { to7702SimpleSmartAccount } from 'permissionless/accounts';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { isSupportedChainId } from '@/lib/chains';
import {
  createPimlico,
  pimlicoPaymasterContext,
  pimlicoUrl,
} from '@/lib/pimlico';

export function useSmartAccount(enabled: boolean = true) {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { address, chainId } = useAccount();

  return useQuery({
    enabled:
      enabled &&
      !!walletClient &&
      !!publicClient &&
      !!address &&
      isSupportedChainId(chainId),
    queryKey: ['openpay', 'smart-account', address, chainId],
    queryFn: async () => {
      // enabled で全条件を確認済みだが TS の narrowing のために再チェック
      if (!walletClient || !publicClient || !chainId) {
        throw new Error('not ready');
      }

      const pimlicoClient = createPimlico(chainId);

      const account = await to7702SimpleSmartAccount({
        client: publicClient,
        owner: walletClient,
      });

      const smartAccountClient = createSmartAccountClient({
        account,
        chain: walletClient.chain,
        bundlerTransport: http(pimlicoUrl(chainId)),
        paymaster: pimlicoClient,
        paymasterContext: pimlicoPaymasterContext(),
        userOperation: {
          estimateFeesPerGas: async () =>
            (await pimlicoClient.getUserOperationGasPrice()).fast,
        },
      });

      return { smartAccountClient, pimlicoClient };
    },
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}
