// モバイル注文「前回と同じ注文」の localStorage レコード (改善提案 #3・2026-09-01)。
//
// 顧客が「支払いへ進む」を押した時点 (= /checkout へのハンドオフ) で、その店舗の id ベースの
// カート (AgentCartItem[] = 価格を持たない wire 形式) を店舗ごとに 1 件保存する。次回同じ店舗の
// 注文ページを開いたとき、**その注文が実際に支払われた** (顧客の電子レシートに同店舗・保存以降の
// confirmed 控えがある) 場合にだけ「前回と同じ注文」ボタンを出し、resolvePrefillCart で現在の
// メニューに突合して復元する (価格は menu 権威で再計算・無くなった商品は落とす)。
//
// money-path ではない (送信しない・価格を持たない)。アカウント登録を要求しない原則に沿い、
// 端末内 (localStorage) にだけ残る。永続化は hooks/useLocalStorageRecord (fail-safe load)。

import type { AgentCartItem } from '@/lib/agentOrder';
import type { OptionSelection } from '@/lib/menuOptions';
import type { PayerReceipt } from '@/lib/payerReceipt';

export const LAST_ORDER_KEY_PREFIX = 'openpay:last-order:v1:';

export type LastOrderRecord = {
  /** 受取先 (config.receiver・小文字)。控えとの突合キー。 */
  receiver: string;
  /** id ベースのカート (価格なし・復元時に menu と突合)。 */
  cart: AgentCartItem[];
  /** ハンドオフ時刻 (Date.now())。これ以降の confirmed 控えを「支払われた」と見なす。 */
  ts: number;
};

/** 店舗キー: @handle があれば handle、self-contained (?s=) は受取先アドレス。 */
export function lastOrderShopKey(handle: string | undefined, receiver: string): string {
  return handle ? `h:${handle}` : `addr:${receiver.toLowerCase()}`;
}

export function lastOrderStorageKey(handle: string | undefined, receiver: string): string {
  return `${LAST_ORDER_KEY_PREFIX}${lastOrderShopKey(handle, receiver)}`;
}

function isCartItem(o: unknown): o is AgentCartItem {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return false;
  if (typeof r.qty !== 'number' || !Number.isInteger(r.qty) || r.qty <= 0) return false;
  if (r.options !== undefined) {
    if (typeof r.options !== 'object' || r.options === null) return false;
    for (const v of Object.values(r.options as Record<string, unknown>)) {
      if (typeof v === 'string') continue;
      if (Array.isArray(v) && v.every((c) => typeof c === 'string')) continue;
      return false;
    }
  }
  return true;
}

export function isLastOrderRecord(o: unknown): o is LastOrderRecord {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  if (typeof r.receiver !== 'string' || r.receiver.length === 0) return false;
  if (!Array.isArray(r.cart) || r.cart.length === 0 || !r.cart.every(isCartItem)) return false;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts <= 0) return false;
  return true;
}

/** UI の選択 (groupId/choiceId の列) → wire 形式 (groupId → choiceId | choiceId[])。 */
export function selectionsToOptionSelection(
  selections: ReadonlyArray<{ groupId: string; choiceId: string }>,
): OptionSelection | undefined {
  if (selections.length === 0) return undefined;
  const out: Record<string, string[]> = {};
  for (const s of selections) (out[s.groupId] ??= []).push(s.choiceId);
  const sel: OptionSelection = {};
  for (const [gid, ids] of Object.entries(out)) sel[gid] = ids.length === 1 ? ids[0] : ids;
  return sel;
}

/**
 * 現在のカート状態 → 保存用 id カート。オプション行は selections から wire 形式に戻す
 * (selections を持たない行 = 復元不能なので保存しない)。
 */
export function cartFromState(
  qty: Readonly<Record<string, number>>,
  optionEntries: ReadonlyArray<{
    itemId: string;
    qty: number;
    selections?: ReadonlyArray<{ groupId: string; choiceId: string }>;
  }>,
): AgentCartItem[] {
  const cart: AgentCartItem[] = [];
  for (const [id, n] of Object.entries(qty)) {
    if (n > 0) cart.push({ id, qty: n });
  }
  for (const e of optionEntries) {
    if (e.qty <= 0 || !e.selections) continue;
    const options = selectionsToOptionSelection(e.selections);
    cart.push(options ? { id: e.itemId, qty: e.qty, options } : { id: e.itemId, qty: e.qty });
  }
  return cart;
}

/**
 * 保存した注文が実際に支払われたか: 同じ受取先へ、ハンドオフ以降 (時計ずれ許容) の confirmed
 * 控えがある。pending (未確定) は数えない — 「前回の注文」= 完了した注文だけを指す。
 */
const HANDOFF_SKEW_MS = 5 * 60 * 1000;

export function lastOrderPaid(record: LastOrderRecord, receipts: readonly PayerReceipt[]): boolean {
  const receiver = record.receiver.toLowerCase();
  const since = record.ts - HANDOFF_SKEW_MS;
  return receipts.some((r) => {
    if (r.status !== 'confirmed') return false;
    if (r.merchantAddress.toLowerCase() !== receiver) return false;
    const at = Date.parse(r.paidAt ?? r.createdAt);
    return Number.isFinite(at) && at >= since;
  });
}
