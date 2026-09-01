// @handle 店舗ページの `?cart=` 事前充填の純ロジック: 検証済み AgentCartItem[] (server で
// decodeAgentCart 済み) を店舗メニューと突合し、MobileOrderView の初期カート状態
// (数量ステッパ用 `qty` マップ + オプション行 `optionEntries`) を組み立てる。
//
// 設計 (plans/inbound-agent-order.md §2):
//   - **価格は menu 由来で再計算** — cart param は {id, qty, options} のみを運び金額を持たないため、
//     改ざんカートを渡されても価格・受取先は KV 権威の menu から確定される (M2/L2)。
//   - **グレースフル劣化 (L2)**: 未知 id / オプション不整合 / required 未選択は **該当行だけ drop** し、
//     解決できた行のみ反映する (全体を落とさない)。売り切れ/受付停止は MobileOrderView の既存
//     フィルタ (cartLines / accepting) が下流で担保するのでここでは扱わない。
//   - **strict なオプション解決は resolveStrictSelection に集約** (computeAgentOrder と単一情報源)。
//   - Buffer / KV / env に依存しない純関数 (= client component から import 可能・単体テスト可能)。
//     decode (Buffer 使用) は server 側の decodeAgentCart が済ませ、ここには検証済み配列だけが来る。

import type { AgentCartItem } from './agentOrder';
import type { MenuItem } from './mobileOrder';
import {
  resolveStrictSelection,
  effectiveUnitPrice,
  composeLineName,
  selectionKey,
} from './menuOptions';
import { CHECKOUT_QTY_MAX } from './url';

/** 事前充填で組み立てるオプション行 (MobileOrderView の OptionCartEntry と同形)。 */
export type PrefillOptionEntry = {
  key: string; // selectionKey (itemId#group:choice,...)
  itemId: string;
  name: string; // composeLineName 済 (選択をサフィックス化)
  price: string; // effectiveUnitPrice 済 (base + Σdelta)
  qty: number;
  taxRate?: number;
  taxCategory?: MenuItem['taxCategory'];
  /** 選択 (groupId/choiceId)。「前回と同じ注文」の保存で wire 形式に戻すために保持する。 */
  selections?: { groupId: string; choiceId: string }[];
};

export type PrefillCart = {
  /** オプション無し商品の初期数量 (menu item id → 数量)。 */
  qty: Record<string, number>;
  /** オプション有り商品の初期行。 */
  optionEntries: PrefillOptionEntry[];
};

/**
 * 検証済みカートと店舗メニューから MobileOrderView の初期カート状態を組み立てる。
 * `cart` 不在 (null/空) では空を返す = 事前充填なし (従来挙動と完全同一・構造的 inert)。
 *
 * @param menu 店舗メニュー (KV 権威・StorefrontParts.menu)
 * @param cart server で decodeAgentCart 済みの検証済みカート (null なら事前充填なし)
 * @param optionsEnabled env.enableMenuOptions。OFF ではオプションを無視し全て数量ステッパ扱い
 *   (MobileOrderView の hasOptions と同じ判定 = 描画と充填のズレを防ぐ)
 */
export function resolvePrefillCart(
  menu: MenuItem[],
  cart: AgentCartItem[] | null | undefined,
  optionsEnabled: boolean,
): PrefillCart {
  const empty: PrefillCart = { qty: {}, optionEntries: [] };
  if (!cart || cart.length === 0) return empty;

  const byId = new Map(menu.map((m) => [m.id, m]));
  const qty: Record<string, number> = {};
  const optionEntries: PrefillOptionEntry[] = [];
  const entryByKey = new Map<string, PrefillOptionEntry>();

  for (const line of cart) {
    const m = byId.get(line.id);
    if (!m) continue; // 未知 id → 該当行 drop

    // MobileOrderView.hasOptions と同一判定: flag OFF ではオプションを読まず数量ステッパ扱い。
    const groups = optionsEnabled ? (m.options ?? []) : [];
    const itemHasOptions = groups.length > 0;

    if (!itemHasOptions) {
      // 数量ステッパ商品。オプション機能 ON かつオプション指定があるのに menu 側に有効な group が
      // 無い = 不整合 → drop (base 価格への無音降格をしない・computeAgentOrder の strict と揃える)。
      // flag OFF ではオプション自体を無視するので指定があっても数量として反映する (描画と一致)。
      if (optionsEnabled && line.options && Object.keys(line.options).length > 0) continue;
      qty[m.id] = Math.min(CHECKOUT_QTY_MAX, (qty[m.id] ?? 0) + line.qty);
      continue;
    }

    // オプション有り商品: strict 解決 (未知 group/choice・required 未選択は drop)。
    const resolved = resolveStrictSelection(groups, line.options);
    if (!resolved.ok) continue; // オプション不整合 / required 未選択 → 該当行 drop

    const key = selectionKey(m.id, resolved.selections);
    const existing = entryByKey.get(key);
    if (existing) {
      existing.qty = Math.min(CHECKOUT_QTY_MAX, existing.qty + line.qty);
      continue;
    }
    const entry: PrefillOptionEntry = {
      key,
      itemId: m.id,
      name: composeLineName(m.name, resolved.choices),
      price: effectiveUnitPrice(m.price, resolved.choices),
      qty: Math.min(CHECKOUT_QTY_MAX, line.qty),
      taxRate: m.taxRate,
      taxCategory: m.taxCategory,
      selections: resolved.selections,
    };
    entryByKey.set(key, entry);
    optionEntries.push(entry);
  }

  return { qty, optionEntries };
}
