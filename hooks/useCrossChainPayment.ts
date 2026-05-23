'use client';

// useCrossChainPayment — PaymentForm から使う cross-chain orchestration hook。
//
// 責務:
//   - 接続済 wallet account について 4 chain wallet USDC + Gateway unified
//     balance を React Query で fetch (キャッシュ + manual invalidate)
//   - target chain と required amount を input として PathDecision を計算
//   - executeGateway / executeCctp は wagmi の wallet/public client を
//     wire して lib/crossChain/execute.ts を呼ぶ
//
// React Query queryKey に NETWORK_ENV と account, target chain を含めて
// 環境横断キャッシュ衝突を避ける。

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { env } from '@/lib/env';
import { readAllCrossChainBalances } from '@/lib/crossChain/balance';
import {
  executeCctpTransfer,
  executeGatewayTransfer,
  type CrossChainProgress,
  type ExecuteCctpTransferArgs,
  type ExecuteCctpTransferResult,
  type ExecuteGatewayTransferArgs,
  type ExecuteGatewayTransferResult,
} from '@/lib/crossChain/execute';
import { selectPath, type PathDecision } from '@/lib/crossChain/router';
import { resolveDeployment } from '@/lib/tokens';

export interface UseCrossChainPaymentArgs {
  /** merchant 着金 chain (URL の chain から resolve) */
  targetChainId: number;
  /** atomic amount (USDC 6 decimals)。0n だと decision は skip (UI 起動時の判断遅延回避) */
  requiredAtomic: bigint;
  /** merchant 受取人 address */
  recipient: Address;
  /** balance refetch を auto disable する場合 (URL params 未確定時など) */
  enabled?: boolean;
}

export type ExecuteResult =
  | ExecuteGatewayTransferResult
  | ExecuteCctpTransferResult;

export interface UseCrossChainPaymentReturn {
  /** decision が undefined = balance 取得中 or 0 amount */
  decision: PathDecision | undefined;
  /** 直近 progress (UI 表示用) */
  progress: CrossChainProgress | undefined;
  /** execute 中フラグ */
  isExecuting: boolean;
  /** 直近 execute 結果 (success/failure 後に set) */
  result: ExecuteResult | undefined;
  /** execute エラー */
  error: Error | undefined;
  /** balance を再 fetch */
  refetchBalances: () => Promise<unknown>;
  /** balance 取得中 */
  isFetchingBalances: boolean;
  /** balance 取得エラー */
  balancesError: Error | null;
  /** PathDecision に基づき適切な path を実行 (direct/onramp は execute 不可、null 返却) */
  execute: () => Promise<ExecuteResult | null>;
}

export function useCrossChainPayment(
  args: UseCrossChainPaymentArgs,
): UseCrossChainPaymentReturn {
  const { address: account } = useAccount();
  const { data: walletClient } = useWalletClient();
  const sourcePublicClient = usePublicClient();
  const destPublicClient = usePublicClient({ chainId: args.targetChainId });
  const { switchChainAsync } = useSwitchChain();
  const enabled = args.enabled !== false && Boolean(account);

  const [progress, setProgress] = useState<CrossChainProgress | undefined>();
  const [isExecuting, setIsExecuting] = useState(false);
  const [result, setResult] = useState<ExecuteResult | undefined>();
  const [error, setError] = useState<Error | undefined>();

  // balances を fetch。env.networkEnv を queryKey に含めて main/test 切替時に
  // 別キャッシュ。account 変更 (disconnect → connect 他 wallet) でも refetch。
  const balancesQuery = useQuery({
    queryKey: [
      'crossChain.balances',
      env.networkEnv,
      account ?? null,
      args.targetChainId,
    ],
    queryFn: async () => {
      if (!account) throw new Error('account not connected');
      return readAllCrossChainBalances(account);
    },
    enabled,
    staleTime: 30_000,
  });

  // decision は memo (balances 変化時に再計算)。amount=0 は skip。
  const decision = useMemo<PathDecision | undefined>(() => {
    if (!balancesQuery.data) return undefined;
    if (args.requiredAtomic <= 0n) return undefined;
    return selectPath({
      targetChainId: args.targetChainId,
      requiredAtomic: args.requiredAtomic,
      balances: balancesQuery.data,
    });
  }, [balancesQuery.data, args.requiredAtomic, args.targetChainId]);

  const execute = useCallback(async (): Promise<ExecuteResult | null> => {
    setError(undefined);
    setResult(undefined);
    setProgress(undefined);

    if (!decision) return null;
    if (decision.path === 'direct' || decision.path === 'onramp') {
      // 既存 path (useBatchPayment / useStandardPayment) or OnrampCta に委譲
      return null;
    }
    if (!account || !walletClient || !sourcePublicClient || !destPublicClient) {
      throw new Error('wallet not connected');
    }
    const destDeployment = resolveDeployment('usdc', args.targetChainId);
    if (!destDeployment) {
      throw new Error(
        `USDC deployment missing for target chainId ${args.targetChainId}`,
      );
    }

    setIsExecuting(true);
    const reportProgress: (p: CrossChainProgress) => void = (p) => {
      setProgress(p);
    };

    let executeResult: ExecuteResult;
    if (decision.path === 'gateway') {
      // source chain id を domain から resolve するため balance 側を再走査せず、
      // execute.ts が source publicClient を要求する形にする。useCrossChainPayment
      // の sourcePublicClient は walletClient.chain で自動決定されるため、ここで
      // source chain id を取得する。
      const sourceChainId = walletClient.chain?.id;
      if (sourceChainId === undefined) {
        throw new Error('walletClient.chain undefined');
      }
      const sourceDeployment = resolveDeployment('usdc', sourceChainId);
      if (!sourceDeployment) {
        throw new Error(
          `USDC deployment missing for source chainId ${sourceChainId}`,
        );
      }
      const gatewayArgs: ExecuteGatewayTransferArgs = {
        walletClient,
        sourcePublicClient,
        destPublicClient,
        switchChainAsync,
        account,
        sourceChainId,
        destChainId: args.targetChainId,
        sourceDomain: decision.sourceDomain,
        destDomain: decision.destinationDomain,
        sourceToken: sourceDeployment.address,
        destToken: destDeployment.address,
        recipient: args.recipient,
        valueAtomic: args.requiredAtomic,
        onProgress: reportProgress,
      };
      executeResult = await executeGatewayTransfer(gatewayArgs);
    } else {
      // cctp-v2
      const sourceDeployment = resolveDeployment('usdc', decision.sourceChainId);
      if (!sourceDeployment) {
        throw new Error(
          `USDC deployment missing for source chainId ${decision.sourceChainId}`,
        );
      }
      const cctpArgs: ExecuteCctpTransferArgs = {
        walletClient,
        sourcePublicClient,
        destPublicClient,
        switchChainAsync,
        account,
        sourceChainId: decision.sourceChainId,
        destChainId: args.targetChainId,
        destDomain: decision.destinationDomain,
        sourceDomain: decision.sourceDomain,
        sourceToken: sourceDeployment.address,
        recipient: args.recipient,
        valueAtomic: args.requiredAtomic,
        onProgress: reportProgress,
      };
      executeResult = await executeCctpTransfer(cctpArgs);
    }

    setResult(executeResult);
    setIsExecuting(false);
    return executeResult;
  }, [
    account,
    args.recipient,
    args.requiredAtomic,
    args.targetChainId,
    decision,
    destPublicClient,
    sourcePublicClient,
    switchChainAsync,
    walletClient,
  ]);

  return {
    decision,
    progress,
    isExecuting,
    result,
    error,
    refetchBalances: balancesQuery.refetch,
    isFetchingBalances: balancesQuery.isFetching,
    balancesError: balancesQuery.error as Error | null,
    execute: useCallback(async () => {
      // execute 内部 throw を error state に取り込みつつ、caller には rethrow して
      // UI でも catch できるようにする。setIsExecuting=false を保証するため必要。
      try {
        return await execute();
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        setIsExecuting(false);
        throw e;
      }
    }, [execute]),
  };
}
