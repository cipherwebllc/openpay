// CSV 24時間パス (都度 100 JPYC) の **収益台帳** (運営=OpenPay 自社の入金記録)。
// subscribe 成功時に txHash 単位で 1 回だけ追記し、FEE_RECEIVER 収入を recover 手数料 / a1 利用料 /
// Pro サブスクと会計分離する。真実は on-chain (txHash) + パス状態 (lib/csvPass)。本台帳はレポート用
// インデックスで、欠落しても課金は壊さない (undercount=安全側)。server 専用 (KV)。設計: plans/csv-pass.md。
// 実装方針は lib/proRevenue / lib/feeRevenue と同型 (NX 冪等マーカー先行 → LPUSH)。

import type { Address } from 'viem';
import { kvLpush, kvLtrim, kvSet, isKvConfigured } from './kv';
import { logger } from './logger';

const CSV_PASS_REVENUE_KEY = 'csvpass:revenue';
// CSV パス購入は wallet あたり間欠 (月数回) の低頻度。1 万件で数年分。超過時は古い側を捨て log で開示。
const MAX_CSV_PASS_REVENUE_EVENTS = 10_000;
// txHash 単位の記録済みマーカー TTL。subscribe の結果 TTL (CSV_PASS_RESULT_TTL_SEC=400日) と揃える:
// 同 txHash が replay 扱いになる期間とこの台帳冪等が同じ寿命を持つことで、promote 失敗 → ロック
// 失効 → 同 txHash 再提出が起きてもマーカーがまだ生きていて二重計上を防ぐ。
const CSV_PASS_REVENUE_RECORDED_TTL_SEC = 400 * 86_400;

export type CsvPassRevenueEvent = {
  w: string; // wallet (lowercase)
  v: string; // priceWei (decimal 文字列)
  c: number; // chainId
  t: number; // 入金時刻 (unix ms)
  h: string; // txHash
};

// subscribe 成功時に **1 回だけ** 呼ぶ。失敗しても確定済みの付与を壊さない (try/catch・undercount=honest)。
export async function recordCsvPassRevenue(input: {
  wallet: Address;
  priceWei: bigint;
  chainId: number;
  txHash: string;
  paidAtMs: number;
}): Promise<void> {
  try {
    if (!isKvConfigured()) return;
    // txHash 単位の NX 冪等マーカーを LPUSH の前に立てる (proRevenue / feeRevenue と同方針・理由も同じ)。
    const markerKey = `csvpass:revenue:recorded:${input.chainId}:${input.txHash.toLowerCase()}`;
    const marker = await kvSet(markerKey, '1', {
      nx: true,
      ttlSec: CSV_PASS_REVENUE_RECORDED_TTL_SEC,
    });
    if (!marker.ok) {
      logger.warn('csvpass.revenue.marker_failed', { reason: marker.reason });
      return;
    }
    if (marker.value !== 'OK') {
      logger.info('csvpass.revenue.duplicate_skip', {
        chainId: input.chainId,
        txHash: input.txHash,
      });
      return;
    }
    const event: CsvPassRevenueEvent = {
      w: input.wallet.toLowerCase(),
      v: input.priceWei.toString(),
      c: input.chainId,
      t: input.paidAtMs,
      h: input.txHash,
    };
    const r = await kvLpush(CSV_PASS_REVENUE_KEY, JSON.stringify(event));
    if (!r.ok) {
      logger.warn('csvpass.revenue.lpush_failed', { reason: r.reason });
      return;
    }
    if (r.value > MAX_CSV_PASS_REVENUE_EVENTS) {
      logger.warn('csvpass.revenue.capped', {
        length: r.value,
        cap: MAX_CSV_PASS_REVENUE_EVENTS,
      });
      await kvLtrim(CSV_PASS_REVENUE_KEY, 0, MAX_CSV_PASS_REVENUE_EVENTS - 1);
    }
  } catch (e) {
    logger.warn('csvpass.revenue.record_failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
