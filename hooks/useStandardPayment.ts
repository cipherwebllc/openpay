'use client';

// 通常決済（ガスあり） / mode=standard: 顧客 EOA から ERC20.transfer を実行。
// Smart Account / Paymaster は経由せず、顧客 wallet が native gas を支払う。
//
// fee=0 のとき (Phase 1 alpha 期間中の常態) は fee tx を skip、merchant tx 1 件のみ実行。
// fee>0 のときは merchant → fee の 2 件直列実行 (fee tx 単独失敗時は UI に retry 出す)。

import { useCallback, useEffect, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { notifyRegisterStandardFee } from '@/lib/registerFeeNotify';
import type {
  StandardPaymentIntentParams,
  StandardIntentStage,
} from '@/lib/paymentIntentStorage';

type StandardPaymentParams = StandardPaymentIntentParams;

type StandardPaymentResult = {
  merchantTxHash: Hex;
  // fee = 0 のときは undefined (fee tx スキップ)
  feeTxHash?: Hex;
  // merchant tx 確定の block。受領証明として UI 表示に使う。
  blockNumber: bigint;
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

export function useStandardPayment() {
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
  // レジ fee の「用途通知」を同一 fee tx で 1 度だけ撃つ dedupe。付帯処理ゆえ結果は保持しない。
  const registerNotifiedRef = useRef<string | null>(null);

  const { address: customer } = useAccount();
  const merchantWrite = useWriteContract();
  const feeWrite = useWriteContract();

  const merchantTxHash = merchantWrite.data ?? restoredMerchantTxHashRef.current;
  const feeTxHash = feeWrite.data ?? restoredFeeTxHashRef.current;
  const restoredMerchantBlockNumber =
    restoredMerchantBlockNumberRef.current;

  const merchantReceipt = useWaitForTransactionReceipt({
    hash: merchantTxHash,
    chainId,
  });
  const feeReceipt = useWaitForTransactionReceipt({
    hash: feeTxHash,
    chainId,
  });
  const refetchMerchantReceipt = merchantReceipt.refetch;
  const refetchFeeReceipt = feeReceipt.refetch;

  const persistIntent = useCallback(
    (
      stage: StandardIntentStage,
      params: StandardPaymentParams,
      merchantHash: Hex,
      values: { feeHash?: Hex; merchantBlockNumber?: bigint } = {},
    ) => {
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
    [customer],
  );

  const clearPersistedIntent = useCallback(() => {
    storageRef.current?.clearStandardIntent();
    setHasStoredIntent(false);
  }, []);

  const isOriginalPayerConnected = useCallback(() => {
    const originalPayer = lastSubmittedFromRef.current;
    return (
      originalPayer !== undefined &&
      customer !== undefined &&
      originalPayer.toLowerCase() === customer.toLowerCase()
    );
  }, [customer]);

  // レジ standard の fee tx hash をサーバへ通知し、用途を束縛した global claim を作らせる。
  // 掟13 の隔離: これは **anti-abuse 用の付帯処理** であり、決済本体 (merchant/fee の 2 tx は
  // 既に確定済み) へ失敗を波及させない。通知が落ちて claim が作られない場合は「その fee tx を
  // 注文 fee として二重充当できる余地が残る」だけで、資金は動かず顧客の決済も成功したままになる
  // ため、ガードとしては fail-open を選ぶ (逆に throw すると確定済み決済が失敗表示になる)。
  const notifyRegisterFee = useCallback(
    (params: StandardPaymentParams, merchantHash: Hex, feeHash: Hex) => {
      if (params.registerFee !== true || params.saleAmount === undefined) return;
      const dedupeKey = `${merchantHash}:${feeHash}`;
      if (registerNotifiedRef.current === dedupeKey) return;
      registerNotifiedRef.current = dedupeKey;
      void notifyRegisterStandardFee({
        chainId: params.chainId,
        tokenAddress: params.tokenAddress,
        merchant: params.merchant,
        saleAmount: params.saleAmount,
        merchantTxHash: merchantHash,
        feeTxHash: feeHash,
      });
    },
    [],
  );

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
  }, []);

  function mutate(params: StandardPaymentParams): void {
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
    lastSubmittedFromRef.current = customer;
    merchantErrorLoggedKeyRef.current = null;
    merchantReceiptLoggedKeyRef.current = null;
    feeErrorLoggedKeyRef.current = null;
    feeReceiptLoggedKeyRef.current = null;
    registerNotifiedRef.current = null;
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
    if (!storageReady || hasStoredIntent) return;
    const queued = queuedParamsRef.current;
    if (!queued) return;
    queuedParamsRef.current = null;
    mutate(queued);
    // mutate は render ごとに変わるが、storage 読込完了時に queue を 1 度だけ排出する effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStoredIntent, storageReady]);

  const retryFee = useCallback(() => {
    const params = lastParamsRef.current;
    const merchantBlockNumber =
      merchantReceipt.isSuccess &&
      merchantReceipt.data?.status === 'success'
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
      !merchantTxHash ||
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
    persistIntent('fee-awaiting', params, merchantTxHash, {
      merchantBlockNumber,
    });
    submitFee(params, merchantTxHash, merchantBlockNumber);
  }, [
    phase,
    merchantTxHash,
    merchantReceipt.isSuccess,
    merchantReceipt.data,
    restoredMerchantBlockNumber,
    feeWrite,
    isOriginalPayerConnected,
    persistIntent,
    submitFee,
  ]);

  const retryReceipt = useCallback(() => {
    // unknown で許可する操作は、broadcast 済み hash の receipt 再照会のみ。
    if (phase === 'merchant-unknown') {
      void refetchMerchantReceipt();
    } else if (phase === 'fee-unknown') {
      void refetchFeeReceipt();
    }
  }, [phase, refetchMerchantReceipt, refetchFeeReceipt]);

  useEffect(() => {
    const params = lastParamsRef.current;
    if (!params) return;
    if (merchantWrite.isPending) return;
    if (merchantWrite.error) {
      setPhase('merchant-error');
      return;
    }
    if (merchantTxHash && !merchantReceipt.isSuccess && !merchantReceipt.isError) {
      setPhase((prev) => (prev === 'merchant-sending' ? 'merchant-mining' : prev));
      return;
    }
    if (merchantReceipt.error) {
      // useWaitForTransactionReceipt は hash ありのときだけ有効。RPC error は
      // tx 自体の revert ではないため、確定失敗には倒さない。
      if (merchantTxHash) setPhase('merchant-unknown');
      return;
    }
    if (merchantReceipt.isSuccess && merchantReceipt.data?.status === 'success') {
      if (!merchantTxHash) return;
      const merchantBlockNumber = merchantReceipt.data.blockNumber;
      restoredMerchantBlockNumberRef.current = merchantBlockNumber;
      // merchant 確定 → fee > 0 なら自動で fee tx を 1 度だけ起動
      if (params.feeAmount > 0n && !feeStartedRef.current) {
        feeStartedRef.current = true;
        persistIntent('fee-awaiting', params, merchantTxHash, {
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
          submitFee(params, merchantTxHash, merchantBlockNumber);
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
    merchantWrite.isPending,
    merchantWrite.data,
    merchantWrite.error,
    merchantTxHash,
    merchantReceipt.isSuccess,
    merchantReceipt.isError,
    merchantReceipt.data,
    merchantReceipt.error,
    clearPersistedIntent,
    isOriginalPayerConnected,
    persistIntent,
    submitFee,
  ]);

  useEffect(() => {
    const params = lastParamsRef.current;
    if (!params || params.feeAmount === 0n) return;
    if (!feeStartedRef.current) return;

    if (feeWrite.isPending) return;
    if (feeWrite.error) {
      if (merchantTxHash && restoredMerchantBlockNumber !== undefined) {
        persistIntent('fee-awaiting', params, merchantTxHash, {
          merchantBlockNumber: restoredMerchantBlockNumber,
        });
      }
      setPhase('fee-error');
      return;
    }
    if (feeTxHash && !feeReceipt.isSuccess && !feeReceipt.isError) {
      setPhase((prev) => (prev === 'fee-sending' ? 'fee-mining' : prev));
      return;
    }
    if (feeReceipt.error) {
      // merchant 側と同様、receipt RPC error は fee tx の確定失敗ではない。
      if (feeTxHash) setPhase('fee-unknown');
      return;
    }
    if (feeReceipt.isSuccess && feeReceipt.data?.status === 'success') {
      // 2 tx とも確定した後にだけ用途通知を撃つ (no-throw・応答は待たない)。既存の
      // clearPersistedIntent → success 遷移は不変で、通知の成否は phase に影響させない。
      if (merchantTxHash && feeTxHash) {
        notifyRegisterFee(params, merchantTxHash, feeTxHash);
      }
      clearPersistedIntent();
      setPhase('success');
      return;
    }
    if (feeReceipt.isSuccess && feeReceipt.data?.status === 'reverted') {
      if (merchantTxHash && restoredMerchantBlockNumber !== undefined) {
        persistIntent('fee-awaiting', params, merchantTxHash, {
          merchantBlockNumber: restoredMerchantBlockNumber,
        });
      }
      restoredFeeTxHashRef.current = undefined;
      setPhase('fee-error');
    }
  }, [
    feeWrite.isPending,
    feeWrite.data,
    feeWrite.error,
    feeTxHash,
    merchantTxHash,
    restoredMerchantBlockNumber,
    feeReceipt.isSuccess,
    feeReceipt.isError,
    feeReceipt.data,
    feeReceipt.error,
    clearPersistedIntent,
    notifyRegisterFee,
    persistIntent,
  ]);

  // R: wagmi hook 戻り値は毎 render で新規オブジェクトになり得るため、deps array には
  //    object を渡さず必要 field のみ抽出 (exhaustive-deps を field 単位で正確に申告)。
  const mwData = merchantTxHash;
  const mwError = merchantWrite.error;
  const mrData = merchantReceipt.data;
  const mrError = merchantReceipt.error;
  const mrIsSuccess = merchantReceipt.isSuccess;
  const fwData = feeTxHash;
  const fwError = feeWrite.error;
  const frData = feeReceipt.data;
  const frError = feeReceipt.error;
  const frIsSuccess = feeReceipt.isSuccess;

  useEffect(() => {
    const params = lastParamsRef.current;
    if (!params) return;
    void import('@/lib/standardPaymentLog')
      .then(({ emitStandardPaymentLogs }) => {
        emitStandardPaymentLogs(
          params,
          customer,
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

  const merchantBlockNumber =
    merchantReceipt.isSuccess && merchantReceipt.data?.status === 'success'
      ? merchantReceipt.data.blockNumber
      : restoredMerchantBlockNumber;

  const data: StandardPaymentResult | undefined =
    isSuccess && merchantTxHash && merchantBlockNumber !== undefined
      ? {
          merchantTxHash,
          feeTxHash,
          blockNumber: merchantBlockNumber,
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
    merchantTxHash,
    feeTxHash,
    // R: fee-error 時にも merchant 着金記録を残せるよう、phase に依らず merchant
    //    receipt 単独で公開する。usePaymentHistory が fee-error 検知時に
    //    merchant success 行を独立して append するために参照する。
    merchantBlockNumber,
    // R: 履歴 entry に「submit 時点の merchantAmount/feeAmount」を残すための snapshot。
    //    呼出元が live state から amount を渡すと gas quote 30s refetch や
    //    variable-amount UI 編集で receipt 到達時に値が drift する。
    lastSubmittedParams: lastParamsRef.current,
    lastSubmittedFrom: lastSubmittedFromRef.current,
    isRestoring: !storageReady,
    hasActiveIntent: hasStoredIntent,
    hasAttempt: lastParamsRef.current !== null,
    restoredFromStorage: restoredFromStorageRef.current,
  };
}
