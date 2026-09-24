'use client';

// useCrossChainPayment — wagmi を wire して balance fetch + decision +
// executeOption を一括提供する hook。queryKey に networkEnv/account/target を含め
// 環境横断 cache 衝突を防ぐ。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPublicClient, type Address, type Hex, type PublicClient } from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { env, isArcCrossChainEnabled } from '@/lib/env';
import { readAllCrossChainBalances } from '@/lib/crossChain/balance';
import {
  CrossChainBurnUnresolvedError,
  CrossChainQuoteExpiredError,
  assertForwardQuoteBinding,
  assertGatewayTransferEnabled,
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
import { BUYER_SOURCE_TARGETS, CROSS_CHAIN_DISABLED, isForwardOnlyDestination, CROSS_CHAIN_BURN_AUTORESUME } from '@/lib/crossChain/config';
import {
  normalizeBurnTxHash,
  verifyBurnTxHash,
  type BurnIntentMarker,
  type BurnSlot,
} from '@/lib/crossChain/burnMarker';
import { buildPaymentLogEvent, logPaymentEvent } from '@/lib/paymentLog';
import {
  acceptForwardQuote,
  fetchCctpBurnFees,
  type AcceptedQuote,
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
  loadResumeStateDiscriminated,
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

export interface PendingForwardRecovery {
  kind: 'scanning' | 'unreadable' | 'pending';
  sourceChainId?: number;
  state?: CctpResumeState;
}

export interface UseCrossChainPaymentReturn {
  pendingRecovery?: PendingForwardRecovery;
  recoveryQuote?: AcceptedQuote;
  recheckForward: (consent?: boolean) => Promise<void>;

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
  /** Chooser で user が選択した PathOption で実行。
   *  direct option は何もせず null (caller の既存 path に委譲)、cross-chain
   *  option (gateway / cctp-v2) のみ実行する。 */
  executeOption: (option: PathOption) => Promise<ExecuteResult | null>;
  /** 指定 option に中断再開可能な保存 state があるか (再 Pay で続きから再開可)。 */
  isOptionResumable: (option: PathOption) => boolean;
  /** A1: 前回 burn の状態を自動判定できず money-path を止めた状態。UI が専用パネルを出す。
   *  'wait' = 時間を置いて再試行 / 'manual' = 買い手が explorer で確認して二段確認。 */
  burnUnresolved: BurnUnresolvedInfo | undefined;
  /** manual パネルの二段確認完了。次の実行だけ曖昧な状態からの再 burn を許可する。 */
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
  // source client は選択経路の chain ごとに再利用し、wallet の宛先への切替に追従させない。
  // 残高取得と D4 の hash 採用は、それぞれ別の chain 指定 client を使う。
  const sourcePublicClients = useRef(new Map<number, PublicClient>());
  const destPublicClient = usePublicClient({ chainId: args.targetChainId });
  const { switchChainAsync } = useSwitchChain();
  const enabled = args.enabled !== false && Boolean(account);

  const forwardOnly = isForwardOnlyDestination(args.targetChainId);
  const executionRef = useRef(false);
  const [forwardQuotes, setForwardQuotes] = useState<Readonly<Record<number, AcceptedQuote>>>({});
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [recoveryQuote, setRecoveryQuote] = useState<AcceptedQuote>();
  const [recovery, setRecovery] = useState<PendingForwardRecovery>();
  const [scannedScope, setScannedScope] = useState('');
  const recoveryScope = `${account}:${args.targetChainId}:${args.recipient}:${args.requiredAtomic}`;
  const pendingRecovery = useMemo(() => forwardOnly && account && scannedScope !== recoveryScope
    ? { kind: 'scanning' as const } : recovery, [forwardOnly, account, scannedScope, recoveryScope, recovery]);
  const [progress, setProgress] = useState<CrossChainProgress | undefined>();
  const [isExecuting, setIsExecuting] = useState(false);
  const [isCommitted, setIsCommitted] = useState(false);
  const [result, setResult] = useState<ExecuteResult | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [burnUnresolved, setBurnUnresolved] = useState<
    BurnUnresolvedInfo | undefined
  >();
  // 二段確認は「次の 1 回の実行」にだけ効かせる (押しっぱなしで常時 auto 再 burn に
  // ならないよう、実行開始時に消費する)。render を跨いで即時に読みたいので ref。
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

  useEffect(() => {
    if (!forwardOnly || !enabled || pendingRecovery || !isArcCrossChainEnabled()) return;
    let cancelled = false;
    const refresh = async () => {
      setForwardQuotes({});
      const entries = await Promise.all(BUYER_SOURCE_TARGETS.map(async (target) => {
        try {
          const fee = await fetchCctpBurnFees(target.domain, 26, { forward: true });
          return [target.chainId, acceptForwardQuote({ sourceDomain: target.domain, destDomain: 26,
            sourceChainId: target.chainId, destChainId: args.targetChainId,
            recipient: args.recipient, valueAtomic: String(args.requiredAtomic) }, fee)] as const;
        } catch {
          // 1 source の fee API 障害を他 source の選択肢へ波及させない。失敗経路は disabled。
          return undefined;
        }
      }));
      if (!cancelled) setForwardQuotes(Object.fromEntries(entries.filter((e) => e !== undefined)));
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 300_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [forwardOnly, enabled, pendingRecovery, args.targetChainId, args.recipient, args.requiredAtomic, quoteRevision]);

  const decision = useMemo<PathDecision | undefined>(() => {
    if (!balancesQuery.data) return undefined;
    if (args.requiredAtomic <= 0n) return undefined;
    return selectPath({
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

  const pathOptions = useMemo<PathOption[]>(() => {
    if (args.requiredAtomic <= 0n) return [];
    const options = balancesQuery.data ? enumeratePathOptions({
      targetChainId: args.targetChainId,
      requiredAtomic: args.requiredAtomic,
      balances: balancesQuery.data,
      forwardQuotes,
    }) : [];
    if (forwardOnly || !account || result) return options;

    // 新規 Gateway の flag / 残高 gate が保存済み attestation の回復を隠す波及を断つ。
    // invoice に束縛された key で全 source を走査し、残高 fetch 完了にも依存しない。
    const recoveryOptions: PathOption[] = [];
    for (const target of BUYER_SOURCE_TARGETS) {
      const key = sessionKeyFor('gateway', target.chainId);
      if (!key || !loadResumeState<GatewayResumeState>(key)?.merchantAttestation) continue;
      recoveryOptions.push({
        key: `gateway-${target.domain}`, kind: 'gateway', recoveryOnly: true,
        sourceChainId: target.chainId, sourceDomain: target.domain,
        // 回復に新たな源残高は要求しない。この placeholder は chooser に表示しない。
        sourceBalanceAtomic: 0n, serviceFeeAtomic: estimateGatewayMaxFee(args.requiredAtomic),
        estimatedGasUnits: 150_000n, gasOnChainId: args.targetChainId, etaSeconds: 5,
      });
    }
    return [...recoveryOptions, ...options.filter((o) => !recoveryOptions.some((r) => r.key === o.key))];
  }, [balancesQuery.data, args.requiredAtomic, args.targetChainId, forwardQuotes,
    forwardOnly, account, result, sessionKeyFor]);

  const scanRecovery = useCallback(() => {
    if (!forwardOnly || !account) { setRecovery(undefined); setScannedScope(recoveryScope); return; }
    let pending: PendingForwardRecovery | undefined;
    for (const target of BUYER_SOURCE_TARGETS) {
      const key = sessionKeyFor('cctp-v2', target.chainId);
      if (!key) continue;
      const entry = loadResumeStateDiscriminated(key);
      if (entry.kind === 'unreadable') { pending = { kind: 'unreadable', sourceChainId: target.chainId }; break; }
      // verified も cleanup/会計が終わるまで回復対象。残高・option・flag に依存しない。
      if (entry.kind === 'present' && (entry.state.burnIntent || entry.state.burnTxHash)) {
        pending ??= { kind: 'pending', sourceChainId: target.chainId, state: entry.state };
      }
    }
    setRecovery(pending);
    setScannedScope(recoveryScope);
    return pending;
  }, [forwardOnly, account, sessionKeyFor, recoveryScope]);
  useEffect(() => { scanRecovery(); setRecoveryQuote(undefined); }, [scanRecovery]);

  // D9: mount 時 (reload 後) に marker / burn hash / attestation が残っていれば committed を
  // 復元する。復元しないと、再読込しただけで親フォームの直接決済ロックが外れ、burn 済 (または
  // 「送るつもり」が確定済) の決済をもう一度別経路で払えてしまう。marker は「不可逆境界の
  // 一歩手前」なので、reload を跨いでも塞ぎ続ける (設計 §7)。
  useEffect(() => {
    if (forwardOnly || isCommitted) return;
    // Gateway discovery can fail or hide a spent balance after attestation issuance.
    // Scan every source so that missing options cannot unlock a second payment route.
    for (const target of BUYER_SOURCE_TARGETS) {
      const key = sessionKeyFor('gateway', target.chainId);
      if (!key) continue;
      const state = loadResumeState<GatewayResumeState>(key);
      if (state?.merchantAttestation) {
        setIsCommitted(true);
        return;
      }
    }
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
  }, [pathOptions, sessionKeyFor, isCommitted, forwardOnly]);

  // 選択経路と再開用の core: source chain + path kind + destDomain を受け取り、
  // Gateway / CCTP V2 dispatch を行う。
  type ExecuteCoreArgs =
    | {
        kind: 'gateway';
        sourceChainId: number;
        sourceDomain: CircleDomain;
        destDomain: CircleDomain;
      }
    | {
        kind: 'cctp-v2';
        forward?: ExecuteCctpTransferArgs['forward'];
        sourceChainId: number;
        sourceDomain: CircleDomain;
        destDomain: CircleDomain;
      };

  const runCore = useCallback(
    async (core: ExecuteCoreArgs): Promise<ExecuteResult> => {
      if (forwardOnly && (core.kind !== 'cctp-v2' || !core.forward)) throw new Error('Arc requires explicit forwarding option');
      if (!account || !walletClient || !destPublicClient) {
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
      let sourcePublicClient = sourcePublicClients.current.get(core.sourceChainId);
      if (!sourcePublicClient) {
        const sourceChain = chainObjectForId(core.sourceChainId);
        // USDC deployment と chain 定義のずれが、不明瞭な RPC エラーとして決済へ波及するのを防ぐ。
        if (!sourceChain) {
          throw new Error(`Unsupported source chainId ${core.sourceChainId}`);
        }
        sourcePublicClient = createPublicClient({
          chain: sourceChain,
          transport: transportForChain(core.sourceChainId),
        });
        sourcePublicClients.current.set(core.sourceChainId, sourcePublicClient);
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
      // scan 後の storage 障害を「記録なし→新 burn」へ波及させない。forward は判別読取を維持。
      const recovered = forwardOnly ? loadResumeStateDiscriminated(sessionKey) : undefined;
      if (recovered?.kind === 'unreadable') throw recovered.error;
      let latestState: ResumeState = forwardOnly
        ? { ...(recovered?.kind === 'present' ? recovered.state : {}) }
        : { ...(loadResumeState(sessionKey) ?? {}) };
      const onStep = (s: ResumeState) => {
        latestState = forwardOnly ? { ...latestState, ...s,
          forward: { ...(latestState as CctpResumeState).forward!, ...(s as CctpResumeState).forward! } } : s;
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
        if (forwardOnly) {
          saveResumeStateStrict(sessionKey, latestState);
          setRecovery({ kind: 'pending', sourceChainId: core.sourceChainId, state: latestState as CctpResumeState });
        } else saveResumeState(sessionKey, s);
      };

      // A1: burn-intent marker の fail-closed 永続化。read-back まで確認できた場合だけ
      // 「送るつもり」を確定させ、そこで初めて親 UI を排他する。
      // ※ 上の D4a コメント (排他は storage 成否より先) とは順序が逆になるが、理由が違う:
      //   D4a は best-effort 保存が前提で「保存できなくても送金は起きた」側に倒す。marker は
      //   fail-closed なので「書けた ⇒ 送る ⇒ 塞ぐ」で一貫する (書けなければ burn しないので
      //   塞ぐ必要もなく、親の通常決済を使わせる方が正しい)。
      const commitBurnIntent = (marker: BurnIntentMarker, slot: BurnSlot, metadata?: { forward: NonNullable<CctpResumeState['forward']> }) => {
        const next: CctpResumeState = {
          ...(latestState as CctpResumeState),
          ...metadata,
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
          info.forward ? BigInt(info.forward.maxFeeAtomic) : core.kind === 'cctp-v2'
            ? estimateCctpMaxFee(bridgedAmount)
            : estimateGatewayMaxFee(bridgedAmount);
        void logPaymentEvent(
          buildPaymentLogEvent(
            {
              flow: 'direct',
              chainId: args.targetChainId,
              tokenAddress: destDeployment.address,
              merchant: args.recipient,
              merchantAmount: info.forward ? BigInt(info.forward.verifiedNetAtomic) : bridgedAmount,
              customer: account,
              feeReceiver: args.feeReceiver,
              feeAmount, // OpenPay cross-chain 利用料 (Phase1 alpha = 0)
              saleAmount: args.requiredAtomic, // 請求総額 (gross)
              bridge: core.kind,
              sourceChainId: core.sourceChainId,
              bridgedAmount: info.forward ? BigInt(info.forward.grossAtomic) : bridgedAmount,
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
      const resume = forwardOnly ? latestState as CctpResumeState : loadResumeState<CctpResumeState>(sessionKey);
      // marker (送るつもり) だけでも不可逆境界の一歩手前なので、親フォームの直接決済・
      // 別チェーン決済を塞ぐ (hash が残っていない中断からの復元も含めて排他する)。
      if (resume?.burnTxHash || resume?.burnIntent) setIsCommitted(true);
      // 二段確認は 1 回の実行で消費する (arm したまま放置しても次回以降に効かない)。
      const allowManualReburn = manualReburnArmedRef.current;
      if (!forwardOnly || core.forward?.allowBurn !== false) {
        manualReburnArmedRef.current = false;
        setIsManualReburnArmed(false);
      }
      const cctpArgs: ExecuteCctpTransferArgs = {
        forward: core.forward,
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
      if (!forwardOnly || (latestState as CctpResumeState).forward?.state === 'verified') clearResumeState(sessionKey);
      if (forwardOnly) scanRecovery();
      return result;
    },
    [
      forwardOnly,
      scanRecovery,
      account,
      args.recipient,
      args.requiredAtomic,
      args.feeReceiver,
      args.targetChainId,
      destPublicClient,
      switchChainAsync,
      walletClient,
    ],
  );

  const executeOption = useCallback(
    async (option: PathOption): Promise<ExecuteResult | null> => {
      if (forwardOnly) {
        // state reset 前に認可/排他を確認し、競合クリックで committed が解除されるのを防ぐ。
        if (executionRef.current || pendingRecovery || scanRecovery() || !enabled || CROSS_CHAIN_DISABLED || !isArcCrossChainEnabled() ||
            !pathOptions.includes(option) || option.kind !== 'cctp-v2' || option.disabledReason || !option.acceptedQuote) throw new Error('Forward option unavailable');
        assertForwardQuoteBinding(option.acceptedQuote, { sourceChainId: option.sourceChainId,
          sourceDomain: option.sourceDomain, destChainId: args.targetChainId, destDomain: 26,
          recipient: args.recipient, valueAtomic: args.requiredAtomic });
        if (Date.now() >= option.acceptedQuote.expiresAt) throw new CrossChainQuoteExpiredError();

      }
      if (option.kind === 'gateway') {
        const key = sessionKeyFor('gateway', option.sourceChainId);
        assertGatewayTransferEnabled(key ? loadResumeState<GatewayResumeState>(key) : undefined);
      }
      setError(undefined);
      setResult(undefined);
      setProgress(undefined);
      setIsCommitted(false);
      // D2: 前回の未確定 state を捨てる。残したままだと (a) 再試行の結果が
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
        ...(forwardOnly ? { forward: { acceptedQuote: option.acceptedQuote! } } : {}),
        sourceChainId: option.sourceChainId,
        sourceDomain: option.sourceDomain,
        destDomain: destDomainResolved,
      });
      setResult(executeResult);
      setIsExecuting(false);
      return executeResult;
    },
    [args.targetChainId, args.recipient, args.requiredAtomic, runCore, forwardOnly, pendingRecovery, enabled, pathOptions, scanRecovery, sessionKeyFor],
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

  // 内部 throw を error state に取り込み rethrow (UI 側の catch と実行中表示の解除用)。
  const safeExecuteOption = useCallback(
    async (option: PathOption) => {
      if (forwardOnly && executionRef.current) throw new Error('Execution already running');
      try {
        const execution = executeOption(option);
        if (forwardOnly) executionRef.current = true;
        return await execution;
      } catch (e) {
        if (e instanceof CrossChainQuoteExpiredError) setQuoteRevision((v) => v + 1);
        captureBurnUnresolved(e);
        setError(e instanceof Error ? e : new Error(String(e)));
        setIsExecuting(false);
        throw e;
      } finally {
        if (forwardOnly) { executionRef.current = false; scanRecovery(); }
      }
    },
    [executeOption, captureBurnUnresolved, forwardOnly, scanRecovery],
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

  const recheckForward = useCallback(async (consent = false) => {
    if (executionRef.current || pendingRecovery?.kind !== 'pending' || !pendingRecovery.state?.forward || !pendingRecovery.sourceChainId) return;
    const sourceDomain = domainForChainId(pendingRecovery.sourceChainId)!;
    const savedQuote = pendingRecovery.state.forward.acceptedQuote;
    // 再確認は probe-only。probe が burn を返した場合だけ新 quote を提示して二度目の同意を待つ。
    const quote = consent ? recoveryQuote : savedQuote;
    if (!quote) return;
    executionRef.current = true;
    setIsExecuting(true);
    setError(undefined);
    try {
      const completed = await runCore({ kind: 'cctp-v2', sourceChainId: pendingRecovery.sourceChainId,
        sourceDomain, destDomain: 26, forward: { acceptedQuote: quote, allowBurn: consent } });
      setResult(completed);
      setRecoveryQuote(undefined);
    } catch (e) {
      if (e instanceof CrossChainQuoteExpiredError) setRecoveryQuote(e.replacementQuote);
      captureBurnUnresolved(e);
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      executionRef.current = false;
      setIsExecuting(false);
      scanRecovery();
    }
  }, [pendingRecovery, recoveryQuote, runCore, captureBurnUnresolved, scanRecovery]);

  // manual パネルの二段確認完了。次の実行だけ、曖昧な状態からの再 burn を許可する。
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
    pendingRecovery,
    recoveryQuote,
    recheckForward,
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
    executeOption: safeExecuteOption,
    isOptionResumable,
    burnUnresolved,
    armManualReburn,
    isManualReburnArmed,
    adoptBurnTxHash,
  };
}
