'use client';

// 通常決済（ガスあり） / mode=standard: 顧客 EOA から ERC20.transfer を実行。
// Smart Account / Paymaster は経由せず、顧客 wallet が native gas を支払う。
//
// fee=0 のとき (Phase 1 alpha 期間中の常態) は fee tx を skip、merchant tx 1 件のみ実行。
// fee>0 のときは merchant → fee の 2 件直列実行 (fee tx 単独失敗時は UI に retry 出す)。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import {
  useAccount,
  usePublicClient,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { classifyTransferReceipt } from '@/lib/replacedTransferReceipt';
import type {
  StandardPaymentIntentParams,
  StandardIntentStage,
} from '@/lib/paymentIntentStorage';

export type StandardPaymentParams = StandardPaymentIntentParams & {
  customer?: Address;
  tip?: true;
  chainSlug?: import('@/lib/chains').ChainSlug;
  mode?: 'standard';
};

type StandardPaymentResult = {
  merchantTxHash: Hex;
  // fee = 0 のときは undefined (fee tx スキップ)
  feeTxHash?: Hex;
  // merchant tx 確定の block。受領証明として UI 表示に使う。
  blockNumber: bigint;
  // fee tx 自身の確定 block (第 7 回レビュー A9: 手数料の履歴に店舗送金の block を流用しない)。fee tx が無ければ undefined。
  feeBlockNumber?: bigint;
};

type PaymentIntentStorage = typeof import('@/lib/paymentIntentStorage');

// 状態遷移:
//   idle → merchant-sending (wallet sign 待ち) → merchant-mining (receipt 待ち)
//     → fee-sending → fee-mining → success            (fee > 0)
//     → success                                        (fee = 0)
//     → merchant-error                                 (merchant tx 失敗、fee 未送信)
//     → fee-error                                      (merchant 確定済、fee tx 失敗、retry 可能)
//     → merchant-unknown                               (merchant hash あり、receipt 不明・再送禁止)
//     → fee-unknown                                    (fee hash あり、receipt 不明・再送禁止)
export type StandardPhase =
  | 'idle'
  | 'merchant-sending'
  | 'merchant-mining'
  | 'fee-sending'
  | 'fee-mining'
  | 'success'
  | 'merchant-error'
  | 'fee-error'
  | 'merchant-unknown'
  | 'fee-unknown';

type PublicClientLike = ReturnType<typeof usePublicClient>;

// 決済ログ用: 取消・別内容の置換を「送った hash の error」として残す (A1)。
function replacedTransferError(replacedBy: Hex | undefined): Error | null {
  return replacedBy
    ? new Error(`transfer tx was replaced by ${replacedBy} without the same Transfer`)
    : null;
}

// 置換先が revert した = 同じ nonce は消費済みで元の送金は永久に mine されない (決済ログ用の error)。
function replacedRevertedError(revertedBy: Hex | undefined): Error | null {
  return revertedBy
    ? new Error(`transfer tx was replaced by ${revertedBy} which reverted`)
    : null;
}

// 試行 (chain・送った hash) に結び付けた別の hash (置換先・確認済みの実 hash)。
type AttemptHashLink = { chainId: number | undefined; sent: Hex; linked: Hex };
// viem の onReplaced で受け取った置換先。reverted = 置換先の receipt (onReplaced が渡す) が revert。
type ReplacedLink = AttemptHashLink & { reverted: boolean };

function linkedHash(
  link: AttemptHashLink | null,
  chainId: number | undefined,
  sent: Hex | undefined,
): Hex | undefined {
  return link &&
    sent &&
    link.chainId === chainId &&
    link.sent.toLowerCase() === sent.toLowerCase()
    ? link.linked
    : undefined;
}

// この試行 (chain・送った hash) の置換先が revert していれば、その置換先の hash。
function replacedRevertedBy(
  link: ReplacedLink | null,
  chainId: number | undefined,
  sent: Hex | undefined,
): Hex | undefined {
  return link?.reverted ? linkedHash(link, chainId, sent) : undefined;
}

// 第 7 回レビュー A4: 実際の wagmi (@wagmi/core の waitForTransactionReceipt) は reverted receipt を
// data で返さず、revert 理由の Error を throw する。そのため receipt query の error だけでは
// 「RPC 障害」と「on-chain revert」を区別できず、revert しても unknown から抜けられない。
// query error のときだけ生の receipt を 1 回引き、status==='reverted' を確かめた hash だけを返す。
// 取れない・未 mine・RPC 障害は返さない = 従来どおり unknown (通信障害を確定失敗と取り違えて
// 新規送金・fee 再送を開け、二重送金へ波及するのを断つ)。
// replacementHash: viem の onReplaced で受け取った置換先 (同じ nonce で mine された tx)。置換先が
// revert すると送った hash の receipt は永久に無いので、置換先の hash で確かめる (置換先の revert は
// onReplaced の receipt で先に確定する。ここは query の error が立った後の確認)。
function useConfirmedRevert(
  enabled: boolean,
  publicClient: PublicClientLike,
  chainId: number | undefined,
  hash: Hex | undefined,
  replacementHash: Hex | undefined,
  receiptError: Error | null,
): Hex | undefined {
  const [reverted, setReverted] = useState<{
    chainId: number | undefined;
    hash: Hex;
  } | null>(null);
  const probedRef = useRef<{ error: Error; probeHash: Hex } | null>(null);
  // 確認ごとに世代を振る。遅れて返った古い確認 (前の試行・前の照会) で、新しい確認の結果を
  // 上書きして次の試行を unknown に戻し、再送を封鎖する波及を断つ。
  const generationRef = useRef(0);
  useEffect(() => {
    if (!enabled || !publicClient || !hash || !receiptError) return;
    const probeHash = replacementHash ?? hash;
    // 同じ query error・同じ確認先では 1 回だけ引く (再照会で新しい error・置換先が判明したら引き直す)。
    const probed = probedRef.current;
    if (probed && probed.error === receiptError && probed.probeHash === probeHash) {
      return;
    }
    probedRef.current = { error: receiptError, probeHash };
    const generation = ++generationRef.current;
    void publicClient.getTransactionReceipt({ hash: probeHash }).then(
      (receipt) => {
        if (generation !== generationRef.current) return;
        if (receipt.status === 'reverted') setReverted({ chainId, hash });
      },
      () => {
        // 未 mine・RPC 障害は revert の証拠ではない。unknown (receipt 再照会のみ) のままにする。
      },
    );
  }, [enabled, publicClient, chainId, hash, replacementHash, receiptError]);
  return reverted && reverted.chainId === chainId ? reverted.hash : undefined;
}

export function useStandardPayment({ enabled = true }: { enabled?: boolean } = {}) {
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [externalError, setExternalError] = useState<Error | null>(null);
  const [phase, setPhase] = useState<StandardPhase>('idle');
  const lastParamsRef = useRef<StandardPaymentParams | null>(null);
  const lastSubmittedFromRef = useRef<Address | undefined>(undefined);
  const storageRef = useRef<PaymentIntentStorage | null>(null);
  const issuedAtRef = useRef(0);
  const restoredFromStorageRef = useRef(false);
  const queuedParamsRef = useRef<StandardPaymentParams | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [hasStoredIntent, setHasStoredIntent] = useState(false);
  const restoredMerchantTxHashRef = useRef<Hex | undefined>(undefined);
  const restoredFeeTxHashRef = useRef<Hex | undefined>(undefined);
  const restoredMerchantBlockNumberRef = useRef<bigint | undefined>(undefined);
  // receipt RPC error (未確定) と、後で取得できた終端 success/reverted の
  // dedupe を分離。unknown の観測済み hash で終端 log を抑止しない。
  const merchantErrorLoggedKeyRef = useRef<string | null>(null);
  const merchantReceiptLoggedKeyRef = useRef<string | null>(null);
  const feeErrorLoggedKeyRef = useRef<string | null>(null);
  const feeReceiptLoggedKeyRef = useRef<string | null>(null);
  // merchant 成功時の自動 fee 起動を「1 度だけ」にする gate。
  // useEffect の dep 変化で重複発火しないよう、merchant 成功した直後にのみ true 化。
  const feeStartedRef = useRef(false);

  const { address: customer } = useAccount();
  const merchantWrite = useWriteContract();
  const feeWrite = useWriteContract();

  // 同内容の置換 (高速化) で確認済みの実 hash を、試行 (chain・送った hash) に結び付けて保持する。
  // isSuccess に依存した一時的な算出値だと、成功後の再照会が RPC エラーになった時点で mine されて
  // いない元 hash に戻り、fee の成功通知・結果・intent 保存へ波及する。以後の照会も実 hash で行う。
  const [merchantMinedLink, setMerchantMinedLink] =
    useState<AttemptHashLink | null>(null);
  const [feeMinedLink, setFeeMinedLink] = useState<AttemptHashLink | null>(null);
  // viem の onReplaced で受け取った置換先 hash (送った hash に結び付ける) と、その receipt の revert。
  // 置換先が revert すると wagmi は throw するが、receipt query は TanStack Query の既定 retry (3 回) が
  // 終わるまで error にならず、retry は送った元の hash を再び待つ。元 tx が RPC から消えていると
  // (wagmi の timeout=0 で) 永久に待ち、query error を待つ確認 (useConfirmedRevert) には届かない。
  // onReplaced が渡す置換先の receipt が reverted なら、retry の完了を待たずにこの試行を確定失敗にする。
  const [merchantReplacedTo, setMerchantReplacedTo] =
    useState<ReplacedLink | null>(null);
  const [feeReplacedTo, setFeeReplacedTo] = useState<ReplacedLink | null>(null);
  // 取消・別内容の置換を確かめた試行 (送った hash → 置換 tx)。receipt の isSuccess に依る一時的な判定のままだと、
  // 再接続の再照会が RPC error になった瞬間に消えて unknown に戻り、次の決済 / fee 再送を封鎖する (#764 Codex P2)。
  // 置換先の revert を onReplaced の receipt で確かめた試行 (送った hash)。receipt query の retry の判断は fetch の
  // 開始時に渡した関数で行われ、enabled を後から false にしても進行中の retryer は止まらない。state ではなく ref に
  // 同期的に記録し (onReplaced は wagmi が throw する前に呼ばれる)、retry の関数がそれを見て元 hash を待ち直さない
  // (消えた元 tx を timeout=0 で待ち続けて新しい決済と並走させない・#764 Codex 4 回目 P3)。
  const finalFailedSentRef = useRef(new Set<string>());
  const receiptRetry = (hash: Hex | undefined) => (failureCount: number) =>
    !(hash && finalFailedSentRef.current.has(hash.toLowerCase())) && failureCount < 3;
  const [merchantReplacedOtherLink, setMerchantReplacedOtherLink] =
    useState<AttemptHashLink | null>(null);
  const [feeReplacedOtherLink, setFeeReplacedOtherLink] =
    useState<AttemptHashLink | null>(null);

  const merchantSentHash = merchantWrite.data ?? restoredMerchantTxHashRef.current;
  const feeSentHash = feeWrite.data ?? restoredFeeTxHashRef.current;
  const merchantTxHash =
    linkedHash(merchantMinedLink, chainId, merchantSentHash) ?? merchantSentHash;
  const feeTxHash = linkedHash(feeMinedLink, chainId, feeSentHash) ?? feeSentHash;
  const restoredMerchantBlockNumber =
    restoredMerchantBlockNumberRef.current;
  // この試行の確定失敗 (置換先の revert・取消/別内容の置換) を確かめた後は、元の hash の receipt を照会し直さない
  // (消えた元 tx を retry・再接続で待ち続けて新しい決済と並走させない・#764 Codex P3)。
  const merchantAttemptFailed =
    !!replacedRevertedBy(merchantReplacedTo, chainId, merchantTxHash) ||
    !!linkedHash(merchantReplacedOtherLink, chainId, merchantTxHash);
  const feeAttemptFailed =
    !!replacedRevertedBy(feeReplacedTo, chainId, feeTxHash) ||
    !!linkedHash(feeReplacedOtherLink, chainId, feeTxHash);

  const merchantReceipt = useWaitForTransactionReceipt({
    // retry の回数は TanStack Query の既定 (3) のまま。確定失敗を確かめた試行だけ retry しない。
    query: { enabled: enabled && !!merchantTxHash && !merchantAttemptFailed, retry: receiptRetry(merchantTxHash) },
    hash: merchantTxHash,
    chainId,
    // wagmi はこの callback を viem の waitForTransactionReceipt へ渡す (query key には含めない)。
    // viem は同じ nonce の置換を見つけると、置換先が revert していても resolve の前にこれを呼ぶ。
    onReplaced: (replacement) => {
      if (replacement.transactionReceipt.status === 'reverted') {
        finalFailedSentRef.current.add(replacement.replacedTransaction.hash.toLowerCase());
      }
      setMerchantReplacedTo({
        chainId,
        sent: replacement.replacedTransaction.hash,
        linked: replacement.transaction.hash,
        reverted: replacement.transactionReceipt.status === 'reverted',
      });
    },
  });
  const feeReceipt = useWaitForTransactionReceipt({
    query: { enabled: enabled && !!feeTxHash && !feeAttemptFailed, retry: receiptRetry(feeTxHash) },
    hash: feeTxHash,
    chainId,
    onReplaced: (replacement) => {
      if (replacement.transactionReceipt.status === 'reverted') {
        finalFailedSentRef.current.add(replacement.replacedTransaction.hash.toLowerCase());
      }
      setFeeReplacedTo({
        chainId,
        sent: replacement.replacedTransaction.hash,
        linked: replacement.transaction.hash,
        reverted: replacement.transactionReceipt.status === 'reverted',
      });
    },
  });
  const refetchMerchantReceipt = merchantReceipt.refetch;
  const refetchFeeReceipt = feeReceipt.refetch;

  const publicClient = usePublicClient({ chainId });
  const merchantRevertedHash = useConfirmedRevert(
    enabled,
    publicClient,
    chainId,
    merchantTxHash,
    linkedHash(merchantReplacedTo, chainId, merchantTxHash),
    merchantReceipt.error,
  );
  const feeRevertedHash = useConfirmedRevert(
    enabled,
    publicClient,
    chainId,
    feeTxHash,
    linkedHash(feeReplacedTo, chainId, feeTxHash),
    feeReceipt.error,
  );
  // この試行の置換先が revert した (onReplaced の receipt で確認) ときの置換先 hash。
  const merchantReplacedRevertedBy = replacedRevertedBy(
    merchantReplacedTo,
    chainId,
    merchantTxHash,
  );
  const feeReplacedRevertedBy = replacedRevertedBy(feeReplacedTo, chainId, feeTxHash);

  // 第 7 回レビュー A1: success receipt の transactionHash が送った hash と違う = 同じ nonce の置換。
  // 置換 tx の log に同じ Transfer があれば同内容 (高速化)・無ければ取消/別内容 (元の送金は不成立)。
  const attemptParams = lastParamsRef.current;
  const merchantReplacement =
    merchantTxHash &&
    attemptParams &&
    merchantReceipt.isSuccess &&
    merchantReceipt.data?.status === 'success'
      ? classifyTransferReceipt(merchantReceipt.data, merchantTxHash, {
          token: attemptParams.tokenAddress,
          to: attemptParams.merchant,
          value: attemptParams.merchantAmount,
        })
      : undefined;
  const feeReplacement =
    feeTxHash &&
    attemptParams &&
    feeReceipt.isSuccess &&
    feeReceipt.data?.status === 'success'
      ? classifyTransferReceipt(feeReceipt.data, feeTxHash, {
          token: attemptParams.tokenAddress,
          to: attemptParams.feeReceiver,
          value: attemptParams.feeAmount,
        })
      : undefined;
  // 取消・別内容に置き換えた tx の hash (= 元の送金は永久に mine されない)。一度確かめたら試行に結び付けて保つ。
  const merchantReplacedOtherNow =
    merchantReplacement?.kind === 'replaced-other'
      ? merchantReplacement.minedTxHash
      : undefined;
  const feeReplacedOtherNow =
    feeReplacement?.kind === 'replaced-other'
      ? feeReplacement.minedTxHash
      : undefined;
  const merchantReplacedBy =
    merchantReplacedOtherNow ??
    linkedHash(merchantReplacedOtherLink, chainId, merchantTxHash);
  const feeReplacedBy =
    feeReplacedOtherNow ?? linkedHash(feeReplacedOtherLink, chainId, feeTxHash);
  useEffect(() => {
    if (!merchantReplacedOtherNow || !merchantTxHash) return;
    setMerchantReplacedOtherLink({ chainId, sent: merchantTxHash, linked: merchantReplacedOtherNow });
  }, [chainId, merchantTxHash, merchantReplacedOtherNow]);
  useEffect(() => {
    if (!feeReplacedOtherNow || !feeTxHash) return;
    setFeeReplacedOtherLink({ chainId, sent: feeTxHash, linked: feeReplacedOtherNow });
  }, [chainId, feeTxHash, feeReplacedOtherNow]);
  // 同内容の置換 (高速化) で実際に mine された tx の hash。
  const merchantMinedTxHash =
    merchantReplacement?.kind === 'replaced-same'
      ? merchantReplacement.minedTxHash
      : undefined;
  const feeMinedTxHash =
    feeReplacement?.kind === 'replaced-same'
      ? feeReplacement.minedTxHash
      : undefined;
  // 以後の結果・保存・履歴・控え・注文通知に使う hash = 実際に mine された hash
  // (同内容の置換なら置換 tx の hash・置換が無ければ送った hash)。
  const merchantSettledTxHash = merchantMinedTxHash ?? merchantTxHash;
  const feeSettledTxHash = feeMinedTxHash ?? feeTxHash;

  // 同内容の置換を確認した時点で実 hash を試行に結び付ける (以後の照会・結果は実 hash)。
  useEffect(() => {
    if (!merchantMinedTxHash || !merchantSentHash) return;
    setMerchantMinedLink({
      chainId,
      sent: merchantSentHash,
      linked: merchantMinedTxHash,
    });
  }, [chainId, merchantSentHash, merchantMinedTxHash]);
  useEffect(() => {
    if (!feeMinedTxHash || !feeSentHash) return;
    setFeeMinedLink({ chainId, sent: feeSentHash, linked: feeMinedTxHash });
  }, [chainId, feeSentHash, feeMinedTxHash]);

  const persistIntent = useCallback(
    (
      stage: StandardIntentStage,
      params: StandardPaymentParams,
      merchantHash: Hex,
      values: { feeHash?: Hex; merchantBlockNumber?: bigint } = {},
    ) => {
      if (!enabled) return;
      storageRef.current?.saveStandardPaymentIntent(
        stage,
        params,
        lastSubmittedFromRef.current ?? customer,
        merchantHash,
        {
          ...(values.feeHash ? { feeTxHash: values.feeHash } : {}),
          ...(values.merchantBlockNumber !== undefined
            ? { merchantBlockNumber: values.merchantBlockNumber }
            : {}),
        },
        issuedAtRef.current || Date.now(),
      );
      setHasStoredIntent(true);
    },
    [customer, enabled],
  );

  const clearPersistedIntent = useCallback(() => {
    if (!enabled) return;
    storageRef.current?.clearStandardIntent();
    setHasStoredIntent(false);
  }, [enabled]);

  const isOriginalPayerConnected = useCallback(() => {
    const originalPayer = lastSubmittedFromRef.current;
    return (
      originalPayer !== undefined &&
      customer !== undefined &&
      originalPayer.toLowerCase() === customer.toLowerCase()
    );
  }, [customer]);

  const submitFee = useCallback(
    (
      params: StandardPaymentParams,
      merchantHash: Hex,
      merchantBlockNumber: bigint,
    ) => {
      setPhase('fee-sending');
      feeWrite.writeContract({
        chainId: params.chainId,
        address: params.tokenAddress,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [params.feeReceiver, params.feeAmount],
      }, {
        onSuccess: (hash) => {
          restoredFeeTxHashRef.current = hash;
          persistIntent('fee', params, merchantHash, {
            feeHash: hash,
            merchantBlockNumber,
          });
        },
      });
    },
    [feeWrite, persistIntent],
  );

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // /pay の First Load JS 予算へ storage parser を載せないため mount 後に遅延取得する。
    void import('@/lib/paymentIntentStorage')
      .then((storage) => {
        if (!active) return;
        storageRef.current = storage;
        const intent = storage.loadStandardIntent();
        setStorageReady(true);
        if (!intent) return;
        // 保存済み hash の確認より前に届いた submit を後から自動送信すると、復元成功直後の
        // 2 本目へ波及する。未解決 intent を優先し、読込中に積まれた操作は破棄する。
        queuedParamsRef.current = null;
        const params = storage.standardParamsFromIntent(intent);
        issuedAtRef.current = intent.issuedAt;
        restoredFromStorageRef.current = true;
        lastParamsRef.current = params;
        lastSubmittedFromRef.current = intent.from;
        setChainId(intent.chainId);
        restoredMerchantTxHashRef.current = intent.merchantTxHash;
        restoredFeeTxHashRef.current = intent.feeTxHash;
        restoredMerchantBlockNumberRef.current =
          intent.merchantBlockNumber !== undefined
            ? BigInt(intent.merchantBlockNumber)
            : undefined;
        setHasStoredIntent(true);
        if (intent.stage === 'merchant') {
          setPhase('merchant-unknown');
          return;
        }
        feeStartedRef.current = true;
        setPhase(intent.stage === 'fee' ? 'fee-unknown' : 'fee-error');
      })
      .catch(() => {
        if (!active) return;
        // chunk 読込障害を通常の決済機能へ波及させない。同一 mount の hash latch は引き続き有効。
        setStorageReady(true);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  function mutate(params: StandardPaymentParams): void {
    if (!enabled) return;
    if (!storageReady) {
      queuedParamsRef.current = params;
      return;
    }
    // R: hash ありの receipt 不明中は、同じ送金が成功済みの可能性がある。
    //    receipt 再照会以外の新規 merchant transfer を禁止し、二重送金を防ぐ。
    if (
      hasStoredIntent ||
      phase === 'merchant-unknown' ||
      phase === 'fee-unknown' ||
      phase === 'fee-error'
    ) {
      return;
    }
    setExternalError(null);
    if (params.merchantAmount <= 0n) {
      setExternalError(new Error('店舗への送金額が 0 のため送金できません'));
      return;
    }
    lastParamsRef.current = params;
    lastSubmittedFromRef.current = params.customer ?? customer;
    merchantErrorLoggedKeyRef.current = null;
    merchantReceiptLoggedKeyRef.current = null;
    feeErrorLoggedKeyRef.current = null;
    feeReceiptLoggedKeyRef.current = null;
    feeStartedRef.current = false;
    restoredFromStorageRef.current = false;
    issuedAtRef.current = Date.now();
    restoredMerchantTxHashRef.current = undefined;
    restoredFeeTxHashRef.current = undefined;
    restoredMerchantBlockNumberRef.current = undefined;
    setChainId(params.chainId);
    setPhase('merchant-sending');
    // R: 連続 mutate 時に前回 hash が残ると useWaitForTransactionReceipt が古い hash の
    //    receipt を待ち続けるため reset() で明示的にクリア。
    merchantWrite.reset();
    feeWrite.reset();
    merchantWrite.writeContract(
      {
        chainId: params.chainId,
        address: params.tokenAddress,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [params.merchant, params.merchantAmount],
      },
      {
        onSuccess: (hash) => {
          restoredMerchantTxHashRef.current = hash;
          persistIntent('merchant', params, hash);
        },
      },
    );
  }

  useEffect(() => {
    if (!enabled || !storageReady || hasStoredIntent) return;
    const queued = queuedParamsRef.current;
    if (!queued) return;
    queuedParamsRef.current = null;
    mutate(queued);
    // mutate は render ごとに変わるが、storage 読込完了時に queue を 1 度だけ排出する effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, hasStoredIntent, storageReady]);

  const retryFee = useCallback(() => {
    if (!enabled) return;
    const params = lastParamsRef.current;
    // A1: 取消・別内容の置換 receipt の block は店舗着金の証拠ではない (fee を送らせない)。
    const merchantBlockNumber =
      merchantReceipt.isSuccess &&
      merchantReceipt.data?.status === 'success' &&
      !merchantReplacedBy
        ? merchantReceipt.data.blockNumber
        : restoredMerchantBlockNumber;
    // R: fee hash ありの receipt 不明は、fee 着金済みの可能性がある。
    //    status='reverted' 確定前の fee 再送を禁止する。
    // merchant leg の payer と別 wallet へ fee prompt を出し、第三者の残高から
    // 手数料を送らせる波及を断つ。未接続時も同じ intent latch を維持する。
    if (
      phase === 'merchant-unknown' ||
      phase === 'fee-unknown' ||
      !isOriginalPayerConnected() ||
      !params ||
      params.feeAmount <= 0n ||
      !merchantSettledTxHash ||
      merchantBlockNumber === undefined
    ) {
      return;
    }
    feeErrorLoggedKeyRef.current = null;
    feeReceiptLoggedKeyRef.current = null;
    feeWrite.reset();
    restoredFeeTxHashRef.current = undefined;
    restoredFromStorageRef.current = false;
    setExternalError(null);
    persistIntent('fee-awaiting', params, merchantSettledTxHash, {
      merchantBlockNumber,
    });
    submitFee(params, merchantSettledTxHash, merchantBlockNumber);
  }, [
    enabled,
    phase,
    merchantSettledTxHash,
    merchantReplacedBy,
    merchantReceipt.isSuccess,
    merchantReceipt.data,
    restoredMerchantBlockNumber,
    feeWrite,
    isOriginalPayerConnected,
    persistIntent,
    submitFee,
  ]);

  const retryReceipt = useCallback(() => {
    if (!enabled) return;
    // unknown で許可する操作は、broadcast 済み hash の receipt 再照会のみ。
    if (phase === 'merchant-unknown') {
      void refetchMerchantReceipt();
    } else if (phase === 'fee-unknown') {
      void refetchFeeReceipt();
    }
  }, [enabled, phase, refetchMerchantReceipt, refetchFeeReceipt]);

  useEffect(() => {
    if (!enabled) return;
    const params = lastParamsRef.current;
    if (!params) return;
    if (merchantWrite.isPending) return;
    if (merchantWrite.error) {
      setPhase('merchant-error');
      return;
    }
    if (merchantReplacedRevertedBy) {
      // P2 (#764 再レビュー): 置換先の revert を onReplaced の receipt で確かめた = 同じ nonce は消費済みで
      // 元の送金は永久に mine されない。receipt query の retry (元 hash を待ち続ける) の完了を待たず、
      // 下の既存 reverted 分岐と同じ後片付けをして mining に留めない。
      clearPersistedIntent();
      restoredMerchantTxHashRef.current = undefined;
      restoredMerchantBlockNumberRef.current = undefined;
      setPhase('merchant-error');
      return;
    }
    if (merchantReplacedBy) {
      // A1: 取消・別内容の置換 = 元の送金は同じ nonce を失い永久に mine されない。下の既存 reverted
      // 分岐と同じ後片付けをし、成功遷移・fee 起動へ進ませない。試行に結び付けて保った判定なので、確定後の再照会の
      // RPC error (isSuccess が落ちる) でも unknown に戻さない (#764 Codex P2)。
      clearPersistedIntent();
      restoredMerchantTxHashRef.current = undefined;
      restoredMerchantBlockNumberRef.current = undefined;
      setPhase('merchant-error');
      return;
    }
    if (merchantTxHash && !merchantReceipt.isSuccess && !merchantReceipt.isError) {
      setPhase((prev) => (prev === 'merchant-sending' ? 'merchant-mining' : prev));
      return;
    }
    if (merchantReceipt.error) {
      // A4: 生の receipt で revert を確かめた hash だけ、下の既存 reverted 分岐と同じ後片付けをする。
      if (merchantTxHash && merchantRevertedHash === merchantTxHash) {
        clearPersistedIntent();
        restoredMerchantTxHashRef.current = undefined;
        restoredMerchantBlockNumberRef.current = undefined;
        setPhase('merchant-error');
        return;
      }
      // useWaitForTransactionReceipt は hash ありのときだけ有効。RPC error は
      // tx 自体の revert ではないため、確定失敗には倒さない。
      if (merchantTxHash) setPhase('merchant-unknown');
      return;
    }
    if (merchantReceipt.isSuccess && merchantReceipt.data?.status === 'success') {
      if (!merchantTxHash) return;
      // A1: 同内容の置換 (高速化) なら実際に mine された hash を保存・fee 起動に使う。
      const merchantHash = merchantMinedTxHash ?? merchantTxHash;
      const merchantBlockNumber = merchantReceipt.data.blockNumber;
      restoredMerchantBlockNumberRef.current = merchantBlockNumber;
      // merchant 確定 → fee > 0 なら自動で fee tx を 1 度だけ起動
      if (params.feeAmount > 0n && !feeStartedRef.current) {
        feeStartedRef.current = true;
        persistIntent('fee-awaiting', params, merchantHash, {
          merchantBlockNumber,
        });
        if (restoredFromStorageRef.current) {
          // reload 復元は read-only に留め、user gesture 無しの fee wallet prompt へ波及させない。
          setPhase('fee-error');
        } else if (!isOriginalPayerConnected()) {
          // merchant 送信後の wallet 切替を fee leg へ波及させず、元 payer が明示 retry
          // できる fee-awaiting latch を維持する。
          setPhase('fee-error');
        } else {
          submitFee(params, merchantHash, merchantBlockNumber);
        }
      } else if (params.feeAmount === 0n) {
        clearPersistedIntent();
        setPhase('success');
      }
      return;
    }
    if (merchantReceipt.isSuccess && merchantReceipt.data?.status === 'reverted') {
      clearPersistedIntent();
      restoredMerchantTxHashRef.current = undefined;
      restoredMerchantBlockNumberRef.current = undefined;
      setPhase('merchant-error');
    }
  }, [
    enabled,
    merchantWrite.isPending,
    merchantWrite.data,
    merchantWrite.error,
    merchantTxHash,
    merchantReceipt.isSuccess,
    merchantReceipt.isError,
    merchantReceipt.data,
    merchantReceipt.error,
    merchantRevertedHash,
    merchantReplacedRevertedBy,
    merchantReplacedBy,
    merchantMinedTxHash,
    clearPersistedIntent,
    isOriginalPayerConnected,
    persistIntent,
    submitFee,
  ]);

  useEffect(() => {
    if (!enabled) return;
    const params = lastParamsRef.current;
    if (!params || params.feeAmount === 0n) return;
    if (!feeStartedRef.current) return;

    if (feeWrite.isPending) return;
    if (feeWrite.error) {
      if (merchantSettledTxHash && restoredMerchantBlockNumber !== undefined) {
        persistIntent('fee-awaiting', params, merchantSettledTxHash, {
          merchantBlockNumber: restoredMerchantBlockNumber,
        });
      }
      setPhase('fee-error');
      return;
    }
    if (feeReplacedRevertedBy) {
      // P2 (#764 再レビュー): merchant 側と同じく、置換先の revert を onReplaced の receipt で確かめたら
      // query の retry 完了を待たず、下の既存 reverted 分岐と同じ後片付け (fee-awaiting へ戻して
      // fee 再送を許す) をして fee-mining に留めない。
      if (merchantSettledTxHash && restoredMerchantBlockNumber !== undefined) {
        persistIntent('fee-awaiting', params, merchantSettledTxHash, {
          merchantBlockNumber: restoredMerchantBlockNumber,
        });
      }
      restoredFeeTxHashRef.current = undefined;
      setPhase('fee-error');
      return;
    }
    if (feeReplacedBy) {
      // A1: 取消・別内容の置換 = 元の fee 送金は永久に mine されない。下の既存 reverted 分岐と同じ
      // 後片付け (fee-awaiting へ戻して fee 再送を許す) をし、success へ進ませない。試行に結び付けて
      // 保った判定なので、確定後の再照会の RPC error でも unknown に戻さない (#764 Codex P2)。
      if (merchantSettledTxHash && restoredMerchantBlockNumber !== undefined) {
        persistIntent('fee-awaiting', params, merchantSettledTxHash, {
          merchantBlockNumber: restoredMerchantBlockNumber,
        });
      }
      restoredFeeTxHashRef.current = undefined;
      setPhase('fee-error');
      return;
    }
    if (feeTxHash && !feeReceipt.isSuccess && !feeReceipt.isError) {
      setPhase((prev) => (prev === 'fee-sending' ? 'fee-mining' : prev));
      return;
    }
    if (feeReceipt.error) {
      // A4: 生の receipt で revert を確かめた hash だけ、下の既存 reverted 分岐と同じ後片付けをする。
      if (feeTxHash && feeRevertedHash === feeTxHash) {
        if (merchantSettledTxHash && restoredMerchantBlockNumber !== undefined) {
          persistIntent('fee-awaiting', params, merchantSettledTxHash, {
            merchantBlockNumber: restoredMerchantBlockNumber,
          });
        }
        restoredFeeTxHashRef.current = undefined;
        setPhase('fee-error');
        return;
      }
      // merchant 側と同様、receipt RPC error は fee tx の確定失敗ではない。
      if (feeTxHash) setPhase('fee-unknown');
      return;
    }
    if (feeReceipt.isSuccess && feeReceipt.data?.status === 'success') {
      clearPersistedIntent();
      setPhase('success');
      return;
    }
    if (feeReceipt.isSuccess && feeReceipt.data?.status === 'reverted') {
      if (merchantSettledTxHash && restoredMerchantBlockNumber !== undefined) {
        persistIntent('fee-awaiting', params, merchantSettledTxHash, {
          merchantBlockNumber: restoredMerchantBlockNumber,
        });
      }
      restoredFeeTxHashRef.current = undefined;
      setPhase('fee-error');
    }
  }, [
    enabled,
    feeWrite.isPending,
    feeWrite.data,
    feeWrite.error,
    feeTxHash,
    merchantSettledTxHash,
    feeSettledTxHash,
    feeRevertedHash,
    feeReplacedRevertedBy,
    feeReplacedBy,
    restoredMerchantBlockNumber,
    feeReceipt.isSuccess,
    feeReceipt.isError,
    feeReceipt.data,
    feeReceipt.error,
    clearPersistedIntent,
    persistIntent,
  ]);

  // A1: 取消・別内容の置換は決済ログに success として残さない (送った hash の error として残す)。
  // P2: 置換先の revert も同じく送った hash の error として残す (query の error は retry 中で立たない)。
  const merchantReplacedError = useMemo(
    () =>
      replacedTransferError(merchantReplacedBy) ??
      replacedRevertedError(merchantReplacedRevertedBy),
    [merchantReplacedBy, merchantReplacedRevertedBy],
  );
  const feeReplacedError = useMemo(
    () =>
      replacedTransferError(feeReplacedBy) ??
      replacedRevertedError(feeReplacedRevertedBy),
    [feeReplacedBy, feeReplacedRevertedBy],
  );

  // R: wagmi hook 戻り値は毎 render で新規オブジェクトになり得るため、deps array には
  //    object を渡さず必要 field のみ抽出 (exhaustive-deps を field 単位で正確に申告)。
  // A1: ログの hash も実際に mine された hash (同内容の置換なら置換 tx の hash)。
  const mwData = merchantSettledTxHash;
  const mwError = merchantWrite.error;
  const mrData = merchantReplacedError ? undefined : merchantReceipt.data;
  const mrError = merchantReplacedError ?? merchantReceipt.error;
  const mrIsSuccess = merchantReplacedError ? false : merchantReceipt.isSuccess;
  const fwData = feeSettledTxHash;
  const fwError = feeWrite.error;
  const frData = feeReplacedError ? undefined : feeReceipt.data;
  const frError = feeReplacedError ?? feeReceipt.error;
  const frIsSuccess = feeReplacedError ? false : feeReceipt.isSuccess;

  useEffect(() => {
    if (!enabled) return;
    const params = lastParamsRef.current;
    if (!params) return;
    // ログ chunk の待機中に次の送信へ移っても、payer を別の試行へ取り違えない。
    const logCustomer = params.tip ? lastSubmittedFromRef.current : customer;
    void import('@/lib/standardPaymentLog')
      .then(({ emitStandardPaymentLogs }) => {
        emitStandardPaymentLogs(
          params,
          logCustomer,
          feeStartedRef.current,
          { data: mwData, error: mwError },
          { data: mrData, error: mrError, isSuccess: mrIsSuccess },
          { data: fwData, error: fwError },
          { data: frData, error: frError, isSuccess: frIsSuccess },
          {
            merchantError: merchantErrorLoggedKeyRef,
            merchantReceipt: merchantReceiptLoggedKeyRef,
            feeError: feeErrorLoggedKeyRef,
            feeReceipt: feeReceiptLoggedKeyRef,
          },
        );
      })
      .catch(() => {
        // paymentLog chunk の読込障害を進行中の送金状態へ波及させない。
      });
  }, [
    enabled,
    mwData,
    mwError,
    mrData,
    mrError,
    mrIsSuccess,
    fwData,
    fwError,
    frData,
    frError,
    frIsSuccess,
    customer,
  ]);

  const isPending =
    phase === 'merchant-sending' ||
    phase === 'merchant-mining' ||
    phase === 'fee-sending' ||
    phase === 'fee-mining';
  const isSuccess = phase === 'success';
  const isError = phase === 'merchant-error' || phase === 'fee-error';

  // 優先順: externalError (mutate 事前 validation) → merchant 系 → fee 系
  const error: Error | null =
    externalError ??
    merchantWrite.error ??
    merchantReceipt.error ??
    feeWrite.error ??
    feeReceipt.error;

  // A1: 取消・別内容の置換 receipt の block は店舗着金の block として外へ出さない。
  const merchantBlockNumber =
    merchantReceipt.isSuccess &&
    merchantReceipt.data?.status === 'success' &&
    !merchantReplacedBy
      ? merchantReceipt.data.blockNumber
      : restoredMerchantBlockNumber;

  // A9: 手数料の block は fee receipt 自身のもの (同内容の置換なら置換 tx の receipt = feeSettledTxHash の block)。
  const feeBlockNumber =
    feeSettledTxHash && feeReceipt.isSuccess && feeReceipt.data?.status === 'success'
      ? feeReceipt.data.blockNumber
      : undefined;

  // A1: 結果・履歴・控え・注文通知へ渡す hash は実際に mine された hash。
  const data: StandardPaymentResult | undefined =
    isSuccess && merchantSettledTxHash && merchantBlockNumber !== undefined
      ? {
          merchantTxHash: merchantSettledTxHash,
          feeTxHash: feeSettledTxHash,
          blockNumber: merchantBlockNumber,
          ...(feeBlockNumber !== undefined ? { feeBlockNumber } : {}),
        }
      : undefined;

  return {
    mutate,
    retryFee,
    retryReceipt,
    phase,
    isPending,
    isSuccess,
    isError,
    data,
    error,
    // "merchant 確定済 / fee 失敗" を UI で識別するための個別 flag (retry button gate)。
    isFeeError: phase === 'fee-error',
    isMerchantError: phase === 'merchant-error',
    isUnknown: phase === 'merchant-unknown' || phase === 'fee-unknown',
    isMerchantUnknown: phase === 'merchant-unknown',
    isFeeUnknown: phase === 'fee-unknown',
    // A1: 同内容の置換で mine されたら置換 tx の hash (fee-error 時の履歴補完・注文通知もこれを読む)。
    merchantTxHash: merchantSettledTxHash,
    feeTxHash: feeSettledTxHash,
    // R: fee-error 時にも merchant 着金記録を残せるよう、phase に依らず merchant
    //    receipt 単独で公開する。usePaymentHistory が fee-error 検知時に
    //    merchant success 行を独立して append するために参照する。
    merchantBlockNumber,
    // R: 履歴 entry に「submit 時点の merchantAmount/feeAmount」を残すための snapshot。
    //    呼出元が live state から amount を渡すと gas quote 30s refetch や
    //    variable-amount UI 編集で receipt 到達時に値が drift する。
    lastSubmittedParams: lastParamsRef.current,
    lastSubmittedFrom: lastSubmittedFromRef.current,
    isRestoring: enabled && !storageReady,
    hasActiveIntent: hasStoredIntent,
    hasAttempt: lastParamsRef.current !== null,
    restoredFromStorage: restoredFromStorageRef.current,
  };
}
