// エージェント注文 (agent-order) の純ロジック: カート codec (URL param ⇄ [{id,qty}]) と、
// @handle 店舗の storefront メニューから注文を **サーバー権威で組み立てる** computeAgentOrder。
//
// 設計 (plans/agent-order-x402.md):
//   - カートは `cart` query param = base64url(JSON `[{id, qty}]`)。**untrusted** ゆえ decode は
//     全項目を検証し不正は null (呼出側が 422 に倒す)。上限は受注リレーと共有 (ORDER_ITEMS_MAX /
//     ORDER_ITEM_QTY_MAX)。
//   - computeAgentOrder は menu の id 突合で価格を確定する (顧客申告額を信じない)。未知 id は
//     `unknown_item`。options は checkout と同一関数 (lib/menuOptions) で解決 — required 未指定は
//     `missing_required_option`、実在しない group/choice は `unknown_option` (strict・黙殺しない)。
//   - 合計は declaredItemsTotalMinor (受注リレーと同一の minor-unit 変換) を再利用する — x402 の
//     amount / 受注保存の突合と同じ算術に揃える (単一情報源)。
//   - viem / KV / env には依存しない (= 単体テスト可能・純関数)。

import {
  declaredItemsTotalMinor,
  ORDER_ITEMS_MAX,
  ORDER_ITEM_QTY_MAX,
  type StoredOrderItem,
} from './orderRelay';
import type { StorefrontParts } from './mobileOrder';
import {
  resolveSelection,
  effectiveUnitPrice,
  composeLineName,
  type OptionSelection,
} from './menuOptions';

const CART_ID_MAX = 64; // menu item id の上限 (mobileOrder.validMenuItem と同じ)
const SUMMARY_MAX = 200; // description に載せる品目要約の上限

/** カート 1 行 (menu item id + 数量 + 任意のオプション選択)。untrusted → decodeAgentCart が検証する。
 *  options は groupId → choiceId (single) | choiceId[] (multi) — UI の OptionSelection と同形。 */
export type AgentCartItem = {
  id: string;
  qty: number;
  options?: OptionSelection;
};

export type AgentOrderError =
  | 'empty_cart'
  | 'unknown_item'
  | 'unknown_option'
  | 'missing_required_option'
  | 'bad_total';

export type AgentOrderResult =
  | {
      ok: true;
      items: StoredOrderItem[]; // server 検証済み (name/qty/price は menu 由来)
      totalMinor: bigint; // 合計 (token minor units・decimals 引数由来)
      summary: string; // description 用の品目要約 (例 "唐揚げ×2, ビール×1")
    }
  | { ok: false; reason: AgentOrderError };

// ── base64url(utf8(JSON)) codec (Node/Next server runtime・MCP は自前で同形に組む) ──
function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  // Buffer は不正 base64 を throw せず best-effort でデコードするため、round-trip では
  // 検証しない (中身の JSON/型検証で弾く)。空文字は空 JSON にならず後段の parse で落ちる。
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * `cart` query param → AgentCartItem[]。untrusted 入力ゆえ全項目を検証し、一つでも不正なら
 * **null** を返す (例外は投げない)。件数は 1..ORDER_ITEMS_MAX、qty は 1..ORDER_ITEM_QTY_MAX の整数、
 * id は非空文字 (≤ CART_ID_MAX)。
 */
export function decodeAgentCart(param: string): AgentCartItem[] | null {
  if (typeof param !== 'string' || param.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(param));
  } catch {
    return null; // 不正な base64 / JSON
  }
  if (!Array.isArray(raw)) return null;
  if (raw.length < 1 || raw.length > ORDER_ITEMS_MAX) return null;
  const out: AgentCartItem[] = [];
  for (const it of raw) {
    if (typeof it !== 'object' || it === null) return null;
    const o = it as Record<string, unknown>;
    if (typeof o.id !== 'string') return null;
    const id = o.id.trim();
    if (id.length === 0 || id.length > CART_ID_MAX) return null;
    if (typeof o.qty !== 'number' || !Number.isInteger(o.qty)) return null;
    if (o.qty < 1 || o.qty > ORDER_ITEM_QTY_MAX) return null;
    // options (任意): groupId → choiceId | choiceId[]。形だけここで検証し、menu との突合
    // (グループ/choice の実在・required) は computeAgentOrder が行う。
    let options: OptionSelection | undefined;
    if (o.options !== undefined) {
      if (typeof o.options !== 'object' || o.options === null || Array.isArray(o.options)) {
        return null;
      }
      const sel: OptionSelection = {};
      const entries = Object.entries(o.options as Record<string, unknown>);
      if (entries.length > 16) return null; // OPTION_GROUPS_MAX (6) を大きく超える入力は不正
      for (const [gid, v] of entries) {
        if (gid.length === 0 || gid.length > CART_ID_MAX) return null;
        if (typeof v === 'string') {
          if (v.length === 0 || v.length > CART_ID_MAX) return null;
          sel[gid] = v;
        } else if (Array.isArray(v)) {
          if (v.length > 32) return null;
          const arr: string[] = [];
          for (const c of v) {
            if (typeof c !== 'string' || c.length === 0 || c.length > CART_ID_MAX) return null;
            arr.push(c);
          }
          sel[gid] = arr;
        } else {
          return null;
        }
      }
      options = sel;
    }
    out.push({ id, qty: o.qty, ...(options ? { options } : {}) });
  }
  return out;
}

/** AgentCartItem[] → `cart` query param (base64url(JSON))。MCP と server が同形を組むための単一情報源。 */
export function encodeAgentCart(items: AgentCartItem[]): string {
  const json = JSON.stringify(
    items.map((i) => ({
      id: i.id,
      qty: i.qty,
      ...(i.options ? { options: i.options } : {}),
    })),
  );
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function truncateSummary(s: string): string {
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

/**
 * storefront メニューとカートから **サーバー権威の注文** を組み立てる。menu の id で単価を確定し
 * (顧客申告額は使わない)、合計 (minor units) と保存用 StoredOrderItem[] を返す。decimals は
 * deployment 由来 (route が resolveDeployment(...).decimals を渡す)。
 *   - 空カート → `empty_cart`
 *   - 未知 id → `unknown_item`
 *   - options: resolveSelection で required 検証 → effectiveUnitPrice / composeLineName で
 *     実効単価と表示名を確定 (checkout・受注・レシートと同一算術/書式)
 *   - minor-unit 変換不能 → `bad_total` (通常不到達・price は menu 検証済みの正 decimal)
 */
export function computeAgentOrder(
  storefront: StorefrontParts,
  cartItems: AgentCartItem[],
  decimals: number,
): AgentOrderResult {
  if (cartItems.length === 0) return { ok: false, reason: 'empty_cart' };

  const byId = new Map(storefront.menu.map((m) => [m.id, m]));
  const items: StoredOrderItem[] = [];
  const summaryParts: string[] = [];
  for (const cart of cartItems) {
    const menuItem = byId.get(cart.id);
    if (!menuItem) return { ok: false, reason: 'unknown_item' };
    const groups = menuItem.options ?? [];
    // エージェント API は **strict**: 存在しない group/choice id は黙殺せずエラーにする
    // (resolveSelection は UI 向けに不正 id を無視するが、無視すると「トッピングを頼んだつもりで
    // 実は付かず安く払う」不一致が起きる。支払う側が機械なので明示的に弾く)。
    const sel = cart.options ?? {};
    for (const [gid, v] of Object.entries(sel)) {
      const group = groups.find((g) => g.id === gid);
      if (!group) return { ok: false, reason: 'unknown_option' };
      const chosen = typeof v === 'string' ? [v] : v;
      for (const cid of chosen) {
        if (!group.choices.some((c) => c.id === cid)) {
          return { ok: false, reason: 'unknown_option' };
        }
      }
      if (group.type === 'single' && Array.isArray(v) && v.length > 1) {
        return { ok: false, reason: 'unknown_option' }; // single に複数指定
      }
      // single グループに配列 1 件は string へ正規化 (resolveSelection は single=string を期待)
      if (group.type === 'single' && Array.isArray(v)) sel[gid] = v[0];
    }
    // required 検証 + 定義順の choice 解決 (checkout UI と同一関数 = 単一情報源)
    const resolved = resolveSelection(groups, sel);
    if (!resolved.ok) return { ok: false, reason: 'missing_required_option' };
    // 実効単価 = base + Σdelta・表示名 = 「name（選択・選択）」— checkout / 受注 / レシートと同形
    const price = effectiveUnitPrice(menuItem.price, resolved.choices);
    const name = composeLineName(menuItem.name, resolved.choices);
    items.push({ name, qty: cart.qty, price });
    summaryParts.push(`${name}×${cart.qty}`);
  }

  const totalMinor = declaredItemsTotalMinor(items, decimals);
  if (totalMinor === null || totalMinor <= 0n) {
    return { ok: false, reason: 'bad_total' };
  }

  return {
    ok: true,
    items,
    totalMinor,
    summary: truncateSummary(summaryParts.join(', ')),
  };
}
