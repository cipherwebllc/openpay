// OpenPay Pro (月額 ¥500 サブスク) の収益台帳。共有実装は entitlementRevenue に集約し、
// 本モジュールは Pro 固有の key / log 名前空間と公開 API を保持する。

import type { Address } from 'viem';
import {
  makeEntitlementRevenue,
  type EntitlementRevenueEvent,
} from './entitlementRevenue';

export type ProRevenueEvent = EntitlementRevenueEvent;

const recordRevenue = makeEntitlementRevenue({
  keyPrefix: 'pro:revenue',
  logPrefix: 'pro.revenue',
});

// subscribe 成功時に **1 回だけ** 呼ぶ。失敗しても確定済みの加入を壊さない (undercount=honest)。
export async function recordProRevenue(input: {
  wallet: Address;
  priceWei: bigint;
  chainId: number;
  txHash: string;
  paidAtMs: number;
}): Promise<void> {
  return recordRevenue(input);
}
