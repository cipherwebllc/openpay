// CSV 24時間パス (都度 100 JPYC) の収益台帳。共有実装は entitlementRevenue に集約し、
// 本モジュールは CSV パス固有の key / log 名前空間と公開 API を保持する。

import type { Address } from 'viem';
import {
  makeEntitlementRevenue,
  type EntitlementRevenueEvent,
} from './entitlementRevenue';

export type CsvPassRevenueEvent = EntitlementRevenueEvent;

const recordRevenue = makeEntitlementRevenue({
  keyPrefix: 'csvpass:revenue',
  logPrefix: 'csvpass.revenue',
});

// subscribe 成功時に **1 回だけ** 呼ぶ。失敗しても確定済みの付与を壊さない (undercount=honest)。
export async function recordCsvPassRevenue(input: {
  wallet: Address;
  priceWei: bigint;
  chainId: number;
  txHash: string;
  paidAtMs: number;
}): Promise<void> {
  return recordRevenue(input);
}
