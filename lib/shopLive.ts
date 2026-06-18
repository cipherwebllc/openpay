// 店舗のライブ運用状態 (売り切れ / 受付一時停止) の純ロジック (型・KV キー・検証・パッチ適用)。
// KV I/O・SIWE・所有者照合は route 側 (app/api/shop/live) の責務。
//
// 設計 (plans/restaurant-pos-roadmap.md §3-A):
//   - @handle ストアの静的 storefront (StorefrontParts) は publish 時にしか書かれない。
//     売り切れ / 受付一時停止は営業中に高頻度トグルするため、**別の小さな live レコード**に持つ。
//   - 顧客の @handle 公開ページがサーバ側で読み取り、MobileOrderView へ渡して enforcement する。
//     enforcement は **advisory** (on-chain 決済自体は permissionless ゆえ完全には止められないが、
//     UI で売り切れ品を非活性化・受付停止中は決済導線を抑止する。現 acceptingOrders と同じ割り切り)。
//   - KV キーは @handle slug でスコープ (顧客ページが @handle スコープのため・受取ウォレットではない)。
// flag NEXT_PUBLIC_ENABLE_SHOP_LIVE 既定 OFF で全経路 inert。

export const SHOP_LIVE_SOLD_OUT_MAX = 200; // 売り切れ品 id の保持上限 (menu 上限 60 に十分な余裕)
const ITEM_ID_MAX = 64; // MenuItem.id の上限 (mobileOrder.validMenuItem と同じ)

export type ShopLiveState = {
  soldOut: string[]; // 売り切れ中の MenuItem.id 配列 (重複なし・出現順)
  paused: boolean; // 受付一時停止 (true のとき storefront.acceptingOrders より優先して停止)
  updatedAt: number; // 最終更新時刻 (ms)。CAS とは独立の表示用メタ。
};

export const EMPTY_SHOP_LIVE: ShopLiveState = { soldOut: [], paused: false, updatedAt: 0 };

/** @handle slug (正規化済み・@ 無し) ごとのライブ状態 KV キー。小文字に正規化。 */
export function shopLiveKey(handle: string): string {
  return `shop:live:${handle.toLowerCase()}`;
}

/** 売り切れ id 配列をサニタイズ (KV/入力は untrusted)。非文字列/空/超過長/重複を除外し上限で打切。 */
export function sanitizeSoldOut(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (out.length >= SHOP_LIVE_SOLD_OUT_MAX) break;
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t.length === 0 || t.length > ITEM_ID_MAX) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function serializeShopLive(s: ShopLiveState): string {
  return JSON.stringify({ soldOut: s.soldOut, paused: s.paused, updatedAt: s.updatedAt });
}

/** KV/未存在から読んだ生値 → ShopLiveState。未存在/不正は EMPTY (read 時も untrusted 扱い)。 */
export function parseShopLive(raw: string | null | undefined): ShopLiveState {
  if (typeof raw !== 'string') return { ...EMPTY_SHOP_LIVE };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ...EMPTY_SHOP_LIVE };
  }
  if (typeof v !== 'object' || v === null) return { ...EMPTY_SHOP_LIVE };
  const o = v as Record<string, unknown>;
  return {
    soldOut: sanitizeSoldOut(o.soldOut),
    paused: o.paused === true,
    updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
  };
}

// 店主が送るライブ状態の操作 (PATCH body)。単一操作ずつ (UI のトグル 1 回 = 1 PATCH)。
export type ShopLivePatch =
  | { op: 'soldOut'; itemId: string; value: boolean } // 商品を売り切れ/再開
  | { op: 'paused'; value: boolean } // 受付を停止/再開
  | { op: 'clearSoldOut' }; // 売り切れを全解除 (営業開始時のリセット)

/** untrusted な PATCH body → ShopLivePatch | null (不正は null)。route と test の単一情報源。 */
export function parseShopLivePatch(raw: unknown): ShopLivePatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.op === 'soldOut') {
    if (typeof o.itemId !== 'string') return null;
    const itemId = o.itemId.trim();
    if (itemId.length === 0 || itemId.length > ITEM_ID_MAX) return null;
    if (typeof o.value !== 'boolean') return null;
    return { op: 'soldOut', itemId, value: o.value };
  }
  if (o.op === 'paused') {
    if (typeof o.value !== 'boolean') return null;
    return { op: 'paused', value: o.value };
  }
  if (o.op === 'clearSoldOut') return { op: 'clearSoldOut' };
  return null;
}

/** パッチを純粋適用 (read-modify-write の modify 部分・route が CAS で書き戻す)。 */
export function applyShopLivePatch(
  state: ShopLiveState,
  patch: ShopLivePatch,
  nowMs: number,
): ShopLiveState {
  switch (patch.op) {
    case 'soldOut': {
      const has = state.soldOut.includes(patch.itemId);
      let soldOut = state.soldOut;
      if (patch.value && !has) {
        // 上限超過時は最古を落として新規を必ず残す (slice(-MAX))。実際には menu 上限 60 ≪ 200 で
        // 未到達だが、メニュー改訂で古い id が滞留しても「売り切れ指定が黙って失われる」のを防ぐ。
        soldOut = [...state.soldOut, patch.itemId].slice(-SHOP_LIVE_SOLD_OUT_MAX);
      } else if (!patch.value && has) {
        soldOut = state.soldOut.filter((x) => x !== patch.itemId);
      }
      return { soldOut, paused: state.paused, updatedAt: nowMs };
    }
    case 'paused':
      return { soldOut: state.soldOut, paused: patch.value, updatedAt: nowMs };
    case 'clearSoldOut':
      return { soldOut: [], paused: state.paused, updatedAt: nowMs };
  }
}
