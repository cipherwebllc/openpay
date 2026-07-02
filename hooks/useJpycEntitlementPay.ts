'use client';

// 期限付き利用権 (Pro / CSV パス等) の汎用 client hook。接続 wallet から tier 額の JPYC を
// FEE_RECEIVER へ送り → tx 確定 → config.endpoint で on-chain 検証 + 付与。検証失敗時は **再送金させず**
// 同じ txHash で subscribe だけ再試行する (二重支払い防止)。設計: plans/csv-pass.md / csv-pass-v2.md。
// useProSubscribe / useCsvPassSubscribe は本 hook の thin wrapper (priceWei/endpoint/pendingKey/
// invalidateKey、CSV パスは relayEndpoint も差し替える)。
//
// 送金の 2 経路:
//   (A) ガスありの直接 transfer (writeContract・既存)。店主が POL/ETH を持つ前提。startGasPaid()。
//   (B) ガスレス relay (EIP-3009 署名 → config.relayEndpoint POST)。POL 不要・署名のみ。relayEndpoint が
//       与えられ、かつ env.enableJpycEip3009 && chainId ∈ EIP3009_RELAY_CHAINS && feeReceiverConfigured
//       のときに **既定経路**。relay 未構成 (503) のときだけ (A) を fallback ボタンで提示する
//       (自動フォールバックはしない・/pay と同方針)。
//   relayEndpoint を渡さない (Pro 等) tier は (B) を一切実行せず従来挙動 (A のみ) を完全維持する。
//
// 状態遷移: idle → paying (署名/送金) → mining (relay 応答 / receipt 待ち) → subscribing (検証中)
//   → success / pay-error (送金失敗) / subscribe-error (送金確定済・subscribe 失敗・再試行可)。
//
// 耐久性 (Codex P1): 送金確定後の {txHash, chainId, wallet} を localStorage に保存する。リロード/
// アンマウント/切断で subscribe 完了前に画面が消えても「払ったのに請求できない」を防ぐ — 再マウント時
// に同 wallet の pending を自動で claim (subscribe 再試行) する。確定付与 or 恒久失敗 (revert/額不足等)
// で記録を消す。chainId は **送金時点の値を保存**して使う (live chainId が切り替わっても tx の chain で照合)。

import { useCallback, useEffect, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TokenDeployment } from '@/lib/tokens';
import { env } from '@/lib/env';
import { EIP3009_RELAY_CHAINS } from '@/lib/jpycGaslessProvider';
import { useLocalStorageRecord } from '@/hooks/useLocalStorageRecord';

export type EntitlementPayPhase =
  | 'idle'
  | 'paying'
  | 'mining'
  | 'subscribing'
  | 'success'
  | 'pay-error'
  | 'subscribe-error';

type SubscribeResponse = { wallet: string; expiresAt: number };
type PendingPayment = { txHash: Hex; chainId: number; wallet: string };
type PendingGaslessSignature = { payload: GaslessSignResult; wallet: string };

// ガスレス relay へ POST する署名済 payload。pending(hash 無し) の再試行で **同一 payload を再 POST**
// するために保持する (再署名すると nonce が変わり二重支払いになりうるため・idem + on-chain
// authorizationState が同一 payload 再 POST を安全にする)。
// ガスレス署名の結果。startGasless が relay へ POST する署名済 payload。署名拒否/不能は null。
export type GaslessSignResult = {
  chainId: number;
  from: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
};

// pending 記録 (ガスあり broadcast 済 tx) の型ガード。txHash=64桁hex / chainId=整数 / wallet=文字列 を
// すべて満たすときだけ有効。**二重支払い防止 resume の検証層**なので loadPending 由来の shape を厳密に見る。
// (旧 loadPending の inline 検証をそのまま切り出したもの — 判定内容を変えないこと。)
function isPendingPayment(o: unknown): o is PendingPayment {
  if (typeof o !== 'object' || o === null) return false;
  const p = o as Partial<PendingPayment>;
  return (
    typeof p.txHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(p.txHash) &&
    typeof p.chainId === 'number' &&
    Number.isInteger(p.chainId) &&
    typeof p.wallet === 'string'
  );
}

// pending 署名 (txHash 未解決の EIP-3009 authorization) の型ガード。payload の各 field と nonce/signature
// の hex 形式まで検証する。pending 記録とは **別 key / 別 validator** で、取り違えると resume-safety が壊れる。
// (旧 loadPendingSig の inline 検証をそのまま切り出したもの — 判定内容を変えないこと。)
function isPendingGaslessSignature(o: unknown): o is PendingGaslessSignature {
  if (typeof o !== 'object' || o === null) return false;
  const rec = o as Partial<PendingGaslessSignature>;
  const p = rec.payload as Partial<GaslessSignResult> | undefined;
  return (
    !!p &&
    typeof p.from === 'string' &&
    typeof p.value === 'string' &&
    typeof p.validAfter === 'string' &&
    typeof p.validBefore === 'string' &&
    typeof p.nonce === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(p.nonce) &&
    typeof p.signature === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(p.signature) &&
    typeof p.chainId === 'number' &&
    Number.isInteger(p.chainId) &&
    typeof rec.wallet === 'string'
  );
}

export type JpycEntitlementPayConfig = {
  /** tier 額 (JPYC minor units・例 proPriceWei / csvPassPriceWei)。FEE_RECEIVER へ送る額。 */
  priceWei: bigint;
  /** subscribe API のエンドポイント (例 '/api/pro/subscribe' / '/api/csv-pass/subscribe')。 */
  endpoint: string;
  /** broadcast 時点で耐久化する localStorage key (tier 間で非共有)。 */
  pendingStorageKey: string;
  /** 付与確定後に invalidate する react-query queryKey (例 ['pro'] / ['csvpass'])。 */
  invalidateKey: readonly unknown[];
  /**
   * ガスレス relay の endpoint (例 '/api/csv-pass/relay')。**与えた tier だけ** EIP-3009 署名→relay の
   * ガスレス経路が有効になる。未指定 (Pro 等) は従来のガスあり writeContract 経路のみ (挙動完全維持)。
   */
  relayEndpoint?: string;
  /**
   * ガスレス署名関数。EIP-3009 transferWithAuthorization (to=FEE_RECEIVER・value=priceWei) を wallet で
   * 署名し relay POST 用 payload を返す (拒否/不能は null)。**wagmi の useWalletClient はこの callback の
   * 提供側 (CsvPass wrapper) が呼ぶ** — engine 本体は wallet client を直接参照しない (relayEndpoint を渡さ
   * ない Pro が wagmi useWalletClient mock 不在のテストでも壊れないようにするため・hard acceptance)。
   * relayEndpoint とセットで渡す (片方だけでは gasless 経路は走らない)。
   */
  signGaslessAuthorization?: (args: {
    chainId: number;
    from: Address;
    priceWei: bigint;
  }) => Promise<GaslessSignResult | null>;
};

// subscribe が恒久失敗 (再試行しても付与されない) するエラーコード。これらは pending を消し
// 無限 resume を防ぐ。retryable (tx_not_found/verify_unavailable/grant_failed/already_processed) は残す。
const TERMINAL_ERRORS = new Set([
  'tx_reverted',
  'insufficient_payment',
  'used_by_other_wallet',
  'invalid_txhash',
  'invalid_chain',
  'unsupported_chain',
  'invalid_json',
]);

type RelayResponse = {
  ok?: boolean;
  txHash?: Hex | null;
  reverted?: boolean;
  pending?: boolean;
  error?: string;
};

export function useJpycEntitlementPay(
  deployment: TokenDeployment,
  config: JpycEntitlementPayConfig,
) {
  const {
    priceWei,
    endpoint,
    pendingStorageKey,
    invalidateKey,
    relayEndpoint,
    signGaslessAuthorization,
  } = config;
  const sigStorageKey = `${pendingStorageKey}:sig`;
  const qc = useQueryClient();
  const { address, chainId } = useAccount();
  const [phase, setPhase] = useState<EntitlementPayPhase>('idle');
  // relay 未構成 (503/relay_not_configured) を検知したら true。UI はガスあり fallback を提示する。
  const [gaslessUnavailable, setGaslessUnavailable] = useState(false);
  // 送金確定後の txHash / その chain を保持し、subscribe 失敗時はこの hash で subscribe だけ再試行する。
  const payTxRef = useRef<Hex | null>(null);
  const payChainIdRef = useRef<number | null>(null);
  const subscribeStartedRef = useRef(false);
  // pending(hash 無し) の relay 再試行用に署名済 payload を保持 (再署名しない = 二重支払い防止)。
  const gaslessPayloadRef = useRef<GaslessSignResult | null>(null);

  // ガスレス可否 (lib/jpycGaslessProvider と同基準・/pay と同じ)。relayEndpoint + 署名 callback を渡した
  // tier 限定 (両方そろって初めて gasless 経路を走る・Pro は未指定なので常にガスあり)。
  const gaslessAvailable =
    relayEndpoint !== undefined &&
    signGaslessAuthorization !== undefined &&
    env.enableJpycEip3009 &&
    chainId !== undefined &&
    EIP3009_RELAY_CHAINS.has(chainId) &&
    env.feeReceiverConfigured;

  // localStorage はブロック環境で throw しうる (SNS アプリ内ブラウザ等)。耐久化は best-effort で
  // 包み (useLocalStorageRecord)、失敗しても hook 本体 (送金/subscribe) は動かす。pending 記録
  // (broadcast 済 tx) は isPendingPayment で検証する。
  const {
    load: loadPending,
    save: savePending,
    clear: clearPending,
  } = useLocalStorageRecord<PendingPayment>(pendingStorageKey, isPendingPayment);

  // txHash 未解決の署名済 authorization は **別 key** (sigStorageKey) に保存する。txHash pending と
  // 混ぜず、isPendingGaslessSignature で payload/nonce/signature まで検証して同一 nonce の再 POST
  // だけを許可することで、modal close / reload 後の再署名による二重支払いを防ぐ。
  const {
    load: loadPendingSig,
    save: savePendingSig,
    clear: clearPendingSig,
  } = useLocalStorageRecord<PendingGaslessSignature>(
    sigStorageKey,
    isPendingGaslessSignature,
  );

  const payWrite = useWriteContract();
  const payReceipt = useWaitForTransactionReceipt({
    hash: payWrite.data,
    chainId,
  });

  const subscribe = useMutation<SubscribeResponse, Error, PendingPayment>({
    mutationFn: async ({ txHash, chainId: txChainId }) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash, chainId: txChainId }),
      });
      const json = (await res.json().catch(() => ({}))) as
        | (SubscribeResponse & { ok: true })
        | { ok?: false; error?: string };
      if (!res.ok || !('ok' in json) || !json.ok) {
        throw new Error(
          'error' in json && json.error ? json.error : 'subscribe_failed',
        );
      }
      return { wallet: json.wallet, expiresAt: json.expiresAt };
    },
    onSuccess: () => {
      clearPending(); // 付与確定 → 耐久記録を消す
      setPhase('success');
      void qc.invalidateQueries({ queryKey: invalidateKey });
    },
    onError: (e) => {
      setPhase('subscribe-error');
      // 恒久失敗は記録を消す (再 mount で無限 resume しない)。retryable は残し再試行可能に。
      if (TERMINAL_ERRORS.has(e.message)) clearPending();
    },
  });
  const subscribeMutate = subscribe.mutate;

  // ガスレス relay の POST → 結果分岐 (savePending→subscribe / reverted→破棄 / pending-no-hash→保持)。
  // relay は決済 relay (broadcast 後) と同じ扱い: {ok|pending,txHash} は savePending→subscribe へ。
  const postGaslessRelay = useCallback(
    async (payload: GaslessSignResult, signerWallet: Address): Promise<void> => {
      let res: Response;
      try {
        res = await fetch(relayEndpoint as string, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch {
        // ネットワーク層の失敗。**リクエストがサーバに届いた可能性は否定できない** (送信後の切断・
        // タイムアウト等) ため署名済 payload を保持し、再署名ではなく同一 payload の再 POST
        // (retryRelay) を再試行経路にする (再署名は nonce が変わり、初回が実は broadcast 済みだった
        // 場合に二重支払いになる・Codex P1)。idem + on-chain authorizationState が再 POST を安全にする。
        gaslessPayloadRef.current = payload;
        savePendingSig({ payload, wallet: signerWallet });
        setPhase('pay-error');
        return;
      }
      let body: RelayResponse = {};
      try {
        body = (await res.json()) as RelayResponse;
      } catch {
        /* non-JSON */
      }

      // relay 未構成/不可 (503) → ガスあり fallback を UI に出す (自動フォールバックはしない)。
      // 503 は route のゲート群 (flag/feeReceiver/PROVIDER/preflight/日次予算) = **すべて submit 前**
      // なので broadcast は確実に起きていない → payload を破棄して fallback (startGasPaid) を
      // 機能させる (保持したままだと startGasPaid の未解決ガードに弾かれてボタンが無反応になる・Codex P3)。
      if (body.error === 'relay_not_configured' || res.status === 503) {
        gaslessPayloadRef.current = null;
        clearPendingSig();
        setGaslessUnavailable(true);
        setPhase('pay-error');
        return;
      }

      // 成功 or pending(hash あり) → broadcast 済とみなし savePending → subscribe (既存 202 retry に乗る)。
      const txHash =
        (res.ok && body.ok && body.txHash) ||
        (res.status === 202 && body.pending && body.txHash)
          ? (body.txHash as Hex)
          : null;
      if (txHash) {
        gaslessPayloadRef.current = null; // 解決済 → 再 POST 不要
        clearPendingSig();
        payTxRef.current = txHash;
        payChainIdRef.current = payload.chainId; // 署名時点の chain が真実点 (retry 経路でも一致)
        subscribeStartedRef.current = true;
        const rec: PendingPayment = {
          txHash,
          chainId: payload.chainId,
          wallet: signerWallet,
        };
        savePending(rec);
        setPhase('subscribing');
        subscribeMutate(rec);
        return;
      }

      // reverted → 何も送金されていない。pending を残さず破棄 (耐久記録なし) → pay-error。
      if (body.reverted) {
        gaslessPayloadRef.current = null;
        clearPendingSig();
        clearPending();
        setPhase('pay-error');
        return;
      }

      // pending だが txHash 不明 → broadcast 済か不確定。**再署名せず同一 payload を再 POST** できるよう
      // payload を保持し retryable な pay-error にする (retryRelay が再 POST する)。
      if (res.status === 202 && body.pending) {
        gaslessPayloadRef.current = payload;
        savePendingSig({ payload, wallet: signerWallet });
        setPhase('pay-error');
        return;
      }

      // その他のエラー = 確定的な事前拒否 (4xx rejected: 検証不一致/期限切れ/rate-limit 等) または
      // relay_error (502 = submit 層の throw・relay の確立済み不変条件で「fallback safe = 未送信扱い」)。
      // いずれも broadcast されていないので payload を**破棄**する — 保持すると壊れた payload の
      // 無限リプレイに閉じ込め、再署名もガスあり購入もできなくなる (Codex P2)。ユーザは通常 CTA から
      // 新しい署名でやり直せる。payload を保持するのは fetch-throw と 202 pending(hash 無し) の
      // 「届いたか/broadcast されたか不確定」な 2 経路のみ。
      gaslessPayloadRef.current = null;
      clearPendingSig();
      setPhase('pay-error');
    },
    [
      relayEndpoint,
      savePending,
      clearPending,
      savePendingSig,
      clearPendingSig,
      subscribeMutate,
    ],
  );

  // ガスレス送金開始 (EIP-3009 署名 → relay POST)。POL 不要・署名のみ。署名は config.signGaslessAuthorization
  // (wrapper が useWalletClient で実装) に委譲する (engine 本体は wallet client を参照しない)。
  const startGasless = useCallback(async () => {
    if (
      !address ||
      chainId === undefined ||
      !signGaslessAuthorization ||
      !env.feeReceiverConfigured
    ) {
      return;
    }
    const from = address as Address;

    // **再署名ガード (Codex P1)**: 未解決の署名済 payload (pending-no-hash / ネットワーク断 / rejected)
    // が残っている間は、購入 CTA を再度押されても**再署名せず**同一 payload を再 POST する。
    // 再署名 = 新 nonce = 初回が実は broadcast 済みだった場合の二重支払い。再 POST は idem +
    // on-chain authorizationState で冪等・安全。
    if (gaslessPayloadRef.current) {
      payChainIdRef.current = gaslessPayloadRef.current.chainId;
      setPhase('mining');
      await postGaslessRelay(gaslessPayloadRef.current, from);
      return;
    }

    payTxRef.current = null;
    payChainIdRef.current = chainId; // 送金時点の chain を確定保存
    subscribeStartedRef.current = false;
    setGaslessUnavailable(false);
    subscribe.reset();
    setPhase('paying');

    let payload: GaslessSignResult | null;
    try {
      payload = await signGaslessAuthorization({ chainId, from, priceWei });
    } catch {
      // 署名関数の予期せぬ throw (拒否含む) は wrapper 側で握るが二重防御。
      setPhase('pay-error');
      return;
    }
    if (!payload) {
      // 署名拒否/不能 (wrapper が null を返す)。送信していないので pay-error (再試行は再 start)。
      setPhase('pay-error');
      return;
    }
    savePendingSig({ payload, wallet: from });
    setPhase('mining');
    await postGaslessRelay(payload, from);
  }, [
    address,
    chainId,
    signGaslessAuthorization,
    priceWei,
    subscribe,
    postGaslessRelay,
    savePendingSig,
  ]);

  // ガスあり送金開始 (tier 額 → FEE_RECEIVER の直接 transfer)。FEE_RECEIVER 未設定なら呼出側が事前に
  // ガードする前提だが、二重防御でここでも弾く (未設定の宛先へ送らせない)。
  const startGasPaid = useCallback(() => {
    if (!address || chainId === undefined || !env.feeReceiverConfigured) return;
    // 未解決の署名済 gasless payload がある間はガスあり送金も開始しない (初回 relay が実は
    // broadcast 済みだった場合の二重支払い防止・Codex P1)。解決経路は retryRelay (同一 payload
    // 再 POST) のみ。UI 上も fallback ボタンは gaslessUnavailable (=payload 無し) のときしか出ない。
    if (gaslessPayloadRef.current) return;
    payTxRef.current = null;
    payChainIdRef.current = chainId; // 送金時点の chain を確定保存
    subscribeStartedRef.current = false;
    // gaslessUnavailable は **リセットしない** (Codex P2): fallback 送金中に表示が「ガスレス・
    // 当社負担」へ戻る矛盾を防ぐ。フラグは次の startGasless 試行でのみリセットされる。
    subscribe.reset();
    payWrite.reset();
    setPhase('paying');
    payWrite.writeContract({
      chainId,
      address: deployment.address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [env.feeReceiver as Address, priceWei],
    });
  }, [address, chainId, deployment.address, payWrite, subscribe, priceWei]);

  // 既定の送金開始: ガスレス可ならガスレス、不可なら従来のガスあり。Pro 等 relayEndpoint 無しは常に gas-paid。
  const start = useCallback(() => {
    if (gaslessAvailable) {
      void startGasless();
    } else {
      startGasPaid();
    }
  }, [gaslessAvailable, startGasless, startGasPaid]);

  // ガスレス pending(hash 無し) の再試行: **同一 payload を再 POST** する (再署名しない = 二重支払い防止)。
  // idem (csvpassrelay:idem:) + on-chain authorizationState が同一 payload 再 POST を安全にする。
  const retryRelay = useCallback(() => {
    const payload = gaslessPayloadRef.current;
    if (!payload || !address) return;
    setPhase('mining');
    void postGaslessRelay(payload, address as Address);
  }, [address, postGaslessRelay]);

  // subscribe のみ再試行 (再送金しない・保持済み or 耐久化された txHash を使う)。
  const retrySubscribe = useCallback(() => {
    const rec: PendingPayment | null =
      payTxRef.current && payChainIdRef.current != null && address
        ? { txHash: payTxRef.current, chainId: payChainIdRef.current, wallet: address }
        : loadPending();
    if (!rec) return;
    setPhase('subscribing');
    subscribeMutate(rec);
  }, [address, subscribeMutate, loadPending]);

  // 再マウント時の自動 resume (Codex P1): 同 wallet の pending があれば subscribe を 1 度自動起動。
  // 「払ったのにリロードで請求 UI が消えた」を救う。別 wallet の記録は claim しない。
  useEffect(() => {
    if (!address || subscribeStartedRef.current) return;
    const rec = loadPending();
    if (rec && rec.wallet.toLowerCase() === address.toLowerCase()) {
      subscribeStartedRef.current = true;
      payTxRef.current = rec.txHash;
      payChainIdRef.current = rec.chainId;
      setPhase('subscribing');
      subscribeMutate(rec);
    }
  }, [address, subscribeMutate, loadPending]);

  // txHash 未解決の署名済 authorization も再マウント時に同一 payload で自動再 POST する。relay を
  // 持たない Pro 等では storage を読まず、従来のガスあり経路へ一切影響させない。
  useEffect(() => {
    if (
      relayEndpoint === undefined ||
      !address ||
      subscribeStartedRef.current ||
      phase !== 'idle'
    ) {
      return;
    }
    const rec = loadPendingSig();
    if (!rec) return;
    if (rec.wallet.toLowerCase() !== address.toLowerCase()) {
      clearPendingSig();
      // 既知の制約: wallet A の fetch 例外後に B へ切替えると、A の POST 到達有無を client だけでは
      // 判定できない。最終防壁は on-chain authorizationState + idem。送金先は常に FEE_RECEIVER のため、
      // 最悪時は 24時間パス 1 件に対して 200 JPYC を過払いする形になる。
      return;
    }
    gaslessPayloadRef.current = rec.payload;
    payChainIdRef.current = rec.payload.chainId;
    setPhase('mining');
    void postGaslessRelay(rec.payload, address as Address);
  }, [
    address,
    phase,
    relayEndpoint,
    loadPendingSig,
    clearPendingSig,
    postGaslessRelay,
  ]);

  // 送金 → 確定で txHash を保持 + 耐久化 → subscribe を 1 度だけ自動起動。ガスあり経路 (writeContract)
  // のみが駆動する (ガスレスは payWrite.data を持たないので全分岐 no-op)。
  useEffect(() => {
    if (payWrite.isPending) return;
    if (payWrite.error) {
      setPhase('pay-error');
      return;
    }
    if (payWrite.data && !payReceipt.isSuccess && !payReceipt.isError) {
      // 送金 txHash を **受領した瞬間** (receipt 確定前) に耐久化する。broadcast→receipt の窓で
      // リロード/切断されても resume で claim できる (Codex P1 再指摘)。resume 側が未マイニングなら
      // 202 tx_not_found で安全に再試行する。
      if (address && payChainIdRef.current != null) {
        payTxRef.current = payWrite.data;
        savePending({
          txHash: payWrite.data,
          chainId: payChainIdRef.current,
          wallet: address,
        });
      }
      setPhase((prev) => (prev === 'paying' ? 'mining' : prev));
      return;
    }
    if (payReceipt.error) {
      // receipt 取得失敗は tx の成否が不確定 (送金済みかも) → 記録は残し resume で再確認させる。
      setPhase('pay-error');
      return;
    }
    if (payReceipt.isSuccess && payReceipt.data?.status === 'reverted') {
      clearPending(); // 送金が revert = 着金なし → 耐久記録は無効なので消す
      setPhase('pay-error');
      return;
    }
    if (
      payReceipt.isSuccess &&
      payReceipt.data?.status === 'success' &&
      payWrite.data &&
      address &&
      payChainIdRef.current != null &&
      !subscribeStartedRef.current
    ) {
      subscribeStartedRef.current = true;
      payTxRef.current = payWrite.data;
      const rec: PendingPayment = {
        txHash: payWrite.data,
        chainId: payChainIdRef.current,
        wallet: address,
      };
      savePending(rec); // 確定済 (broadcast 時に書き済みだが idempotent に上書き)
      setPhase('subscribing');
      subscribeMutate(rec);
    }
  }, [
    payWrite.isPending,
    payWrite.data,
    payWrite.error,
    payReceipt.isSuccess,
    payReceipt.isError,
    payReceipt.error,
    payReceipt.data,
    address,
    subscribeMutate,
    savePending,
    clearPending,
  ]);

  // pending(hash 無し) の relay 再試行が可能か (UI が「再試行」ボタンの出し分けに使う)。
  const canRetryRelay = phase === 'pay-error' && gaslessPayloadRef.current !== null;

  return {
    start,
    startGasPaid,
    retrySubscribe,
    retryRelay,
    phase,
    gasless: gaslessAvailable,
    gaslessUnavailable,
    canRetryRelay,
    isPaying: phase === 'paying' || phase === 'mining',
    isSubscribing: phase === 'subscribing',
    isSuccess: phase === 'success',
    isPayError: phase === 'pay-error',
    isSubscribeError: phase === 'subscribe-error',
    payTxHash: payWrite.data ?? payTxRef.current ?? null,
    expiresAt: subscribe.data?.expiresAt ?? null,
    error:
      payWrite.error ??
      payReceipt.error ??
      (subscribe.error as Error | null) ??
      null,
  };
}
