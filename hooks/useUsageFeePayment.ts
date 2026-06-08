'use client';

// OpenPay 利用料のガスレス支払い専用 hook。店主が transferWithAuthorization(店主→FEE_RECEIVER, fee) に
// 1 署名 → /api/relay/jpyc が中継 (free モード)。顧客決済用 useJpycEip3009Payment と異なり forwarder
// (recover) 分岐を持たず、常に FEE_RECEIVER への直接 transfer を組む (利用料の宛先は固定・分割不要で、
// forwarder 設定の有無に左右されない)。relay 関所は isFeePayment=true (to=FEE_RECEIVER) を常に通す。

import { useMutation } from '@tanstack/react-query';
import { useAccount, useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import {
  AUTHORIZATION_VALIDITY_WINDOW_SEC,
  buildTransferWithAuthorizationTypedData,
  randomAuthorizationNonce,
} from '@/lib/jpycEip3009';
import { env } from '@/lib/env';
import type { TokenDeployment } from '@/lib/tokens';

// success: relay 成立で確定。pending: broadcast 済だが未確定 (再送禁止 = 二重支払い防止)。
export type UsageFeePayResult = {
  txHash: Hex | null;
  success: boolean;
  pending: boolean;
};

export function useUsageFeePayment(deployment: TokenDeployment) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();

  return useMutation<UsageFeePayResult, Error, { value: bigint }>({
    mutationFn: async ({ value }) => {
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

      const res = await fetch('/api/relay/jpyc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chainId,
          from,
          to: auth.to,
          value: value.toString(),
          validAfter: '0',
          validBefore: validBefore.toString(),
          nonce: auth.nonce,
          signature,
        }),
      });
      let b: {
        ok?: boolean;
        txHash?: Hex | null;
        reverted?: boolean;
        pending?: boolean;
        error?: string;
      } = {};
      try {
        b = (await res.json()) as typeof b;
      } catch {
        /* non-JSON */
      }
      if (res.ok && b.ok && b.txHash) {
        return { txHash: b.txHash, success: true, pending: false };
      }
      // 202: broadcast 済・未確定。再送/settle せず pending を返す (二重支払い防止)。
      if (res.status === 202 && b.pending) {
        return { txHash: b.txHash ?? null, success: false, pending: true };
      }
      throw new Error(b.error ?? `http_${res.status}`);
    },
  });
}
