'use client';

// JPYC ガスレス (EIP-3009) の client hook。顧客が transferWithAuthorization に EIP-712 署名
// (eth_signTypedData_v4・委任不要・任意の injected wallet で可) → /api/relay/jpyc が Gelato
// 経由で submit + gas 負担 → {txHash}。詳細は memory:jpyc-eip3009。
//
// Phase 1: 全額を customer→merchant に送る単発 transfer (fee/split/gas 相当額の徴収は Phase 2)。
// flag/relay 未構成時は呼び出し元が resolveJpycGaslessProvider で 7702 経路を選ぶので、本 hook
// は eip3009-relay 解決時のみ使われる。

import { useMutation } from '@tanstack/react-query';
import { useAccount, useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import {
  AUTHORIZATION_VALIDITY_WINDOW_SEC,
  buildTransferWithAuthorizationTypedData,
  randomAuthorizationNonce,
} from '@/lib/jpycEip3009';
import type { TokenDeployment } from '@/lib/tokens';

export type JpycEip3009Params = { merchant: Address; value: bigint };
// success=false は「relay は成立したが tx が on-chain で revert」(B2 と同じ表示方針)。
export type JpycEip3009Result = { txHash: Hex; success: boolean };

type RelayResponse = {
  ok?: boolean;
  txHash?: Hex;
  reverted?: boolean;
  error?: string;
};

export function useJpycEip3009Payment(deployment: TokenDeployment) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();

  return useMutation<JpycEip3009Result, Error, JpycEip3009Params>({
    mutationFn: async ({ merchant, value }) => {
      if (!walletClient || !address || chainId === undefined) {
        throw new Error('wallet_not_connected');
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const auth = {
        from: address as Address,
        to: merchant,
        value,
        validAfter: 0n,
        validBefore: BigInt(nowSec + AUTHORIZATION_VALIDITY_WINDOW_SEC),
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
          from: auth.from,
          to: auth.to,
          value: value.toString(),
          validAfter: auth.validAfter.toString(),
          validBefore: auth.validBefore.toString(),
          nonce: auth.nonce,
          signature,
        }),
      });

      let body: RelayResponse = {};
      try {
        body = (await res.json()) as RelayResponse;
      } catch {
        /* non-JSON response */
      }

      if (res.ok && body.ok && body.txHash) {
        return { txHash: body.txHash, success: true };
      }
      // relay は成立したが tx が revert (残高変動等)。success:false で記録/表示 (B2 方針)。
      if (body.reverted && body.txHash) {
        return { txHash: body.txHash, success: false };
      }
      // それ以外は失敗。error code を message に載せ、form 側で i18n にマップする。
      throw new Error(body.error ?? `http_${res.status}`);
    },
  });
}
