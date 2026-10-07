'use client';

// 「お店の端末で送る」のお客様側 (plans/store-gas-wallet.md P2b)。既存 forwarder 宛て・手数料欄 1 wei の
// ReceiveWithAuthorization に署名し、受け渡し (/api/register/handoff/<id>/auth) に渡す。送信はお店の端末が
// 自分のガスで行うので、ここでは受け渡しの状態と receipt を待つだけ。
//
// 二重払いを起こさない決まり:
//   - 受け渡しは 1 セッション 1 枠 (サーバ)。同じ署名の再送は冪等。
//   - 「お支払いは行われていません」と出すのは、署名の期限 + 30 秒を過ぎ、かつ authorizationState が未使用だと
//     チェーンで確かめた後だけ (受け渡しの状態の 'open'/'signed' は根拠にしない)。
//   - 状態は専用の sessionStorage key に置き、再読み込みでも同じ署名の待ちに戻る (新しい署名を作らせない)。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
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
import { isUserRejection } from '@/lib/walletErrors';

export const STORE_DEVICE_INTENT_KEY = 'openpay:store-device-intent:v1';
// 受け渡しの読み取り間隔 (お客様側の KV 消費を抑える・Fable 監査)。
export const STORE_DEVICE_POLL_MS = 5_000;
// 署名の期限からこれだけ過ぎたら、チェーンで未使用を確かめて「お支払いは行われていません」へ。
export const STORE_DEVICE_EXPIRY_GRACE_SEC = 30;
const RECEIPT_TIMEOUT_MS = 90_000;

const AUTHORIZATION_STATE_ABI = [
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export type StoreDeviceErrorReason =
  | 'wallet_not_connected'
  | 'wrong_chain'
  | 'unavailable'
  | 'rejected'
  | 'insufficient_balance'
  | 'session_expired'
  | 'session_taken'
  | 'server_rejected';

export type StoreDeviceStatus =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'submitting' }
  // 署名を渡した・お店の端末の送信待ち
  | { phase: 'waiting'; validBefore: number }
  | { phase: 'confirming'; txHash: Hex; validBefore: number }
  | { phase: 'success'; txHash: Hex | null }
  | { phase: 'reverted'; txHash: Hex }
  // 期限を過ぎ、チェーンで未使用を確かめた = お支払いは行われていない
  | { phase: 'expired' }
  | { phase: 'error'; reason: StoreDeviceErrorReason };

type StoredIntent = {
  v: 1;
  handoffId: string;
  chainId: number;
  from: Address;
  nonce: Hex;
  validBefore: number;
};

function readIntent(handoffId: string): StoredIntent | null {
  try {
    const raw = window.sessionStorage.getItem(STORE_DEVICE_INTENT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredIntent>;
    if (
      v.v !== 1 ||
      v.handoffId !== handoffId ||
      typeof v.chainId !== 'number' ||
      typeof v.from !== 'string' ||
      !isAddress(v.from) ||
      typeof v.nonce !== 'string' ||
      typeof v.validBefore !== 'number'
    ) {
      return null;
    }
    return v as StoredIntent;
  } catch {
    // sessionStorage が使えない端末 (再読み込みで待ちに戻れないだけ・支払い自体は止めない)
    return null;
  }
}

function writeIntent(intent: StoredIntent | null): void {
  try {
    if (intent) window.sessionStorage.setItem(STORE_DEVICE_INTENT_KEY, JSON.stringify(intent));
    else window.sessionStorage.removeItem(STORE_DEVICE_INTENT_KEY);
  } catch {
    // 同上 (保存できなくても、今開いている画面の待ちは続く)
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

export function useStoreDevicePayment(deployment: TokenDeployment, handoffId: string) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: deployment.chainId });
  const [status, setStatus] = useState<StoreDeviceStatus>({ phase: 'idle' });
  // 待っている署名 (from・nonce・期限)。読み取りの effect が見る。
  const [intent, setIntent] = useState<StoredIntent | null>(null);
  const inFlight = useRef(false);

  // 再読み込み: 同じ会計で署名済みなら、新しい署名を作らずに待ちへ戻る。
  useEffect(() => {
    const saved = readIntent(handoffId);
    if (saved && saved.chainId === deployment.chainId) {
      setIntent(saved);
      setStatus({ phase: 'waiting', validBefore: saved.validBefore });
    }
  }, [handoffId, deployment.chainId]);

  const finish = useCallback((next: StoreDeviceStatus) => {
    setStatus(next);
    setIntent(null);
    writeIntent(null);
  }, []);

  // 受け渡しの読み取りと期限の判定。
  useEffect(() => {
    if (!intent || !publicClient) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const checkExpiry = async (): Promise<boolean> => {
      if (nowSec() <= intent.validBefore + STORE_DEVICE_EXPIRY_GRACE_SEC) return false;
      try {
        const used = await publicClient.readContract({
          address: deployment.address,
          abi: AUTHORIZATION_STATE_ABI,
          functionName: 'authorizationState',
          args: [intent.from, intent.nonce],
        });
        if (stopped) return true;
        // 使用済み = お店の端末か第三者が送った (店に入っている)。tx が分からなくても支払いは済んでいる。
        finish(used ? { phase: 'success', txHash: null } : { phase: 'expired' });
        return true;
      } catch {
        // チェーンを読めないうちは「行われていない」と言わない (二重払いの種を作らない)。待ちを続ける。
        return false;
      }
    };

    const tick = async () => {
      try {
        const res = await fetch(`/api/register/handoff/${encodeURIComponent(handoffId)}`, {
          cache: 'no-store',
        });
        const body = (await res.json().catch(() => null)) as { txHash?: string | null } | null;
        const txHash = body?.txHash;
        if (!stopped && typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
          setStatus({ phase: 'confirming', txHash: txHash as Hex, validBefore: intent.validBefore });
          try {
            const receipt = await publicClient.waitForTransactionReceipt({
              hash: txHash as Hex,
              timeout: RECEIPT_TIMEOUT_MS,
            });
            if (stopped) return;
            finish(
              receipt.status === 'success'
                ? { phase: 'success', txHash: txHash as Hex }
                : { phase: 'reverted', txHash: txHash as Hex },
            );
            return;
          } catch {
            // receipt を待ちきれなかった → 期限の判定に任せる (届いていれば使用済みで success になる)。
          }
        }
      } catch {
        // 受け渡しを読めない (通信・KV の一時障害)。期限の判定はチェーンで行うので待ちを続ける。
      }
      if (stopped) return;
      if (await checkExpiry()) return;
      timer = setTimeout(() => void tick(), STORE_DEVICE_POLL_MS);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [intent, publicClient, handoffId, deployment.address, finish]);

  const pay = useCallback(
    async ({ merchant, bill }: { merchant: Address; bill: bigint }): Promise<void> => {
      if (inFlight.current) return;
      if (!walletClient || !address || chainId === undefined) {
        setStatus({ phase: 'error', reason: 'wallet_not_connected' });
        return;
      }
      if (chainId !== deployment.chainId) {
        setStatus({ phase: 'error', reason: 'wrong_chain' });
        return;
      }
      const forwarder = jpycForwarderFor(chainId);
      if (!forwarder || !isAddress(env.feeReceiver)) {
        setStatus({ phase: 'error', reason: 'unavailable' });
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
        const typed = buildReceiveWithAuthorizationTypedData(
          params,
          chainId,
          deployment.address,
          forwarder,
        );
        setStatus({ phase: 'signing' });
        let signature: Hex;
        try {
          signature = await walletClient.signTypedData({ account: params.from, ...typed });
        } catch (err) {
          setStatus({ phase: 'error', reason: isUserRejection(err) ? 'rejected' : 'unavailable' });
          return;
        }
        const nonce = buildForwarderNonce(params, chainId, forwarder);
        const saved: StoredIntent = {
          v: 1,
          handoffId,
          chainId,
          from: params.from,
          nonce,
          validBefore,
        };
        // 署名した時点で待ちの情報を残す (応答を受け取る前に閉じても、再読み込みで同じ署名の待ちに戻る)。
        writeIntent(saved);
        setStatus({ phase: 'submitting' });
        const body = JSON.stringify({
          from: params.from,
          merchant: params.merchant,
          merchantValue: params.merchantValue.toString(),
          feeValue: params.feeValue.toString(),
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
        if (res === null) {
          // 届いたか分からない → 待ちに入り、期限の判定 (チェーン) に任せる (失敗と言わない)。
          setIntent(saved);
          setStatus({ phase: 'waiting', validBefore });
          return;
        }
        const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (res.ok && out?.ok) {
          setIntent(saved);
          setStatus({ phase: 'waiting', validBefore });
          return;
        }
        const error = out?.error;
        if (error === 'authorization_used') {
          // この署名はもう使われている (= 店に入っている)。
          finish({ phase: 'success', txHash: null });
          return;
        }
        // ここから先はこの署名を預けられなかった (サーバが受け付けていない) ので、待ちの情報を消す。
        writeIntent(null);
        const reason: StoreDeviceErrorReason =
          error === 'insufficient_balance'
            ? 'insufficient_balance'
            : error === 'slot_taken'
              ? 'session_taken'
              : error === 'expired' || error === 'not_found' || res.status === 404 || res.status === 410
                ? 'session_expired'
                : 'server_rejected';
        setStatus({ phase: 'error', reason });
      } finally {
        inFlight.current = false;
      }
    },
    [walletClient, address, chainId, deployment.chainId, deployment.address, handoffId, finish],
  );

  const reset = useCallback(() => {
    if (intent) return; // 待っている署名がある間は戻さない (新しい署名を作らせない)
    setStatus({ phase: 'idle' });
  }, [intent]);

  return { status, pay, reset };
}
