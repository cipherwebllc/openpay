import 'server-only';

// 表示専用の per-商品 購入数カウンタ (Brain 裁定 2026-08-08・plans/improve-loop.md)。
// 決済の真実は purchaseIntent/ownership/オンチェーンであり、本カウンタは
// 「人気順ソート・social proof 表示」のためのヒントに過ぎない。
// - 計上点は finalizeHostedPurchase の kind==='finalized' (初回確定) のみ —
//   idempotent 再送・heal の再実行では増えない (呼び出し側の責務・route が判定)
// - no-throw: カウンタの記録失敗を購入本体 (content 解錠応答) へ波及させない (掟 13)
// - 表示は別フェーズ (閾値 3+ でのみ表示する裁定)。いまは記録のみ (読み出しは scripts の集計)

import { kvIncr } from '@/lib/kv';
import { logger } from '@/lib/logger';

export function hostedPurchaseCountKey(resourceId: string): string {
  return `store:purchases:${resourceId}`;
}

/** 購入確定 1 件を計上する。失敗しても throw しない (付帯処理の隔離)。 */
export async function recordHostedPurchase(resourceId: string): Promise<void> {
  try {
    const result = await kvIncr(hostedPurchaseCountKey(resourceId));
    if (!result.ok) {
      logger.warn('store.purchase-count.record-failed', { resourceId });
    }
  } catch {
    logger.warn('store.purchase-count.record-failed', { resourceId });
  }
}
