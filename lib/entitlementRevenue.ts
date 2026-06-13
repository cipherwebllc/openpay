// 期限付き利用権 (Pro / CSV パス等) の収益台帳を作る共通ファクトリ (server 専用・KV)。
// txHash 単位の NX マーカーを先に立て、記録済みなら LPUSH を省略する。台帳はレポート用のため、
// KV 障害時は利用権付与を壊さず undercount に倒す。

import type { Address } from 'viem';
import { isKvConfigured, kvLpush, kvLtrim, kvSet } from './kv';
import { logger } from './logger';

const MAX_REVENUE_EVENTS = 10_000;
const REVENUE_RECORDED_TTL_SEC = 400 * 86_400;

export type EntitlementRevenueEvent = {
  w: string; // wallet (lowercase)
  v: string; // priceWei (decimal 文字列)
  c: number; // chainId
  t: number; // 入金時刻 (unix ms)
  h: string; // txHash
};

export type EntitlementRevenueInput = {
  wallet: Address;
  priceWei: bigint;
  chainId: number;
  txHash: string;
  paidAtMs: number;
};

type EntitlementRevenueConfig = {
  keyPrefix: string;
  logPrefix: string;
};

export function makeEntitlementRevenue({
  keyPrefix,
  logPrefix,
}: EntitlementRevenueConfig): (
  input: EntitlementRevenueInput,
) => Promise<void> {
  return async (input) => {
    try {
      if (!isKvConfigured()) return;
      const markerKey = `${keyPrefix}:recorded:${input.chainId}:${input.txHash.toLowerCase()}`;
      const marker = await kvSet(markerKey, '1', {
        nx: true,
        ttlSec: REVENUE_RECORDED_TTL_SEC,
      });
      if (!marker.ok) {
        logger.warn(`${logPrefix}.marker_failed`, { reason: marker.reason });
        return;
      }
      if (marker.value !== 'OK') {
        logger.info(`${logPrefix}.duplicate_skip`, {
          chainId: input.chainId,
          txHash: input.txHash,
        });
        return;
      }
      const event: EntitlementRevenueEvent = {
        w: input.wallet.toLowerCase(),
        v: input.priceWei.toString(),
        c: input.chainId,
        t: input.paidAtMs,
        h: input.txHash,
      };
      const r = await kvLpush(keyPrefix, JSON.stringify(event));
      if (!r.ok) {
        logger.warn(`${logPrefix}.lpush_failed`, { reason: r.reason });
        return;
      }
      if (r.value > MAX_REVENUE_EVENTS) {
        logger.warn(`${logPrefix}.capped`, {
          length: r.value,
          cap: MAX_REVENUE_EVENTS,
        });
        await kvLtrim(keyPrefix, 0, MAX_REVENUE_EVENTS - 1);
      }
    } catch (e) {
      logger.warn(`${logPrefix}.record_failed`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
}
