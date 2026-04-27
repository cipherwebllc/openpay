'use client';

// ERC-7702 により EOA アドレスがそのまま Smart Account として振る舞うので、
// 顧客は別アドレスへ事前送金する必要がない。初回 UserOp 時にウォレットが
// signAuthorization を求められる (permissionless が Authorization List を組成)。
//
// Paymaster は token に応じて分岐:
//   - sponsorship: 運営がガスを肩代わり
//   - erc20:       顧客が指定トークン (USDC) でガスを支払う
//                  prepareUserOperationForErc20Paymaster が UserOp の calls 先頭に
//                  paymaster コントラクトへの ERC20 approve を自動挿入する。
//                  既存 allowance が見積コストを上回っていれば挿入をスキップ。

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
import type { TokenSymbol } from '@/lib/tokens';

export function useSmartAccount(token: TokenSymbol, enabled: boolean = true) {
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
    queryKey: ['openpay', 'smart-account', address, chainId, token],
    queryFn: async () => {
      // enabled で全条件を確認済みだが TS の narrowing のために再チェック
      if (!walletClient || !publicClient || !chainId) {
        throw new Error('not ready');
      }

      const pimlicoClient = createPimlico(chainId);
      const paymasterMode = resolvePaymasterMode(token);

      const account = await to7702SimpleSmartAccount({
        client: publicClient,
        owner: walletClient,
      });

      const smartAccountClient = createSmartAccountClient({
        account,
        chain: walletClient.chain,
        bundlerTransport: http(pimlicoUrl(chainId)),
        paymaster: pimlicoClient,
        paymasterContext: pimlicoPaymasterContext(token),
        userOperation: {
          estimateFeesPerGas: async () =>
            (await pimlicoClient.getUserOperationGasPrice()).fast,
          // ERC20 Paymaster mode では UserOp の calls 先頭に approve を自動注入し、
          // approve 量を gas 見積に基づいて計算する必要があるため、permissionless
          // 提供の prepareUserOperation 実装に差し替える。sponsorship では既定。
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
