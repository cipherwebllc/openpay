import 'server-only';

// 表示専用の per-商品 購入数カウンタ (Brain 裁定 2026-08-08・plans/improve-loop.md)。
// 決済の真実は purchaseIntent/ownership/オンチェーンであり、本カウンタは
// 「人気順ソート・social proof 表示」のためのヒントに過ぎない。
// - 計上点は finalizeHostedPurchase の kind==='finalized' (初回確定) のみ —
//   idempotent 再送・heal の再実行では増えない (呼び出し側の責務・route が判定)
// - no-throw: カウンタの記録失敗を購入本体 (content 解錠応答) へ波及させない (掟 13)
// - 表示は別フェーズ (閾値 3+ でのみ表示する裁定)。本 PR は記録のみ

import { kvIncr, kvMget } from '@/lib/kv';
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

/**
 * 複数商品の購入数をまとめて読む (将来の人気順/カード表示用)。
 * KV 障害・欠落キーは 0 として返す — カウンタはヒントであり、読めないことで
 * 一覧表示を止めない。
 */
export async function readHostedPurchaseCounts(
  resourceIds: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const id of resourceIds) counts[id] = 0;
  if (resourceIds.length === 0) return counts;
  try {
    const read = await kvMget(
      resourceIds.map((id) => hostedPurchaseCountKey(id)),
    );
    if (!read.ok || !Array.isArray(read.value)) return counts;
    resourceIds.forEach((id, index) => {
      const raw = read.value?.[index];
      const parsed =
        typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
      if (Number.isSafeInteger(parsed) && parsed >= 0) counts[id] = parsed;
    });
  } catch {
    // ヒント読み取りの失敗は 0 のまま返す (一覧本体を止めない)。
  }
  return counts;
}
