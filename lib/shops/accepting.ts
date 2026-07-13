import type { ShopLiveState } from '@/lib/shopLive';
import { isBeforeOpen, isPastLastOrder, pickupSlots } from '@/lib/shopTime';
import type { AcceptingNow, ShopSummary } from '@/lib/shops/query';

export type AcceptingNowInput = {
  summary: ShopSummary;
  live: ShopLiveState | null;
  nowMs: number;
  enablePreorderTime: boolean;
  hasConfiguredForwarder: boolean | null;
};

/**
 * Shops API の受付可否を三値で返す純関数。確実な停止条件は false、全条件を確認できれば true、
 * PR-1 既存 summary / live 障害など情報不足は null として、誤って「受付中」にしない。
 */
export function acceptingNow({
  summary,
  live,
  nowMs,
  enablePreorderTime,
  hasConfiguredForwarder,
}: AcceptingNowInput): AcceptingNow {
  if (summary.acceptingOrders === false) return false;
  if (hasConfiguredForwarder === false) return false;
  if (
    enablePreorderTime &&
    (isBeforeOpen(nowMs, summary.openFrom) ||
      isPastLastOrder(nowMs, summary.lastOrder))
  ) {
    return false;
  }
  if (
    enablePreorderTime &&
    summary.mode === 'preorder' &&
    pickupSlots(nowMs, summary.minLeadMinutes, summary.lastOrder).length === 0
  ) {
    return false;
  }
  if (live?.paused === true) return false;

  if (live !== null && live.soldOut.length > 0) {
    const itemIds = summary.menu.itemIds;
    if (!itemIds) {
      // soldOut 数が商品数未満なら全品ではないと確定できる。以上なら旧 summary では照合不能。
      if (live.soldOut.length >= summary.menu.itemCount) return null;
    } else {
      const soldOut = new Set(live.soldOut);
      if (itemIds.every((itemId) => soldOut.has(itemId))) return false;
    }
  }

  if (
    summary.acceptingOrders === undefined ||
    live === null ||
    hasConfiguredForwarder === null
  ) {
    return null;
  }
  return true;
}
