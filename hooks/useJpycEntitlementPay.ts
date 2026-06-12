'use client';

// 期限付き利用権 (Pro / CSV パス等) の汎用 client hook。接続 wallet から tier 額の JPYC を
// FEE_RECEIVER へ ERC20.transfer → tx 確定 → config.endpoint で on-chain 検証 + 付与。検証失敗時は
// **再送金させず** 同じ txHash で subscribe だけ再試行する (二重支払い防止)。設計: plans/csv-pass.md。
// useProSubscribe / useCsvPassSubscribe は本 hook の thin wrapper (priceWei/endpoint/pendingKey/
// invalidateKey だけ差し替える)。
//
// 状態遷移: idle → paying (wallet sign 待ち) → mining (receipt 待ち) → subscribing (検証中)
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

export type JpycEntitlementPayConfig = {
  /** tier 額 (JPYC minor units・例 proPriceWei / csvPassPriceWei)。FEE_RECEIVER へ送る額。 */
  priceWei: bigint;
  /** subscribe API のエンドポイント (例 '/api/pro/subscribe' / '/api/csv-pass/subscribe')。 */
  endpoint: string;
  /** broadcast 時点で耐久化する localStorage key (tier 間で非共有)。 */
  pendingStorageKey: string;
  /** 付与確定後に invalidate する react-query queryKey (例 ['pro'] / ['csvpass'])。 */
  invalidateKey: readonly unknown[];
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

export function useJpycEntitlementPay(
  deployment: TokenDeployment,
  config: JpycEntitlementPayConfig,
) {
  const { priceWei, endpoint, pendingStorageKey, invalidateKey } = config;
  const qc = useQueryClient();
  const { address, chainId } = useAccount();
  const [phase, setPhase] = useState<EntitlementPayPhase>('idle');
  // 送金確定後の txHash / その chain を保持し、subscribe 失敗時はこの hash で subscribe だけ再試行する。
  const payTxRef = useRef<Hex | null>(null);
  const payChainIdRef = useRef<number | null>(null);
  const subscribeStartedRef = useRef(false);

  // localStorage はブロック環境で throw しうる (SNS アプリ内ブラウザ等)。耐久化は best-effort で
  // 包み、失敗しても hook 本体 (送金/subscribe) は動かす。
  const loadPending = useCallback((): PendingPayment | null => {
    try {
      const raw = window.localStorage.getItem(pendingStorageKey);
      if (!raw) return null;
      const o = JSON.parse(raw) as Partial<PendingPayment>;
      if (
        typeof o.txHash === 'string' &&
        /^0x[0-9a-fA-F]{64}$/.test(o.txHash) &&
        typeof o.chainId === 'number' &&
        Number.isInteger(o.chainId) &&
        typeof o.wallet === 'string'
      ) {
        return { txHash: o.txHash as Hex, chainId: o.chainId, wallet: o.wallet };
      }
    } catch {
      /* storage 利用不可 / 不正値 */
    }
    return null;
  }, [pendingStorageKey]);
  const savePending = useCallback(
    (rec: PendingPayment): void => {
      try {
        window.localStorage.setItem(pendingStorageKey, JSON.stringify(rec));
      } catch {
        /* 永続化を諦める (subscribe は今回のメモリ上で続行) */
      }
    },
    [pendingStorageKey],
  );
  const clearPending = useCallback((): void => {
    try {
      window.localStorage.removeItem(pendingStorageKey);
    } catch {
      /* noop */
    }
  }, [pendingStorageKey]);

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

  // 送金開始 (tier 額 → FEE_RECEIVER)。FEE_RECEIVER 未設定なら呼出側が事前にガードする前提だが、
  // 二重防御でここでも弾く (未設定の宛先へ送らせない)。
  const start = useCallback(() => {
    if (!address || chainId === undefined || !env.feeReceiverConfigured) return;
    payTxRef.current = null;
    payChainIdRef.current = chainId; // 送金時点の chain を確定保存
    subscribeStartedRef.current = false;
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

  // 送金 → 確定で txHash を保持 + 耐久化 → subscribe を 1 度だけ自動起動。
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

  return {
    start,
    retrySubscribe,
    phase,
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
