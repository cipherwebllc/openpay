'use client';

// PaymentForm / TipForm / CheckoutForm の 3 つで同一に書かれていた
// 「ERC20 balanceOf 取得 + 顧客総 outflow との比較 + wallet chain 切替 trigger」
// を集約。各 form の wallet 接続状態 (useAccount) と要求 chain (deployment.chainId)
// を渡せば、insufficientBalance / wrongChain を導出し、必要なら自動 switch を試みる。

import { useAccount, useReadContract } from 'wagmi';
import { erc20Abi, type Chain } from 'viem';
import type { TokenDeployment } from '@/lib/tokens';
import { useAutoSwitchChain } from './useAutoSwitchChain';

export type Erc20BalanceAndChain = {
  balance: bigint | undefined;
  insufficientBalance: boolean;
  wrongChain: boolean;
};

export function useErc20BalanceAndChain(
  deployment: TokenDeployment,
  requiredChain: Chain,
  totalCustomerOutflow: bigint,
): Erc20BalanceAndChain {
  const { address, isConnected, chainId } = useAccount();

  const balanceQuery = useReadContract({
    address: deployment.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: deployment.chainId,
    query: { enabled: !!address && isConnected },
  });

  const insufficientBalance =
    balanceQuery.data !== undefined &&
    totalCustomerOutflow > 0n &&
    balanceQuery.data < totalCustomerOutflow;

  const wrongChain = isConnected && chainId !== requiredChain.id;
  useAutoSwitchChain(requiredChain.id, wrongChain);

  return {
    balance: balanceQuery.data,
    insufficientBalance,
    wrongChain,
  };
}
