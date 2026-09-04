'use client';

// useCrossChainPayment — wagmi を wire して balance fetch + decision +
// execute を一括提供する hook。queryKey に networkEnv/account/target を含め
// 環境横断 cache 衝突を防ぐ。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { env } from '@/lib/env';
import { readAllCrossChainBalances } from '@/lib/crossChain/balance';
import {
  CrossChainBurnUnresolvedError,
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
import { CROSS_CHAIN_BURN_AUTORESUME } from '@/lib/crossChain/config';
import {
  normalizeBurnTxHash,
  verifyBurnTxHash,
  type BurnIntentMarker,
  type BurnSlot,
} from '@/lib/crossChain/burnMarker';
import { buildPaymentLogEvent, logPaymentEvent } from '@/lib/paymentLog';
import {
  estimateCctpMaxFee,
  CCTP_V2_TOKEN_MESSENGER_ADDRESS,
} from '@/lib/crossChain/cctp';
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
  saveResumeStateStrict,
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
  /** A1: 前回 burn の状態を自動判定できず money-path を止めた状態。UI が専用パネルを出す。
   *  'wait' = 時間を置いて再試行 / 'manual' = 買い手が explorer で確認して二段確認。 */
  burnUnresolved: BurnUnresolvedInfo | undefined;
  /** manual パネルの二段確認完了。次の execute だけ曖昧な状態からの再 burn を許可する。 */
  armManualReburn: () => void;
  /** 二段確認が武装済みか (UI の表示切替用)。 */
  isManualReburnArmed: boolean;
  /** D4: 買い手が explorer で見つけた burn tx hash を貼って続きから再開する。
   *  on-chain (receipt + DepositForBurn log) が marker と一致した場合だけ採用し、
   *  一致しなければ state を一切変えずに理由を返す。 */
  adoptBurnTxHash: (input: string) => Promise<AdoptBurnTxHashResult>;
}

/** adoptBurnTxHash の結果。ok=false の reason は UI の inline error 文言に 1:1 対応する。 */
export type AdoptBurnTxHashResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'format' | 'notfound' | 'reverted' | 'mismatch' | 'unavailable';
    };

/** burnUnresolved の表示に必要な最小情報 (Error からの抽出結果)。 */
export interface BurnUnresolvedInfo {
  kind: 'wait' | 'manual';
  slot: BurnSlot;
  /** 決定表の行番号 (設計 §4)。サポート問い合わせ時の識別子にもなる。 */
  row: number;
  /** 二段確認で再 burn を開けてよい状態か (false = 一致 burn が複数見つかっている等)。 */
  reburnable: boolean;
  sourceChainId: number;
  depositor: Address;
  burnTxHash?: Hex;
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
  const [burnUnresolved, setBurnUnresolved] = useState<
    BurnUnresolvedInfo | undefined
  >();
  // 二段確認は「次の 1 回の execute」にだけ効かせる (押しっぱなしで常時 auto 再 burn に
  // ならないよう、execute 開始時に消費する)。render を跨いで即時に読みたいので ref。
  const manualReburnArmedRef = useRef(false);
  const [isManualReburnArmed, setIsManualReburnArmed] = useState(false);

  // D4: 未確定 slot の送金元 chain の read client (hash 貼付け検証に使う)。burnUnresolved が
  // 無い間は現接続 chain の client (= 未使用)。
  const unresolvedSourceClient = usePublicClient({
    chainId: burnUnresolved?.sourceChainId,
  });

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

  // 中断再開 state の session key。runCore の内部で組む key と同一定義 (account /
  // kind / chain / recipient / 金額)。mount 時の committed 復元 (D9)・hash 貼付け採用 (D4)・
  // isOptionResumable が同じ key を参照するために切り出してある。
  const sessionKeyFor = useCallback(
    (
      kind: 'gateway' | 'cctp-v2',
      sourceChainId: number,
    ): ResumeSessionKey | undefined => {
      if (!account || args.requiredAtomic <= 0n) return undefined;
      const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
        args.requiredAtomic,
        'usdc',
        'standard',
      );
      return {
        account,
        kind,
        sourceChainId,
        destChainId: args.targetChainId,
        recipient: args.recipient,
        valueAtomic: bridgedAmount,
        feeAtomic: feeAmount,
      };
    },
    [account, args.requiredAtomic, args.targetChainId, args.recipient],
  );

  // D9: mount 時 (reload 後) に marker / burn hash / attestation が残っていれば committed を
  // 復元する。復元しないと、再読込しただけで親フォームの直接決済ロックが外れ、burn 済 (または
  // 「送るつもり」が確定済) の決済をもう一度別経路で払えてしまう。marker は「不可逆境界の
  // 一歩手前」なので、reload を跨いでも塞ぎ続ける (設計 §7)。
  useEffect(() => {
    if (isCommitted) return;
    for (const option of pathOptions) {
      if (option.kind === 'direct') continue;
      const key = sessionKeyFor(option.kind, option.sourceChainId);
      if (!key) continue;
      const s = loadResumeState<ResumeState>(key);
      if (!s) continue;
      if (
        ('burnTxHash' in s && !!s.burnTxHash) ||
        ('burnIntent' in s && !!s.burnIntent) ||
        ('merchantAttestation' in s && !!s.merchantAttestation)
      ) {
        setIsCommitted(true);
        return;
      }
    }
  }, [pathOptions, sessionKeyFor, isCommitted]);

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
      // commitBurnIntent が marker を混ぜ込むために、直近の resume state を保持する。
      let latestState: ResumeState = { ...(loadResumeState(sessionKey) ?? {}) };
      const onStep = (s: ResumeState) => {
        latestState = s;
        // D4a: 親子 UI の同一 mount 排他は storage 成否より先に確定する。CCTP は
        // merchant burn hash / burn-intent marker、Gateway は merchant attestation が
        // 送金の不可逆境界。approveTxHash だけでは資金移動前なので committed にせず、
        // 失敗時の通常 Pay を許す。
        if (
          (core.kind === 'cctp-v2' &&
            (('burnTxHash' in s && !!s.burnTxHash) ||
              ('burnIntent' in s && !!s.burnIntent))) ||
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

      // A1: burn-intent marker の fail-closed 永続化。read-back まで確認できた場合だけ
      // 「送るつもり」を確定させ、そこで初めて親 UI を排他する。
      // ※ 上の D4a コメント (排他は storage 成否より先) とは順序が逆になるが、理由が違う:
      //   D4a は best-effort 保存が前提で「保存できなくても送金は起きた」側に倒す。marker は
      //   fail-closed なので「書けた ⇒ 送る ⇒ 塞ぐ」で一貫する (書けなければ burn しないので
      //   塞ぐ必要もなく、親の通常決済を使わせる方が正しい)。
      const commitBurnIntent = (marker: BurnIntentMarker, slot: BurnSlot) => {
        const next: CctpResumeState = {
          ...(latestState as CctpResumeState),
          ...(slot === 'merchant'
            ? { burnIntent: marker }
            : { feeBurnIntent: marker }),
        };
        saveResumeStateStrict(sessionKey, next); // 失敗は throw → burn しない
        latestState = next;
        setIsCommitted(true);
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
      // marker (送るつもり) だけでも不可逆境界の一歩手前なので、親フォームの直接決済・
      // 別チェーン決済を塞ぐ (hash が残っていない中断からの復元も含めて排他する)。
      if (resume?.burnTxHash || resume?.burnIntent) setIsCommitted(true);
      // 二段確認は 1 回の execute で消費する (arm したまま放置しても次回以降に効かない)。
      const allowManualReburn = manualReburnArmedRef.current;
      manualReburnArmedRef.current = false;
      setIsManualReburnArmed(false);
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
        commitBurnIntent,
        allowManualReburn,
        allowAutoReburn: CROSS_CHAIN_BURN_AUTORESUME,
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
    setBurnUnresolved(undefined);

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
      // D2: execute と同様に前回の未確定 state を捨てる。残したままだと (a) 再試行の結果が
      // 反映されず wait パネルが出っぱなしで「続きから支払う」が押せない、(b) 新しいエラーが
      // `error && !burnUnresolved` の条件で隠れる。Chooser 経路 (executeOption) は本 UI の
      // 既定の実行経路なので、ここが抜けているとパネルが実質デッドロックになる。
      setBurnUnresolved(undefined);

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

  // burn 状態未確定の throw は UI 専用パネルに回す (Iris timeout 等の一般エラーとは別扱い)。
  const captureBurnUnresolved = useCallback((e: unknown) => {
    if (!(e instanceof CrossChainBurnUnresolvedError)) {
      // D2: 別種のエラーになったなら前回の未確定パネルは畳む。残すと UI 側の
      // `error && !burnUnresolved` でエラーが表示されず、買い手に無言で失敗する。
      setBurnUnresolved(undefined);
      return;
    }
    setBurnUnresolved({
      kind: e.kind,
      slot: e.slot,
      row: e.row,
      reburnable: e.reburnable,
      sourceChainId: e.sourceChainId,
      depositor: e.depositor,
      burnTxHash: e.burnTxHash,
    });
  }, []);

  // execute 系の共通 wrapper: 内部 throw を error state に取り込んで rethrow
  // (UI 側でも catch できるように、かつ setIsExecuting=false を保証するため)。
  const safeExecute = useCallback(async () => {
    try {
      return await execute();
    } catch (e) {
      captureBurnUnresolved(e);
      setError(e instanceof Error ? e : new Error(String(e)));
      setIsExecuting(false);
      throw e;
    }
  }, [execute, captureBurnUnresolved]);

  const safeExecuteOption = useCallback(
    async (option: PathOption) => {
      try {
        return await executeOption(option);
      } catch (e) {
        captureBurnUnresolved(e);
        setError(e instanceof Error ? e : new Error(String(e)));
        setIsExecuting(false);
        throw e;
      }
    },
    [executeOption, captureBurnUnresolved],
  );

  // D4: 買い手が explorer で見つけた burn の tx hash を貼って続きから再開する。
  // 「USDC は減っているが hash が resume state に残らなかった」(決定表 row 4 / 20 で
  // 再 burn も開かない状態) の唯一の自己救済経路。採否は人間の申告ではなく on-chain で決める
  // — receipt が success で、その log に marker と一致する DepositForBurn がある場合だけ
  // burnTxHash として採用する (掟 15)。一致しなければ state を一切変えない。
  const adoptBurnTxHash = useCallback(
    async (input: string): Promise<AdoptBurnTxHashResult> => {
      const info = burnUnresolved;
      if (!info) return { ok: false, reason: 'unavailable' };
      const hash = normalizeBurnTxHash(input);
      if (!hash) return { ok: false, reason: 'format' };
      const key = sessionKeyFor('cctp-v2', info.sourceChainId);
      if (!key || !unresolvedSourceClient) {
        return { ok: false, reason: 'unavailable' };
      }
      const state = loadResumeState<CctpResumeState>(key);
      const marker =
        info.slot === 'merchant' ? state?.burnIntent : state?.feeBurnIntent;
      if (!state || !marker) return { ok: false, reason: 'unavailable' };
      let verdict;
      try {
        verdict = await verifyBurnTxHash({
          client: unresolvedSourceClient,
          hash,
          marker,
          tokenMessenger: CCTP_V2_TOKEN_MESSENGER_ADDRESS,
        });
      } catch {
        // RPC 障害を「一致しなかった」に潰さない。何も変えずに「いま確認できない」を返し、
        // 買い手には時間を置いた再試行を促す (誤って再送金に倒さないための隔離)。
        return { ok: false, reason: 'unavailable' };
      }
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      // 採用も fail-closed で書く (書けなければ採用しない = 次回また同じ判定に戻るだけ)。
      saveResumeStateStrict(key, {
        ...state,
        ...(info.slot === 'merchant'
          ? { burnTxHash: hash }
          : { feeBurnTxHash: hash }),
      });
      setBurnUnresolved(undefined);
      setError(undefined);
      return { ok: true };
    },
    [burnUnresolved, sessionKeyFor, unresolvedSourceClient],
  );

  // manual パネルの二段確認完了。次の execute だけ、曖昧な状態からの再 burn を許可する。
  const armManualReburn = useCallback(() => {
    manualReburnArmedRef.current = true;
    setIsManualReburnArmed(true);
  }, []);

  // 指定 option (cross-chain) に保存済みの中断 state があるか。runCore と同じ
  // session key で localStorage を確認する。UI が「続きから再開」を案内するため。
  const isOptionResumable = useCallback(
    (option: PathOption): boolean => {
      if (option.kind === 'direct') return false;
      const key = sessionKeyFor(option.kind, option.sourceChainId);
      return key ? hasResumeState(key) : false;
    },
    [sessionKeyFor],
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
    burnUnresolved,
    armManualReburn,
    isManualReburnArmed,
    adoptBurnTxHash,
  };
}
