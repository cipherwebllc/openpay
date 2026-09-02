'use client';

// OpenPay 利用料のガスレス支払い専用 hook。店主が transferWithAuthorization(店主→FEE_RECEIVER, fee) に
// 1 署名 → /api/relay/jpyc が中継 (free モード)。顧客決済用 useJpycEip3009Payment と異なり forwarder
// (recover) 分岐を持たず、常に FEE_RECEIVER への直接 transfer を組む (利用料の宛先は固定・分割不要で、
// forwarder 設定の有無に左右されない)。relay 関所は isFeePayment=true (to=FEE_RECEIVER) を常に通す。

import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAccount, useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import {
  AUTHORIZATION_VALIDITY_WINDOW_SEC,
  buildTransferWithAuthorizationTypedData,
  randomAuthorizationNonce,
} from '@/lib/jpycEip3009';
import { env } from '@/lib/env';
import {
  isRelayResponseUnknownError,
  RelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import type { TokenDeployment } from '@/lib/tokens';

// success: relay 成立で確定。pending: broadcast 済だが未確定 (再送禁止 = 二重支払い防止)。
export type UsageFeePayResult = {
  txHash: Hex | null;
  success: boolean;
  pending: boolean;
};

type RelayBody = {
  ok?: boolean;
  txHash?: Hex | null;
  reverted?: boolean;
  pending?: boolean;
  error?: string;
};

// 応答不明で保持した署名済 payload。確定応答 (2xx / 202 / 構造化 4xx) が来るまで
// 同一 payload だけを再 POST し、新しい nonce での再署名を構造的に封じる。
type RetainedUsageFeePayload = {
  payload: Record<string, unknown>;
  // この payload が請求している利用料 (別 amount の要求と取り違えないための照合キー)。
  value: bigint;
};

// relay POST + 応答判定。useJpycEip3009Payment.postRelayPayload と同じ語彙:
// 「未送信を証明できない」応答は全て RelayResponseUnknownError に倒す。
async function postUsageFeeRelay(
  payload: Record<string, unknown>,
): Promise<UsageFeePayResult> {
  let res: Response;
  try {
    res = await fetch('/api/relay/jpyc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // POST が server に届いた後で応答だけ失われた可能性がある。通常 Error に倒すと
    // 呼出側の再試行が新しい nonce で署名し直し、server の冪等キー
    // (chainId+from+nonce) が変わって二重課金になるため、専用の曖昧状態にする。
    throw new RelayResponseUnknownError();
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    // body 読取失敗は 2xx でも broadcast 前を証明できない。成功にも再送可能な
    // server error にもせず曖昧状態にする。
    throw new RelayResponseUnknownError();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayResponseUnknownError();
  }
  const b = parsed as RelayBody;

  if (res.ok && b.ok && b.txHash) {
    return { txHash: b.txHash, success: true, pending: false };
  }
  // 202: broadcast 済・未確定。再送/settle せず pending を返す (二重支払い防止)。
  if (res.status === 202 && b.pending) {
    return { txHash: b.txHash ?? null, success: false, pending: true };
  }
  // non-2xx + 構造化 {error:string} は server が broadcast 前に確定させた従来の
  // fallback-safe error (fee_required 等)。ここだけ再署名を許す。
  if (!res.ok && typeof b.error === 'string') throw new Error(b.error);
  // 2xx の不完全 envelope / 非構造化 non-2xx は未送信を証明できない。
  throw new RelayResponseUnknownError();
}

export function useUsageFeePayment(deployment: TokenDeployment) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();

  // 応答不明 latch。broadcast 済みかもしれない署名済 payload を保持し、確定応答が来る
  // まで新規署名を封じる (何の波及を断つか: 応答喪失 → 再試行 → 新 nonce → server 冪等
  // キー不一致 → 二重課金、という連鎖を断つ)。
  const retainedRef = useRef<RetainedUsageFeePayload | null>(null);

  return useMutation<UsageFeePayResult, Error, { value: bigint }>({
    mutationFn: async ({ value }) => {
      const retained = retainedRef.current;
      if (retained) {
        if (retained.value !== value) {
          // 前回の応答不明が解消するまで、別 amount の新規署名も出さない。
          throw new RelayResponseUnknownError();
        }
        return settleUsageFeeRelay(retainedRef, retained.payload, value);
      }

      if (!walletClient || !address || chainId === undefined) {
        throw new Error('wallet_not_connected');
      }
      const from = address as Address;
      const validBefore = BigInt(
        Math.floor(Date.now() / 1000) + AUTHORIZATION_VALIDITY_WINDOW_SEC,
      );
      const auth = {
        from,
        to: env.feeReceiver as Address,
        value,
        validAfter: 0n,
        validBefore,
        nonce: randomAuthorizationNonce(),
      };
      const typed = buildTransferWithAuthorizationTypedData(
        auth,
        chainId,
        deployment.address,
      );
      const signature = (await walletClient.signTypedData({
        account: address,
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      })) as Hex;

      const payload: Record<string, unknown> = {
        chainId,
        from,
        to: auth.to,
        value: value.toString(),
        validAfter: '0',
        validBefore: validBefore.toString(),
        nonce: auth.nonce,
        signature,
      };
      return settleUsageFeeRelay(retainedRef, payload, value);
    },
  });
}

// POST し、応答不明なら payload を latch に載せてから throw する。確定応答 (成功 /
// 202 pending / 構造化 error) では latch を外し、次回は通常どおり再署名させる。
async function settleUsageFeeRelay(
  retainedRef: { current: RetainedUsageFeePayload | null },
  payload: Record<string, unknown>,
  value: bigint,
): Promise<UsageFeePayResult> {
  try {
    const result = await postUsageFeeRelay(payload);
    retainedRef.current = null;
    return result;
  } catch (error) {
    retainedRef.current = isRelayResponseUnknownError(error)
      ? { payload, value }
      : null;
    throw error;
  }
}
