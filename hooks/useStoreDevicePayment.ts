'use client';

// 「お店の端末で送る」のお客様側 (plans/store-gas-wallet.md P2b)。既存 forwarder 宛て・手数料欄 1 wei の
// ReceiveWithAuthorization に署名し、受け渡し (/api/register/handoff/<id>/auth) に渡す。送信はお店の端末が
// 自分のガスで行う。結論はサーバの判定 (/api/register/handoff/resolve) だけに従う:
//   - 支払い済み = 信頼する forwarder の Settled (payer・nonce・分割額) を receipt で確かめたとき
//   - 行われていない = 確定ブロックの時刻が期限を過ぎ、そのブロックで未使用だと確かめたとき
//   - それ以外は確認中 (お客様の端末の時計・受け渡しの状態・revert した 1 本の tx・あいまいな応答は根拠にしない)
//
// 二重払いを起こさない決まり:
//   - 署名した時点で「未解決の支払い」として専用の key に残し、結論が出るまで消さない。未解決が残っている間は、
//     別の QR (別の会計) を開いても新しい署名を作らせず、その確認を続ける。
//   - 消すのは、結論が出たとき・サーバが「この署名は預かっていない」と確定的に返したとき (400/404/410/409 枠埋まり) だけ。
//   - 履歴と控えは、署名した時点の値 (支払者・店・金額・明細) で作る (後からウォレットや URL が変わっても動かない)。

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

export const STORE_DEVICE_INTENT_KEY = 'openpay:store-device-intent:v2';
// 受け渡しの読み取り間隔 (署名の期限まで・お客様側の KV 消費を抑える・Fable 監査)。
export const STORE_DEVICE_POLL_MS = 5_000;
// 署名の期限からこれだけ過ぎたら、受け渡しの読み取りをやめてチェーンの判定だけにする。
export const STORE_DEVICE_EXPIRY_GRACE_SEC = 30;
// 期限後の判定の間隔 (確定ブロックを待つ・RPC に負担をかけない)。
const RESOLVE_BACKOFF_MS = [10_000, 20_000, 30_000, 60_000];

/** 署名した時点で固定する、履歴と控えの元になる値。 */
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
  v: 2;
  handoffId: string;
  chainId: number;
  from: Address;
  merchant: Address;
  /** 請求額 (wei の 10 進文字列)。お客様の送金は + 1 wei。 */
  merchantValue: string;
  intentSalt: Hex;
  validBefore: number;
  nonce: Hex;
  snapshot: StoreDevicePaymentSnapshot;
};

export type StoreDeviceErrorReason =
  | 'wallet_not_connected'
  | 'wrong_chain'
  | 'unavailable'
  | 'rejected'
  | 'insufficient_balance'
  | 'session_expired'
  | 'session_taken'
  | 'server_rejected';

// これらは、この QR ではもう支払いを始めない (出し直し・店員への確認が要る)。
const BLOCKING_REASONS: readonly StoreDeviceErrorReason[] = ['session_expired', 'session_taken'];

export type StoreDeviceStatus =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'submitting' }
  // 結論待ち (送信待ち・確定待ち・期限後の判定待ち)。otherCheckout = 別の会計の未解決の支払いを確認中
  | { phase: 'waiting'; intent: StoreDeviceIntent; otherCheckout: boolean }
  | { phase: 'success'; txHash: Hex; intent: StoreDeviceIntent }
  // 確定ブロックで期限切れ・未使用を確かめた = お支払いは行われていない
  | { phase: 'expired'; intent: StoreDeviceIntent }
  | { phase: 'error'; reason: StoreDeviceErrorReason; blocking: boolean };

function isIntent(v: unknown): v is StoreDeviceIntent {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 2 &&
    typeof o.handoffId === 'string' &&
    typeof o.chainId === 'number' &&
    typeof o.from === 'string' &&
    isAddress(o.from) &&
    typeof o.merchant === 'string' &&
    isAddress(o.merchant) &&
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

// 未解決の支払いは端末をまたがないが、タブの再読み込み・別の QR を開いた後も残るよう localStorage に置く。
function readIntent(): StoreDeviceIntent | null {
  try {
    const raw = window.localStorage.getItem(STORE_DEVICE_INTENT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    return isIntent(v) ? v : null;
  } catch {
    // 保存先が使えない端末 (再読み込みで確認に戻れないだけ・今の画面の確認は続く)
    return null;
  }
}

function writeIntent(intent: StoreDeviceIntent | null): void {
  try {
    if (intent) window.localStorage.setItem(STORE_DEVICE_INTENT_KEY, JSON.stringify(intent));
    else window.localStorage.removeItem(STORE_DEVICE_INTENT_KEY);
  } catch {
    // 同上
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

type Resolution = { state: 'settled'; txHash: Hex } | { state: 'expired_unused' } | { state: 'pending' };

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
        ...(txHint ? { txHash: txHint } : {}),
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; state?: string; txHash?: string }
      | null;
    if (!res.ok || !body?.ok) return { state: 'pending' };
    if (body.state === 'settled' && typeof body.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      return { state: 'settled', txHash: body.txHash as Hex };
    }
    if (body.state === 'expired_unused') return { state: 'expired_unused' };
    return { state: 'pending' };
  } catch {
    return { state: 'pending' }; // 判定を読めないうちは結論を出さない
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

export function useStoreDevicePayment(deployment: TokenDeployment, handoffId: string) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();
  const [status, setStatus] = useState<StoreDeviceStatus>({ phase: 'idle' });
  const [tracking, setTracking] = useState<StoreDeviceIntent | null>(null);
  const inFlight = useRef(false);

  // 起動時: 未解決の支払いがあれば、どの QR でもまずその確認に戻る (新しい署名を作らせない)。
  useEffect(() => {
    const saved = readIntent();
    if (saved) {
      setTracking(saved);
      setStatus({ phase: 'waiting', intent: saved, otherCheckout: saved.handoffId !== handoffId });
    }
  }, [handoffId]);

  // 結論が出るまでの確認。
  useEffect(() => {
    if (!tracking) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let txHint: Hex | null = null;
    let lastResolvedHint: Hex | null = null;
    let backoff = 0;

    const conclude = (r: Resolution): boolean => {
      if (stopped || r.state === 'pending') return false;
      writeIntent(null);
      setStatus(
        r.state === 'settled'
          ? { phase: 'success', txHash: r.txHash, intent: tracking }
          : { phase: 'expired', intent: tracking },
      );
      setTracking(null);
      return true;
    };

    const tick = async () => {
      const beforeGrace = nowSec() <= tracking.validBefore + STORE_DEVICE_EXPIRY_GRACE_SEC;
      if (beforeGrace) {
        // 期限まで: 受け渡しを読み、端末の tx が出たらサーバの判定で確かめる。
        const hint = await readTxHint(tracking.handoffId);
        if (stopped) return;
        if (hint) txHint = hint;
        if (txHint && txHint !== lastResolvedHint) {
          lastResolvedHint = txHint;
          if (conclude(await resolveIntent(tracking, txHint))) return;
        }
        if (stopped) return;
        timer = setTimeout(() => void tick(), STORE_DEVICE_POLL_MS);
        return;
      }
      // 期限後: 受け渡しの読み取りはやめ、チェーンの判定だけを間隔を広げて続ける。
      if (conclude(await resolveIntent(tracking, txHint))) return;
      if (stopped) return;
      const wait = RESOLVE_BACKOFF_MS[Math.min(backoff, RESOLVE_BACKOFF_MS.length - 1)];
      backoff += 1;
      timer = setTimeout(() => void tick(), wait);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [tracking]);

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
      // 未解決の支払いがある間は始めない (二重払いの種を作らない)。
      if (tracking || readIntent()) return;
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
      if (!forwarder || !isAddress(env.feeReceiver)) {
        setStatus({ phase: 'error', reason: 'unavailable', blocking: false });
        return;
      }
      inFlight.current = true;
      try {
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
          return;
        }
        const intent: StoreDeviceIntent = {
          v: 2,
          handoffId,
          chainId,
          from: params.from,
          merchant: params.merchant,
          merchantValue: bill.toString(),
          intentSalt: params.intentSalt,
          validBefore,
          nonce: buildForwarderNonce(params, chainId, forwarder),
          snapshot,
        };
        // 署名した時点で未解決として残す (応答を受け取る前に閉じても、次に開いたとき確認に戻る)。
        writeIntent(intent);
        setStatus({ phase: 'submitting' });
        const body = JSON.stringify({
          from: params.from,
          merchant: params.merchant,
          merchantValue: bill.toString(),
          feeValue: STORE_DEVICE_FEE_WEI.toString(),
          validAfter: '0',
          validBefore: String(validBefore),
          intentSalt: params.intentSalt,
          signature,
        });
        let res: Response | null = null;
        // 応答を受け取れないときは同じ本文で 1 回だけ送り直す (サーバは同じ署名を冪等に受ける)。
        for (let attempt = 0; attempt < 2 && res === null; attempt += 1) {
          try {
            res = await fetch(`/api/register/handoff/${encodeURIComponent(handoffId)}/auth`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
            });
          } catch {
            res = null;
          }
        }
        const out =
          res === null
            ? null
            : ((await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null);
        const status400s = res !== null && (res.status === 400 || res.status === 404 || res.status === 410);
        const slotTaken = res !== null && res.status === 409 && out?.error === 'slot_taken';
        if (!status400s && !slotTaken) {
          // 預けた・使用済み (authorization_used)・届いたか分からない (通信・503・読めない応答) はすべて確認へ。
          // 結論はチェーンで出す (失敗とも、行われていないとも言わない)。
          setTracking(intent);
          setStatus({ phase: 'waiting', intent, otherCheckout: false });
          return;
        }
        // ここから先は、サーバがこの署名を預かっていないことが確定している (署名はこの端末にしか無い)。
        writeIntent(null);
        const error = out?.error;
        const reason: StoreDeviceErrorReason = slotTaken
          ? 'session_taken'
          : error === 'insufficient_balance'
            ? 'insufficient_balance'
            : error === 'expired' || error === 'not_found' || res?.status === 404 || res?.status === 410
              ? 'session_expired'
              : 'server_rejected';
        setStatus({ phase: 'error', reason, blocking: BLOCKING_REASONS.includes(reason) });
      } finally {
        inFlight.current = false;
      }
    },
    [walletClient, address, chainId, deployment.chainId, deployment.address, handoffId, tracking, status],
  );

  return { status, pay };
}
