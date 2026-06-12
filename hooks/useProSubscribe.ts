'use client';

// OpenPay Pro 加入の client hook。接続 wallet から 500 JPYC を FEE_RECEIVER へ ERC20.transfer →
// tx 確定 → /api/pro/subscribe で on-chain 検証 + 30日付与。検証失敗時は **再送金させず** 同じ
// txHash で subscribe だけ再試行する (二重支払い防止)。設計: plans/pro-plan.md。
//
// 耐久性・状態遷移・resume・terminal/retryable 区別はすべて汎用 hook useJpycEntitlementPay に集約済
// (CSV パスと共有)。本 hook は Pro tier の config (priceWei / endpoint / pendingKey / invalidateKey)
// を差し替える thin wrapper。export signature は従来どおり (useProSubscribe(deployment))。

import { proPriceWei } from '@/lib/proPlan';
import type { TokenDeployment } from '@/lib/tokens';
import {
  useJpycEntitlementPay,
  type EntitlementPayPhase,
} from './useJpycEntitlementPay';

export type ProSubscribePhase = EntitlementPayPhase;

const PENDING_KEY = 'openpay:pro:pendingTx';

export function useProSubscribe(deployment: TokenDeployment) {
  return useJpycEntitlementPay(deployment, {
    priceWei: proPriceWei,
    endpoint: '/api/pro/subscribe',
    pendingStorageKey: PENDING_KEY,
    invalidateKey: ['pro'],
  });
}
