'use client';

// CSV 24時間パス購入の client hook。2 経路:
//   ガスレス (既定・relay 構成時): EIP-3009 署名のみで 100 JPYC を FEE_RECEIVER へ /api/csv-pass/relay
//     経由で送る (POL/KAIA 不要・OpenPay がガス負担)。署名は本 wrapper が useWalletClient で実装し、
//     汎用 engine (useJpycEntitlementPay) へ callback として渡す。
//   ガスあり (fallback): relay 未構成 (503) のとき、接続 wallet から 100 JPYC を ERC20.transfer。
// どちらも tx 確定 → /api/csv-pass/subscribe で on-chain 検証 + 24時間付与。検証失敗時は **再送金させず**
// 同じ txHash で subscribe だけ再試行する (二重支払い防止)。設計: plans/csv-pass-v2.md / csv-pass.md。
//
// 耐久性・状態遷移・resume・terminal/retryable 区別はすべて汎用 hook useJpycEntitlementPay に集約済
// (Pro と共有)。本 hook は CSV パス tier の config (priceWei / endpoint / pendingKey / invalidateKey /
// relayEndpoint / 署名 callback) を差し替える wrapper。pending localStorage key と invalidate queryKey
// は Pro と非共有。

import { useCallback } from 'react';
import { useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import { csvPassPriceWei } from '@/lib/csvPass';
import type { TokenDeployment } from '@/lib/tokens';
import {
  AUTHORIZATION_VALIDITY_WINDOW_SEC,
  buildTransferWithAuthorizationTypedData,
  randomAuthorizationNonce,
} from '@/lib/jpycEip3009';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { isUserRejection } from '@/lib/walletErrors';
import {
  useJpycEntitlementPay,
  type EntitlementPayPhase,
  type GaslessSignResult,
} from './useJpycEntitlementPay';

export type CsvPassSubscribePhase = EntitlementPayPhase;

const PENDING_KEY = 'openpay:csvpass:pendingTx';

export function useCsvPassSubscribe(deployment: TokenDeployment) {
  const { data: walletClient } = useWalletClient();

  // ガスレス署名: transferWithAuthorization(to=FEE_RECEIVER・value=100 JPYC) を wallet で署名し relay
  // POST 用 payload を返す。拒否/不能/未接続は null (engine が pay-error にする)。署名素材は
  // useJpycEip3009Payment と同一 (nonce=random32 / validAfter=0 / validBefore=now+300s)。
  const signGaslessAuthorization = useCallback(
    async ({
      chainId,
      from,
      priceWei,
    }: {
      chainId: number;
      from: Address;
      priceWei: bigint;
    }): Promise<GaslessSignResult | null> => {
      if (!walletClient || !env.feeReceiverConfigured) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      const validBefore = BigInt(nowSec + AUTHORIZATION_VALIDITY_WINDOW_SEC);
      const auth = {
        from,
        to: env.feeReceiver as Address,
        value: priceWei,
        validAfter: 0n,
        validBefore,
        nonce: randomAuthorizationNonce(),
      };
      const typed = buildTransferWithAuthorizationTypedData(
        auth,
        chainId,
        deployment.address,
      );
      try {
        logger.info('payment.sign_requested', { path: 'csvpass-relay', chainId });
        const signature = (await walletClient.signTypedData({
          account: from,
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        })) as Hex;
        logger.info('payment.sign_completed', { path: 'csvpass-relay', chainId });
        return {
          chainId,
          from,
          value: priceWei.toString(),
          validAfter: '0',
          validBefore: validBefore.toString(),
          nonce: auth.nonce,
          signature,
        };
      } catch (err) {
        if (isUserRejection(err)) {
          logger.info('payment.sign_rejected', { path: 'csvpass-relay', chainId });
        } else {
          logger.warn('payment.sign_failed', {
            path: 'csvpass-relay',
            chainId,
            error: err,
          });
        }
        return null;
      }
    },
    [walletClient, deployment.address],
  );

  return useJpycEntitlementPay(deployment, {
    priceWei: csvPassPriceWei,
    endpoint: '/api/csv-pass/subscribe',
    pendingStorageKey: PENDING_KEY,
    invalidateKey: ['csvpass'],
    // ガスレス購入: 署名のみで 100 JPYC を FEE_RECEIVER へ relay (POL/KAIA 不要・OpenPay がガス負担)。
    // relay 未構成時はガスあり writeContract に fallback (CsvPassPaywall が明示ボタンで提示)。
    relayEndpoint: '/api/csv-pass/relay',
    signGaslessAuthorization,
  });
}
