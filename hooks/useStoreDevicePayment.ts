'use client';

// 「お店の端末で送る」のお客様側 (plans/store-gas-wallet.md P2b)。既存 forwarder 宛て・手数料欄 1 wei の
// ReceiveWithAuthorization に署名し、受け渡し (/api/register/handoff/<id>/auth) に渡す。送信はお店の端末が
// 自分のガスで行う。結論はサーバの判定 (/api/register/handoff/resolve) だけに従う:
//   - 支払い済み = 信頼する forwarder の Settled を、確定済み・正規のブロックの receipt で確かめたとき
//   - 行われていない = 確定ブロックの時刻が期限を過ぎ、そのブロックで未使用だと確かめたとき
//   - 使用済みだが結果を確かめられない = この署名はもう使えない (支払い済みとも、行われていないとも言わない)
//   - それ以外は確認中 (端末の時計・受け渡しの状態・revert した 1 本の tx・あいまいな応答は根拠にしない)
//
// 二重払いを起こさない決まり:
//   - 署名の前に別タブと排他し (Web Locks)、未解決の支払いが無いことを確かめ直す。署名したら未解決として
//     保存し、保存できたと確かめてから送る (保存できない端末では送らない)。
//   - 未解決の記録を消すのは、結論が出たとき、またはサーバがこの署名を預かっていないと確定したとき
//     (一度も「届いたか分からない」が無く、400/404/410/429/409 枠埋まりを受け取ったとき) だけ。
//     消すのは排他の中で、保存されているのが同じ署名のときだけ。
//   - 未解決が残っている間は、別の QR を開いても新しい署名を作らず、その確認を続ける。
//   - 使用済みだが結果を確かめられないときは、お客様がウォレットで確かめて「確かめた」を押すまで記録を残し、
//     新しい支払いを止める。別タブとの排他 (Web Locks) が無いブラウザでは、この方法を使わない。
//   - 履歴と控えは、署名した時点の値 (支払者・店・金額・明細) で作る。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { env } from '@/lib/env';
import { randomAuthorizationNonce } from '@/lib/jpycEip3009';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import {
  buildForwarderNonce,
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import {
  STORE_DEVICE_FEE_WEI,
  STORE_DEVICE_VALIDITY_SEC,
} from '@/lib/storeDevicePayment';
import type { TokenDeployment } from '@/lib/tokens';
import type { CheckoutItem } from '@/lib/url';
import { isUserRejection } from '@/lib/walletErrors';

export const STORE_DEVICE_INTENT_KEY = 'openpay:store-device-intent:v3';
const PAY_LOCK = 'openpay:store-device-pay';
// 受け渡し・判定の読み取り間隔 (署名の期限まで)。
export const STORE_DEVICE_POLL_MS = 5_000;
// 署名の期限からこれだけ過ぎたら、受け渡しの読み取りをやめてチェーンの判定だけにする。
export const STORE_DEVICE_EXPIRY_GRACE_SEC = 30;
// 期限からこれだけ過ぎたら自動の確認を止め、「いま確認する」だけにする (放置したタブで読み続けない)。
export const STORE_DEVICE_AUTO_STOP_SEC = 600;
// 期限後の判定の間隔 (確定ブロックを待つ・RPC に負担をかけない)。
const RESOLVE_BACKOFF_MS = [10_000, 20_000, 30_000, 60_000];

/** 署名した時点で固定する、表示・履歴・控えの元になる値。 */
export type StoreDevicePaymentSnapshot = {
  storeName?: string;
  invoiceNo?: string;
  items: CheckoutItem[];
  description?: string;
  taxRate?: number;
  taxCategory?: CheckoutItem['taxCategory'];
  receiptNo?: string;
};

export type StoreDeviceIntent = {
  v: 3;
  handoffId: string;
  chainId: number;
  from: Address;
  merchant: Address;
  /** 請求額 (wei の 10 進文字列)。お客様の送金は + 1 wei。 */
  merchantValue: string;
  intentSalt: Hex;
  validBefore: number;
  nonce: Hex;
  /** 署名した時点の forwarder・手数料受取口 (設定が変わったら判定しない)。 */
  forwarder: Address;
  feeReceiver: Address;
  snapshot: StoreDevicePaymentSnapshot;
  /** 使用済みだが結果を確かめられなかった (お客様が「確かめた」を押すまで新しい支払いを止める)。 */
  unknown?: true;
};

export type StoreDeviceErrorReason =
  | 'wallet_not_connected'
  | 'wrong_chain'
  | 'unavailable'
  | 'storage_unavailable'
  | 'rejected'
  | 'insufficient_balance'
  | 'busy'
  | 'session_expired'
  | 'session_taken'
  | 'server_rejected';

// これらは、この QR ではもう支払いを始めない (出し直し・店員への確認が要る)。
const BLOCKING_REASONS: readonly StoreDeviceErrorReason[] = ['session_expired', 'session_taken'];

export type StoreDeviceOutcome = 'success' | 'expired';

export type StoreDeviceStatus =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'submitting' }
  // 結論待ち。otherCheckout = 別の会計の未解決の支払い。confirming = 支払いを見つけて確定待ち。
  // autoStopped = 自動の確認を止めた (「いま確認する」で続ける)。
  | {
      phase: 'waiting';
      intent: StoreDeviceIntent;
      otherCheckout: boolean;
      txHint: Hex | null;
      confirming: boolean;
      autoStopped: boolean;
    }
  | { phase: 'success'; txHash: Hex; intent: StoreDeviceIntent }
  // 確定ブロックで期限切れ・未使用を確かめた = お支払いは行われていない
  | { phase: 'expired'; intent: StoreDeviceIntent }
  // 使用済み (この署名はもう使えない) だが、結果をこちらで確かめられない。お客様がウォレットで確かめて
  // 「確かめた」を押すまで記録を残し、新しい支払いを止める (成立済みなら同じ請求の二重払いになるため)。
  // ackFailed = 「確かめました」で記録を消せなかった (この端末ではこの方法を使えない)。
  | { phase: 'used_unresolved'; intent: StoreDeviceIntent; otherCheckout: boolean; ackFailed?: boolean }
  // 別の会計の未解決の支払いに結論が出た (この QR の会計はこれから払える)
  | { phase: 'previous'; outcome: StoreDeviceOutcome; intent: StoreDeviceIntent; txHash: Hex | null }
  | { phase: 'error'; reason: StoreDeviceErrorReason; blocking: boolean };

function isIntent(v: unknown): v is StoreDeviceIntent {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 3 &&
    typeof o.handoffId === 'string' &&
    typeof o.chainId === 'number' &&
    typeof o.from === 'string' &&
    isAddress(o.from) &&
    typeof o.merchant === 'string' &&
    isAddress(o.merchant) &&
    typeof o.forwarder === 'string' &&
    isAddress(o.forwarder) &&
    typeof o.feeReceiver === 'string' &&
    isAddress(o.feeReceiver) &&
    typeof o.merchantValue === 'string' &&
    /^\d+$/.test(o.merchantValue) &&
    typeof o.intentSalt === 'string' &&
    typeof o.validBefore === 'number' &&
    typeof o.nonce === 'string' &&
    !!o.snapshot &&
    typeof o.snapshot === 'object' &&
    Array.isArray((o.snapshot as Record<string, unknown>).items)
  );
}

// 未解決の支払いは、タブの再読み込み・別の QR を開いた後も残るよう localStorage に置く。
// 読み取りの失敗 (ok: false) は「記録なし」と区別する (失敗を記録なしと読むと、結果不明の記録を上書きしうる)。
function readIntentResult(): { ok: true; intent: StoreDeviceIntent | null } | { ok: false } {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORE_DEVICE_INTENT_KEY);
  } catch {
    return { ok: false };
  }
  if (!raw) return { ok: true, intent: null };
  try {
    const v = JSON.parse(raw) as unknown;
    return { ok: true, intent: isIntent(v) ? v : null };
  } catch {
    return { ok: true, intent: null }; // 読めない形の記録は追跡できない (この版の記録ではない)
  }
}

function readIntent(): StoreDeviceIntent | null {
  const r = readIntentResult();
  return r.ok ? r.intent : null;
}

/** 保存して読み戻しで確かめる。保存できなければ false (呼び出し側は署名を送らない)。 */
function saveIntent(intent: StoreDeviceIntent): boolean {
  try {
    window.localStorage.setItem(STORE_DEVICE_INTENT_KEY, JSON.stringify(intent));
    return readIntent()?.nonce === intent.nonce;
  } catch {
    return false;
  }
}

/**
 * 保存されているのが同じ署名 (nonce) のときだけ消す (別タブの新しい支払いの記録を消さない)。
 * その署名の記録がもう無いと確かめられたら true。
 */
function clearIntentIf(nonce: Hex): boolean {
  const same = (r: ReturnType<typeof readIntentResult>) =>
    r.ok && r.intent?.nonce.toLowerCase() === nonce.toLowerCase();
  try {
    if (same(readIntentResult())) window.localStorage.removeItem(STORE_DEVICE_INTENT_KEY);
  } catch {
    return false;
  }
  const after = readIntentResult();
  return after.ok && !same(after);
}

function hasPayLock(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

/** 同じ端末の別タブと署名・保存・記録の消去を直列化する (Web Locks)。 */
async function withPayLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!hasPayLock()) return fn();
  return navigator.locks.request(PAY_LOCK, fn) as Promise<T>;
}

const nowSec = () => Math.floor(Date.now() / 1000);

type Resolution =
  | { state: 'settled'; txHash: Hex }
  | { state: 'expired_unused' }
  | { state: 'used_unresolved' }
  | { state: 'pending'; confirming: boolean };

async function resolveIntent(intent: StoreDeviceIntent, txHint: Hex | null): Promise<Resolution> {
  try {
    const res = await fetch('/api/register/handoff/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chainId: intent.chainId,
        from: intent.from,
        merchant: intent.merchant,
        merchantValue: intent.merchantValue,
        validBefore: String(intent.validBefore),
        intentSalt: intent.intentSalt,
        nonce: intent.nonce,
        forwarder: intent.forwarder,
        feeReceiver: intent.feeReceiver,
        ...(txHint ? { txHash: txHint } : {}),
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; state?: string; txHash?: string; confirming?: boolean }
      | null;
    if (!res.ok || !body?.ok) return { state: 'pending', confirming: false };
    if (body.state === 'settled' && typeof body.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      return { state: 'settled', txHash: body.txHash as Hex };
    }
    if (body.state === 'expired_unused') return { state: 'expired_unused' };
    if (body.state === 'used_unresolved') return { state: 'used_unresolved' };
    return { state: 'pending', confirming: body.confirming === true };
  } catch {
    return { state: 'pending', confirming: false }; // 判定を読めないうちは結論を出さない
  }
}

async function readTxHint(handoffId: string): Promise<Hex | null> {
  try {
    const res = await fetch(`/api/register/handoff/${encodeURIComponent(handoffId)}`, { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as { txHash?: string | null } | null;
    const tx = body?.txHash;
    return typeof tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx as Hex) : null;
  } catch {
    return null;
  }
}

function waitingStatus(
  intent: StoreDeviceIntent,
  handoffId: string,
  extra: Partial<{ txHint: Hex | null; confirming: boolean; autoStopped: boolean }> = {},
): StoreDeviceStatus {
  return {
    phase: 'waiting',
    intent,
    otherCheckout: intent.handoffId !== handoffId,
    txHint: extra.txHint ?? null,
    confirming: extra.confirming ?? false,
    autoStopped: extra.autoStopped ?? false,
  };
}

export function useStoreDevicePayment(deployment: TokenDeployment, handoffId: string) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();
  const [status, setStatus] = useState<StoreDeviceStatus>({ phase: 'idle' });
  const [tracking, setTracking] = useState<StoreDeviceIntent | null>(null);
  const inFlight = useRef(false);
  // 確認ループと「いま確認する」が共有する最新の tx ヒント。
  const hintRef = useRef<Hex | null>(null);
  // 「いま確認する」を確認ループへ伝える。
  const manualRef = useRef<(() => void) | null>(null);

  // 起動時・QR が変わったとき: 未解決の支払いがあれば、どの QR でもまずその確認に戻る (新しい署名を作らせない)。
  // 結果を確かめられなかった記録は、お客様が「確かめた」を押すまでその案内を出し続ける。
  // 未解決が無ければ、別の QR の会計の結果を残さない (新しい会計の下に前の結果を出さない)。
  useEffect(() => {
    const saved = readIntent();
    if (saved?.unknown) {
      setTracking(null);
      setStatus({ phase: 'used_unresolved', intent: saved, otherCheckout: saved.handoffId !== handoffId });
      return;
    }
    if (saved) {
      hintRef.current = null;
      setTracking(saved);
      setStatus(waitingStatus(saved, handoffId));
      return;
    }
    // (前の QR の誤り・ブロックも新しい QR には持ち越さない)
    setStatus((s) =>
      s.phase === 'error' || ('intent' in s && s.intent.handoffId !== handoffId && s.phase !== 'previous')
        ? { phase: 'idle' }
        : s,
    );
  }, [handoffId]);

  // 結論が出るまでの確認。
  useEffect(() => {
    if (!tracking) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 0;

    const conclude = (r: Resolution): boolean => {
      if (stopped || r.state === 'pending') return false;
      stopped = true; // 結論が出たら、遅れて返る確認で状態を上書きしない
      if (timer) clearTimeout(timer);
      const other = tracking.handoffId !== handoffId;
      if (r.state === 'used_unresolved') {
        // 記録は消さず「結果不明」として残す (お客様が確かめるまで新しい支払いを止める)。
        const unknown: StoreDeviceIntent = { ...tracking, unknown: true };
        void withPayLock(async () => {
          if (readIntent()?.nonce.toLowerCase() === tracking.nonce.toLowerCase()) saveIntent(unknown);
        });
        setStatus({ phase: 'used_unresolved', intent: unknown, otherCheckout: other });
        setTracking(null);
        return true;
      }
      // 結果不明の記録も、支払い済みの証明 (確定ブロックの Settled) が出たら消してよい (二重払いの恐れが無い)。
      // 期限切れ・未使用は、確定ブロックで使用済みの結果不明と両立しない。
      // 消せなくても、次に開いたときは判定で同じ結論が出て消える。
      void withPayLock(async () => clearIntentIf(tracking.nonce));
      if (other) {
        setStatus({
          phase: 'previous',
          outcome: r.state === 'settled' ? 'success' : 'expired',
          intent: tracking,
          txHash: r.state === 'settled' ? r.txHash : null,
        });
      } else if (r.state === 'settled') {
        setStatus({ phase: 'success', txHash: r.txHash, intent: tracking });
      } else {
        setStatus({ phase: 'expired', intent: tracking });
      }
      setTracking(null);
      return true;
    };

    // 確認は一度に一つだけ (自動のタイマーと「いま確認する」が重ならないように)。
    let running = false;
    const once = async (): Promise<boolean> => {
      if (running || stopped) return stopped;
      running = true;
      try {
        return await onceInner();
      } finally {
        running = false;
      }
    };

    const onceInner = async (): Promise<boolean> => {
      const beforeGrace = nowSec() <= tracking.validBefore + STORE_DEVICE_EXPIRY_GRACE_SEC;
      // 期限まで、tx のヒントがまだ無いときだけ受け渡しを読む (ヒントが出たら KV を読まない)。
      if (beforeGrace && !hintRef.current) {
        const hint = await readTxHint(tracking.handoffId);
        if (stopped) return true;
        if (hint) hintRef.current = hint;
      }
      // ヒントがある・期限を過ぎた → サーバの判定 (ヒントは毎回確かめ直す)。
      if (hintRef.current || !beforeGrace) {
        const r = await resolveIntent(tracking, hintRef.current);
        if (conclude(r)) return true;
        if (stopped) return true;
        setStatus(
          waitingStatus(tracking, handoffId, {
            txHint: hintRef.current,
            confirming: r.state === 'pending' && r.confirming,
          }),
        );
      }
      return false;
    };

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      const now = nowSec();
      if (now > tracking.validBefore + STORE_DEVICE_AUTO_STOP_SEC) {
        // 自動の確認はここまで (「いま確認する」で続ける・未解決のロックは外さない)。
        setStatus(waitingStatus(tracking, handoffId, { txHint: hintRef.current, autoStopped: true }));
        return;
      }
      const beforeGrace = now <= tracking.validBefore + STORE_DEVICE_EXPIRY_GRACE_SEC;
      const wait = beforeGrace
        ? STORE_DEVICE_POLL_MS
        : RESOLVE_BACKOFF_MS[Math.min(backoff++, RESOLVE_BACKOFF_MS.length - 1)];
      timer = setTimeout(() => {
        void once().then((done) => {
          if (!done) schedule();
        });
      }, wait);
    };

    manualRef.current = () => {
      if (running || stopped) return; // 確認中の連打は重ねない
      if (timer) clearTimeout(timer);
      backoff = 0;
      running = true;
      void resolveIntent(tracking, hintRef.current)
        .then((r) => {
          if (conclude(r) || stopped) return;
          setStatus(
            waitingStatus(tracking, handoffId, {
              txHint: hintRef.current,
              confirming: r.state === 'pending' && r.confirming,
              autoStopped: nowSec() > tracking.validBefore + STORE_DEVICE_AUTO_STOP_SEC,
            }),
          );
        })
        .finally(() => {
          running = false;
          // 自動の確認を止めた後は、手動の結果 (上の表示) をそのまま残す。
          if (nowSec() <= tracking.validBefore + STORE_DEVICE_AUTO_STOP_SEC) schedule();
        });
    };

    void once().then((done) => {
      if (!done) schedule();
    });
    return () => {
      stopped = true;
      manualRef.current = null;
      if (timer) clearTimeout(timer);
    };
  }, [tracking, handoffId]);

  /** 「いま確認する」(確認中・自動の確認を止めた後の出口)。 */
  const checkNow = useCallback(() => {
    manualRef.current?.();
  }, []);

  /** 結果を確かめられなかった支払いを、お客様がウォレットで確かめた後に閉じる。 */
  const acknowledge = useCallback(async () => {
    if (status.phase !== 'used_unresolved') return;
    const current = status;
    const cleared = await withPayLock(async () => clearIntentIf(current.intent.nonce));
    // 消せなかったら閉じない (閉じても次の支払いで同じ案内に戻り、行き来するだけになる)。
    setStatus(cleared ? { phase: 'idle' } : { ...current, ackFailed: true });
  }, [status]);

  const pay = useCallback(
    async ({
      merchant,
      bill,
      snapshot,
    }: {
      merchant: Address;
      bill: bigint;
      snapshot: StoreDevicePaymentSnapshot;
    }): Promise<void> => {
      if (inFlight.current) return;
      if (status.phase === 'error' && status.blocking) return;
      if (!walletClient || !address || chainId === undefined) {
        setStatus({ phase: 'error', reason: 'wallet_not_connected', blocking: false });
        return;
      }
      if (chainId !== deployment.chainId) {
        setStatus({ phase: 'error', reason: 'wrong_chain', blocking: false });
        return;
      }
      const forwarder = jpycForwarderFor(chainId);
      // 別タブとの排他 (Web Locks) が使えないブラウザでは、二つの署名を作らないよう、この方法を使わない。
      if (!forwarder || !isAddress(env.feeReceiver) || !hasPayLock()) {
        setStatus({ phase: 'error', reason: 'unavailable', blocking: false });
        return;
      }
      inFlight.current = true;
      try {
        // 別タブと排他し、その中で未解決の支払いが無いことを確かめ直してから署名・保存する。
        const signed = await withPayLock(async () => {
          const read = readIntentResult();
          if (!read.ok) {
            setStatus({ phase: 'error', reason: 'storage_unavailable', blocking: false });
            return null;
          }
          const existing = read.intent;
          if (existing?.unknown) {
            setStatus({ phase: 'used_unresolved', intent: existing, otherCheckout: existing.handoffId !== handoffId });
            return null;
          }
          if (existing) {
            hintRef.current = null;
            setTracking(existing);
            setStatus(waitingStatus(existing, handoffId));
            return null;
          }
          const validBefore = nowSec() + STORE_DEVICE_VALIDITY_SEC;
          const params: ForwarderSettleParams = {
            from: getAddress(address),
            merchant: getAddress(merchant),
            // 店の受取 = 請求額ちょうど・手数料欄 1 wei はお客様の送金に上乗せ (user 裁定)。
            merchantValue: bill,
            feeReceiver: getAddress(env.feeReceiver),
            feeValue: STORE_DEVICE_FEE_WEI,
            validAfter: 0n,
            validBefore: BigInt(validBefore),
            intentSalt: randomAuthorizationNonce(),
          };
          const typed = buildReceiveWithAuthorizationTypedData(params, chainId, deployment.address, forwarder);
          setStatus({ phase: 'signing' });
          let signature: Hex;
          try {
            signature = await walletClient.signTypedData({ account: params.from, ...typed });
          } catch (err) {
            setStatus({
              phase: 'error',
              reason: isUserRejection(err) ? 'rejected' : 'unavailable',
              blocking: false,
            });
            return null;
          }
          const intent: StoreDeviceIntent = {
            v: 3,
            handoffId,
            chainId,
            from: params.from,
            merchant: params.merchant,
            merchantValue: bill.toString(),
            intentSalt: params.intentSalt,
            validBefore,
            nonce: buildForwarderNonce(params, chainId, forwarder),
            forwarder: getAddress(forwarder),
            feeReceiver: params.feeReceiver,
            snapshot,
          };
          // 未解決として保存できたと確かめてから送る (保存できない端末では送らない = 署名はこの端末にしか無い)。
          if (!saveIntent(intent)) {
            setStatus({ phase: 'error', reason: 'storage_unavailable', blocking: false });
            return null;
          }
          return { intent, signature, params };
        });
        if (!signed) return;
        const { intent, signature, params } = signed;
        setStatus({ phase: 'submitting' });
        const body = JSON.stringify({
          from: params.from,
          merchant: params.merchant,
          merchantValue: params.merchantValue.toString(),
          feeValue: STORE_DEVICE_FEE_WEI.toString(),
          validAfter: '0',
          validBefore: String(intent.validBefore),
          intentSalt: params.intentSalt,
          signature,
        });
        // 一度でも「届いたか分からない」(通信断・5xx・読めない応答) があれば、後の拒否では記録を消さない。
        let uncertain = false;
        let definitive: { status: number; error?: string } | null = null;
        let accepted = false;
        for (let attempt = 0; attempt < 2 && !accepted && definitive === null; attempt += 1) {
          let res: Response;
          try {
            res = await fetch(`/api/register/handoff/${encodeURIComponent(handoffId)}/auth`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
            });
          } catch {
            uncertain = true;
            continue;
          }
          const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (res.ok && out?.ok) {
            accepted = true;
          } else if (
            out !== null &&
            (res.status === 400 ||
              res.status === 404 ||
              res.status === 410 ||
              res.status === 429 ||
              (res.status === 409 && out.error === 'slot_taken'))
          ) {
            definitive = { status: res.status, error: out.error };
          } else if (res.status === 409 && out?.error === 'authorization_used') {
            accepted = true; // この署名はもう使われている → 判定で確かめる
          } else {
            uncertain = true; // 5xx・読めない応答
          }
        }
        if (accepted || uncertain || definitive === null) {
          // 預けた・使用済み・届いたか分からない → 結論はチェーンで出す (失敗とも、行われていないとも言わない)。
          hintRef.current = null;
          setTracking(intent);
          setStatus(waitingStatus(intent, handoffId));
          return;
        }
        // ここから先は、サーバがこの署名を預かっていないことが確定している (署名はこの端末にしか無い)。
        await withPayLock(async () => clearIntentIf(intent.nonce));
        const reason: StoreDeviceErrorReason =
          definitive.status === 409
            ? 'session_taken'
            : definitive.status === 429
              ? 'busy'
              : definitive.error === 'insufficient_balance'
                ? 'insufficient_balance'
                : definitive.status === 404 || definitive.status === 410
                  ? 'session_expired'
                  : 'server_rejected';
        setStatus({ phase: 'error', reason, blocking: BLOCKING_REASONS.includes(reason) });
      } finally {
        inFlight.current = false;
      }
    },
    [walletClient, address, chainId, deployment.chainId, deployment.address, handoffId, status],
  );

  return { status, pay, checkNow, acknowledge };
}
