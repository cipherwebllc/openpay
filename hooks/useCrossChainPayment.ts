'use client';

// useCrossChainPayment — wagmi を wire して balance fetch + decision +
// execute を一括提供する hook。queryKey に networkEnv/account/target を含め
// 環境横断 cache 衝突を防ぐ。

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
  targetChainId: number;
  /** 0n のとき decision は skip (UI 起動時の判断遅延回避) */
  requiredAtomic: bigint;
  recipient: Address;
  enabled?: boolean;
}

export type ExecuteResult =
  | ExecuteGatewayTransferResult
  | ExecuteCctpTransferResult;

export interface UseCrossChainPaymentReturn {
  /** undefined = balance 取得中 or 0 amount */
  decision: PathDecision | undefined;
  progress: CrossChainProgress | undefined;
  isExecuting: boolean;
  result: ExecuteResult | undefined;
  error: Error | undefined;
  refetchBalances: () => Promise<unknown>;
  isFetchingBalances: boolean;
  balancesError: Error | null;
  /** direct/onramp は何もせず null を返す (caller の既存 path に委譲) */
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
      // Gateway path の source chain は buyer の現 wallet chain (walletClient.chain)。
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
      // execute 内部 throw を error state に取り込んで rethrow (UI 側でも catch
      // できるように、かつ setIsExecuting=false を保証するため)。
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
