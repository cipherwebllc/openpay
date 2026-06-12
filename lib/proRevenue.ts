// OpenPay Pro (月額 ¥500 サブスク) の **収益台帳** (運営=OpenPay 自社の入金記録)。
// subscribe 成功時に txHash 単位で 1 回だけ追記し、FEE_RECEIVER 収入を recover 手数料 / a1 利用料と
// 会計分離する。真実は on-chain (txHash) + Pro 状態 (lib/proPlan)。本台帳はレポート用インデックスで、
// 欠落しても課金は壊さない (undercount=安全側)。server 専用 (KV)。設計: plans/pro-plan.md。
// 実装方針は lib/feeRevenue (a1 収益台帳) と同型 (NX 冪等マーカー先行 → LPUSH)。

import type { Address } from 'viem';
import { kvLpush, kvLtrim, kvSet, isKvConfigured } from './kv';
import { logger } from './logger';

const PRO_REVENUE_KEY = 'pro:revenue';
// Pro 加入は wallet あたり月 1 件程度の低頻度。1 万件で数年分。超過時は古い側を捨て log で開示。
const MAX_PRO_REVENUE_EVENTS = 10_000;
// txHash 単位の記録済みマーカー TTL。subscribe の結果 TTL (PRO_RESULT_TTL_SEC=400日) と揃える:
// 同 txHash が replay 扱いになる期間とこの台帳冪等が同じ寿命を持つことで、promote 失敗 → ロック
// 失効 → 同 txHash 再提出が起きてもマーカーがまだ生きていて二重計上を防ぐ。
const PRO_REVENUE_RECORDED_TTL_SEC = 400 * 86_400;

export type ProRevenueEvent = {
  w: string; // wallet (lowercase)
  v: string; // priceWei (decimal 文字列)
  c: number; // chainId
  t: number; // 入金時刻 (unix ms)
  h: string; // txHash
};

// subscribe 成功時に **1 回だけ** 呼ぶ。失敗しても確定済みの加入を壊さない (try/catch・undercount=honest)。
export async function recordProRevenue(input: {
  wallet: Address;
  priceWei: bigint;
  chainId: number;
  txHash: string;
  paidAtMs: number;
}): Promise<void> {
  try {
    if (!isKvConfigured()) return;
    // txHash 単位の NX 冪等マーカーを LPUSH の前に立てる (feeRevenue と同方針・理由も同じ)。
    const markerKey = `pro:revenue:recorded:${input.chainId}:${input.txHash.toLowerCase()}`;
    const marker = await kvSet(markerKey, '1', {
      nx: true,
      ttlSec: PRO_REVENUE_RECORDED_TTL_SEC,
    });
    if (!marker.ok) {
      logger.warn('pro.revenue.marker_failed', { reason: marker.reason });
      return;
    }
    if (marker.value !== 'OK') {
      logger.info('pro.revenue.duplicate_skip', {
        chainId: input.chainId,
        txHash: input.txHash,
      });
      return;
    }
    const event: ProRevenueEvent = {
      w: input.wallet.toLowerCase(),
      v: input.priceWei.toString(),
      c: input.chainId,
      t: input.paidAtMs,
      h: input.txHash,
    };
    const r = await kvLpush(PRO_REVENUE_KEY, JSON.stringify(event));
    if (!r.ok) {
      logger.warn('pro.revenue.lpush_failed', { reason: r.reason });
      return;
    }
    if (r.value > MAX_PRO_REVENUE_EVENTS) {
      logger.warn('pro.revenue.capped', {
        length: r.value,
        cap: MAX_PRO_REVENUE_EVENTS,
      });
      await kvLtrim(PRO_REVENUE_KEY, 0, MAX_PRO_REVENUE_EVENTS - 1);
    }
  } catch (e) {
    logger.warn('pro.revenue.record_failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
