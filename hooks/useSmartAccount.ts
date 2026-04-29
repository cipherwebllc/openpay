'use client';

// ERC-7702 で EOA を Smart Account 化 (初回 UserOp で signAuthorization が出る)。
// ERC20 mode のときは prepareUserOperationForErc20Paymaster が calls 先頭に
// paymaster への approve を自動注入する (allowance 不足時のみ)。

import { useQuery } from '@tanstack/react-query';
import { http } from 'viem';
import { createSmartAccountClient } from 'permissionless';
import { to7702SimpleSmartAccount } from 'permissionless/accounts';
import { prepareUserOperationForErc20Paymaster } from 'permissionless/experimental/pimlico';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { isSupportedChainId } from '@/lib/chains';
import {
  createPimlico,
  pimlicoPaymasterContext,
  pimlicoUrl,
  resolvePaymasterMode,
} from '@/lib/pimlico';
import type { TokenDeployment } from '@/lib/tokens';

export function useSmartAccount(
  deployment: TokenDeployment,
  enabled: boolean = true,
) {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { address, chainId } = useAccount();

  return useQuery({
    enabled:
      enabled &&
      !!walletClient &&
      !!publicClient &&
      !!address &&
      isSupportedChainId(chainId) &&
      chainId === deployment.chainId,
    queryKey: [
      'openpay',
      'smart-account',
      address,
      chainId,
      deployment.symbol,
      deployment.chainId,
    ],
    queryFn: async () => {
      // enabled で全条件を確認済みだが TS の narrowing のために再チェック
      if (!walletClient || !publicClient || !chainId) {
        throw new Error('not ready');
      }

      const pimlicoClient = createPimlico(chainId);
      const paymasterMode = resolvePaymasterMode(deployment);

      const account = await to7702SimpleSmartAccount({
        client: publicClient,
        owner: walletClient,
      });

      const smartAccountClient = createSmartAccountClient({
        account,
        chain: walletClient.chain,
        bundlerTransport: http(pimlicoUrl(chainId)),
        paymaster: pimlicoClient,
        paymasterContext: pimlicoPaymasterContext(deployment),
        userOperation: {
          estimateFeesPerGas: async () =>
            (await pimlicoClient.getUserOperationGasPrice()).fast,
          prepareUserOperation:
            paymasterMode === 'erc20'
              ? prepareUserOperationForErc20Paymaster(pimlicoClient)
              : undefined,
        },
      });

      return { smartAccountClient, pimlicoClient, paymasterMode };
    },
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}
