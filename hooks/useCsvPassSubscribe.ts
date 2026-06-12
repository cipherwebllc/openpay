'use client';

// CSV 24時間パス購入の client hook。接続 wallet から 100 JPYC を FEE_RECEIVER へ ERC20.transfer →
// tx 確定 → /api/csv-pass/subscribe で on-chain 検証 + 24時間付与。検証失敗時は **再送金させず**
// 同じ txHash で subscribe だけ再試行する (二重支払い防止)。設計: plans/csv-pass.md。
//
// 耐久性・状態遷移・resume・terminal/retryable 区別はすべて汎用 hook useJpycEntitlementPay に集約済
// (Pro と共有)。本 hook は CSV パス tier の config (priceWei / endpoint / pendingKey / invalidateKey)
// を差し替える thin wrapper。pending localStorage key と invalidate queryKey は Pro と非共有。

import { csvPassPriceWei } from '@/lib/csvPass';
import type { TokenDeployment } from '@/lib/tokens';
import {
  useJpycEntitlementPay,
  type EntitlementPayPhase,
} from './useJpycEntitlementPay';

export type CsvPassSubscribePhase = EntitlementPayPhase;

const PENDING_KEY = 'openpay:csvpass:pendingTx';

export function useCsvPassSubscribe(deployment: TokenDeployment) {
  return useJpycEntitlementPay(deployment, {
    priceWei: csvPassPriceWei,
    endpoint: '/api/csv-pass/subscribe',
    pendingStorageKey: PENDING_KEY,
    invalidateKey: ['csvpass'],
  });
}
