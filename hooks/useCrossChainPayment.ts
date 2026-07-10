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
  type CctpResumeState,
  type CrossChainProgress,
  type ExecuteCctpTransferArgs,
  type ExecuteCctpTransferResult,
  type ExecuteGatewayTransferArgs,
  type ExecuteGatewayTransferResult,
  type GatewayResumeState,
  type OnMerchantMint,
} from '@/lib/crossChain/execute';
import { buildPaymentLogEvent, logPaymentEvent } from '@/lib/paymentLog';
import { estimateCctpMaxFee } from '@/lib/crossChain/cctp';
import { estimateGatewayMaxFee } from '@/lib/crossChain/gateway';
import { selectPath, type PathDecision } from '@/lib/crossChain/router';
import {
  enumeratePathOptions,
  type PathOption,
} from '@/lib/crossChain/pathEnumerator';
import { domainForChainId } from '@/lib/crossChain/config';
import type { CircleDomain } from '@/lib/crossChain/types';
import { computeCrossChainFeeSplit } from '@/lib/crossChain/feeSplit';
import {
  clearResumeState,
  hasResumeState,
  loadResumeState,
  saveResumeState,
  type ResumeSessionKey,
  type ResumeState,
} from '@/lib/crossChain/resumeStore';
import { resolveDeployment } from '@/lib/tokens';

export interface UseCrossChainPaymentArgs {
  targetChainId: number;
  /** 請求額 (invoice amount, atomic)。cross-chain では顧客はこの額を source USDC
   *  で支出。0n のとき decision は skip (UI 起動時の判断遅延回避)。 */
  requiredAtomic: bigint;
  recipient: Address;
  /** OpenPay 利用料の送り先 (operator)。fee=0 (Phase 1 alpha) では使われない。 */
  feeReceiver: Address;
  enabled?: boolean;
}

export type ExecuteResult =
  | ExecuteGatewayTransferResult
  | ExecuteCctpTransferResult;

export interface UseCrossChainPaymentReturn {
  /** undefined = balance 取得中 or 0 amount。自動 best path (selectPath) */
  decision: PathDecision | undefined;
  /** 全 viable source chain x path options (CrossChainSourceChooser 用)。
   *  balances 取得前 / 0 amount は []。direct option を含む。 */
  pathOptions: PathOption[];
  progress: CrossChainProgress | undefined;
  isExecuting: boolean;
  /** merchant 送金が不可逆境界を越えたか。同一 mount 中の親 UI 排他用。 */
  isCommitted: boolean;
  result: ExecuteResult | undefined;
  error: Error | undefined;
  refetchBalances: () => Promise<unknown>;
  isFetchingBalances: boolean;
  balancesError: Error | null;
  /** direct/onramp は何もせず null を返す (caller の既存 path に委譲)。
   *  内部 auto-decision (selectPath) で実行。 */
  execute: () => Promise<ExecuteResult | null>;
  /** Chooser で user が選択した PathOption で実行 (auto-decision を override)。
   *  direct option は何もせず null (caller の既存 path に委譲)、cross-chain
   *  option (gateway / cctp-v2) のみ実行する。 */
  executeOption: (option: PathOption) => Promise<ExecuteResult | null>;
  /** 指定 option に中断再開可能な保存 state があるか (再 Pay で続きから再開可)。 */
  isOptionResumable: (option: PathOption) => boolean;
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
  const [isCommitted, setIsCommitted] = useState(false);
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

  const pathOptions = useMemo<PathOption[]>(() => {
    if (!balancesQuery.data) return [];
    if (args.requiredAtomic <= 0n) return [];
    return enumeratePathOptions({
      targetChainId: args.targetChainId,
      requiredAtomic: args.requiredAtomic,
      balances: balancesQuery.data,
    });
  }, [balancesQuery.data, args.requiredAtomic, args.targetChainId]);

  // 共通 execute core: 「source chain + path kind + (Gateway only) destDomain」
  // を引数に取り、Gateway / CCTP V2 dispatch を行う。auto-decision (execute)
  // と user-selected option (executeOption) で共有。
  type ExecuteCoreArgs =
    | {
        kind: 'gateway';
        sourceChainId: number;
        sourceDomain: CircleDomain;
        destDomain: CircleDomain;
      }
    | {
        kind: 'cctp-v2';
        sourceChainId: number;
        sourceDomain: CircleDomain;
        destDomain: CircleDomain;
      };

  const runCore = useCallback(
    async (core: ExecuteCoreArgs): Promise<ExecuteResult> => {
      if (!account || !walletClient || !sourcePublicClient || !destPublicClient) {
        throw new Error('wallet not connected');
      }
      const destDeployment = resolveDeployment('usdc', args.targetChainId);
      if (!destDeployment) {
        throw new Error(
          `USDC deployment missing for target chainId ${args.targetChainId}`,
        );
      }
      const sourceDeployment = resolveDeployment('usdc', core.sourceChainId);
      if (!sourceDeployment) {
        throw new Error(
          `USDC deployment missing for source chainId ${core.sourceChainId}`,
        );
      }

      const reportProgress: (p: CrossChainProgress) => void = (p) => {
        setProgress(p);
      };

      // 請求額を merchant 本送金 (bridgedAmount) と OpenPay 利用料 (feeAmount) に分割。
      // fee=0 (Phase 1) では実質 merchant 宛 1 本ブリッジ、fee>0 で execute 側の
      // bridgeFee guard が operator 宛 2 本目を復活させる。
      const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
        args.requiredAtomic,
        'usdc',
        'standard',
      );

      // 中断再開: payment params で session key を作り、完了済みステップを
      // localStorage から復元 (resume)、各ステップ完了で保存 (onStep)、全完了で
      // 削除する。失敗時は保存済 state が残り、再 Pay で続きから再開できる。
      const sessionKey: ResumeSessionKey = {
        account,
        kind: core.kind,
        sourceChainId: core.sourceChainId,
        destChainId: args.targetChainId,
        recipient: args.recipient,
        valueAtomic: bridgedAmount,
        feeAtomic: feeAmount,
      };
      const onStep = (s: ResumeState) => {
        // D4a: 親子 UI の同一 mount 排他は storage 成否より先に確定する。CCTP は
        // merchant burn hash、Gateway は merchant attestation が送金の不可逆境界。
        // approveTxHash だけでは資金移動前なので committed にせず、失敗時の通常 Pay を許す。
        if (
          (core.kind === 'cctp-v2' && 'burnTxHash' in s && !!s.burnTxHash) ||
          (core.kind === 'gateway' &&
            'merchantAttestation' in s &&
            !!s.merchantAttestation)
        ) {
          setIsCommitted(true);
        }
        // D4b は見送り: resume 保存は best-effort のまま。保存失敗後に reload すると
        // committed state を復元できず、同一 mount 外の二重送金窓が残る。
        saveResumeState(sessionKey, s);
      };

      // merchant mint 確定時に会計ログ (KV) を発火する。cross-chain は買い手の端末で実行され
      // localStorage は買い手の控えにしかならないため、店舗向けの会計記録は KV ログが本筋。
      // 値は全て unreconciled (reported): merchantAmount=bridgedAmount は bridge intent (実着金
      // = minted は bridge fee 控除後で B-3 の receipt 照合で確定)、bridgeFeeMax は ceiling。
      // resume で複数回発火し得るので、集計層が (bridge+chainId+mintTxHash) で dedup する。
      const onMerchantMint: OnMerchantMint = (info) => {
        const bridgeFeeMax =
          core.kind === 'cctp-v2'
            ? estimateCctpMaxFee(bridgedAmount)
            : estimateGatewayMaxFee(bridgedAmount);
        void logPaymentEvent(
          buildPaymentLogEvent(
            {
              flow: 'direct',
              chainId: args.targetChainId,
              tokenAddress: destDeployment.address,
              merchant: args.recipient,
              merchantAmount: bridgedAmount,
              customer: account,
              feeReceiver: args.feeReceiver,
              feeAmount, // OpenPay cross-chain 利用料 (Phase1 alpha = 0)
              saleAmount: args.requiredAtomic, // 請求総額 (gross)
              bridge: core.kind,
              sourceChainId: core.sourceChainId,
              bridgedAmount,
              bridgeFeeMax,
              burnTxHash: info.burnTxHash,
            },
            { result: 'success', txHash: info.mintTxHash },
          ),
        );
      };

      if (core.kind === 'gateway') {
        const resume = loadResumeState<GatewayResumeState>(sessionKey);
        if (resume?.merchantAttestation) setIsCommitted(true);
        const gatewayArgs: ExecuteGatewayTransferArgs = {
          walletClient,
          sourcePublicClient,
          destPublicClient,
          switchChainAsync,
          account,
          sourceChainId: core.sourceChainId,
          destChainId: args.targetChainId,
          sourceDomain: core.sourceDomain,
          destDomain: core.destDomain,
          sourceToken: sourceDeployment.address,
          destToken: destDeployment.address,
          recipient: args.recipient,
          valueAtomic: bridgedAmount,
          feeReceiver: args.feeReceiver,
          feeAmount,
          resume,
          onStep,
          onProgress: reportProgress,
          onMerchantMint,
        };
        const result = await executeGatewayTransfer(gatewayArgs);
        clearResumeState(sessionKey);
        return result;
      }
      // cctp-v2
      const resume = loadResumeState<CctpResumeState>(sessionKey);
      if (resume?.burnTxHash) setIsCommitted(true);
      const cctpArgs: ExecuteCctpTransferArgs = {
        walletClient,
        sourcePublicClient,
        destPublicClient,
        switchChainAsync,
        account,
        sourceChainId: core.sourceChainId,
        destChainId: args.targetChainId,
        destDomain: core.destDomain,
        sourceDomain: core.sourceDomain,
        sourceToken: sourceDeployment.address,
        recipient: args.recipient,
        valueAtomic: bridgedAmount,
        feeReceiver: args.feeReceiver,
        feeAmount,
        resume,
        onStep,
        onProgress: reportProgress,
        onMerchantMint,
      };
      const result = await executeCctpTransfer(cctpArgs);
      clearResumeState(sessionKey);
      return result;
    },
    [
      account,
      args.recipient,
      args.requiredAtomic,
      args.feeReceiver,
      args.targetChainId,
      destPublicClient,
      sourcePublicClient,
      switchChainAsync,
      walletClient,
    ],
  );

  const execute = useCallback(async (): Promise<ExecuteResult | null> => {
    setError(undefined);
    setResult(undefined);
    setProgress(undefined);
    setIsCommitted(false);

    if (!decision) return null;
    if (decision.path === 'direct' || decision.path === 'onramp') {
      // 既存 path (useBatchPayment / useStandardPayment) or OnrampCta に委譲
      return null;
    }

    setIsExecuting(true);

    let executeResult: ExecuteResult;
    if (decision.path === 'gateway') {
      // Gateway path の source chain は buyer の現 wallet chain (walletClient.chain)。
      const sourceChainId = walletClient?.chain?.id;
      if (sourceChainId === undefined) {
        throw new Error('walletClient.chain undefined');
      }
      executeResult = await runCore({
        kind: 'gateway',
        sourceChainId,
        sourceDomain: decision.sourceDomain,
        destDomain: decision.destinationDomain,
      });
    } else {
      executeResult = await runCore({
        kind: 'cctp-v2',
        sourceChainId: decision.sourceChainId,
        sourceDomain: decision.sourceDomain,
        destDomain: decision.destinationDomain,
      });
    }

    setResult(executeResult);
    setIsExecuting(false);
    return executeResult;
  }, [decision, runCore, walletClient]);

  const executeOption = useCallback(
    async (option: PathOption): Promise<ExecuteResult | null> => {
      setError(undefined);
      setResult(undefined);
      setProgress(undefined);
      setIsCommitted(false);

      // direct option は既存 path (useBatchPayment / useStandardPayment) に委譲。
      // user-selected であっても本 hook は touch しない。
      if (option.kind === 'direct') return null;

      // option には sourceDomain しか乗らないので、target chainId → domain 解決を
      // ここで実行 (executeGateway/Cctp 共通の destDomain 必須引数のため)。
      const destDomainResolved = domainForChainId(args.targetChainId);
      if (destDomainResolved === undefined) {
        throw new Error(
          `No Circle domain for target chainId ${args.targetChainId}`,
        );
      }

      setIsExecuting(true);
      const executeResult = await runCore({
        kind: option.kind,
        sourceChainId: option.sourceChainId,
        sourceDomain: option.sourceDomain,
        destDomain: destDomainResolved,
      });
      setResult(executeResult);
      setIsExecuting(false);
      return executeResult;
    },
    [args.targetChainId, runCore],
  );

  // execute 系の共通 wrapper: 内部 throw を error state に取り込んで rethrow
  // (UI 側でも catch できるように、かつ setIsExecuting=false を保証するため)。
  const safeExecute = useCallback(async () => {
    try {
      return await execute();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setIsExecuting(false);
      throw e;
    }
  }, [execute]);

  const safeExecuteOption = useCallback(
    async (option: PathOption) => {
      try {
        return await executeOption(option);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        setIsExecuting(false);
        throw e;
      }
    },
    [executeOption],
  );

  // 指定 option (cross-chain) に保存済みの中断 state があるか。runCore と同じ
  // session key で localStorage を確認する。UI が「続きから再開」を案内するため。
  const isOptionResumable = useCallback(
    (option: PathOption): boolean => {
      if (!account || option.kind === 'direct' || args.requiredAtomic <= 0n) {
        return false;
      }
      const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
        args.requiredAtomic,
        'usdc',
        'standard',
      );
      return hasResumeState({
        account,
        kind: option.kind,
        sourceChainId: option.sourceChainId,
        destChainId: args.targetChainId,
        recipient: args.recipient,
        valueAtomic: bridgedAmount,
        feeAtomic: feeAmount,
      });
    },
    [account, args.requiredAtomic, args.targetChainId, args.recipient],
  );

  return {
    decision,
    pathOptions,
    progress,
    isExecuting,
    isCommitted,
    result,
    error,
    refetchBalances: balancesQuery.refetch,
    isFetchingBalances: balancesQuery.isFetching,
    balancesError: balancesQuery.error as Error | null,
    execute: safeExecute,
    executeOption: safeExecuteOption,
    isOptionResumable,
  };
}
