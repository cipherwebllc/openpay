// モバイル注文「受注リレー」の純ロジック (型・KV キー・直列化・入力サニタイズ・定数)。
// on-chain 検証 (verifyJpycTransferToOnChain) と KV I/O・SIWE は route 側 (app/api/order/*) の責務。
// flag NEXT_PUBLIC_ENABLE_ORDER_RELAY 既定 OFF で全経路 inert。
//
// 設計の核 (plans/swift-puzzling-sky.md):
//   - 受注は **advisory**: 金額のみオンチェーンで真正 (実着金を権威保存)・商品/テーブルは顧客申告。
//   - 冪等は **txHash のみ** (1 決済 1 注文)。
//   - 注文メタは TTL 72h・上限 200 件・資金は不触 (ノンカストディ不変)・顧客 PII は保存しない。

export const ORDER_LIST_TTL_SEC = 72 * 60 * 60; // 受注リストの寿命 (72h)
export const ORDER_USED_TTL_SEC = 72 * 60 * 60; // txHash 冪等鍵の寿命 (リストと同期)
export const ORDER_LIST_MAX = 200; // 1 merchant あたり保持上限 (kvLtrim)
// 最低着金フロア = 1 JPYC (decimals 18)。dust/誤検出を弾く最小値。**権威額は実着金合計**で、
// minValue はあくまで「正の着金があったか」のフロア (申告額には依存しない・advisory 原則)。
export const ORDER_DUST_FLOOR_WEI = 1_000_000_000_000_000_000n;
export const ORDER_ITEMS_MAX = 20; // 申告明細の件数上限
export const ORDER_ITEM_NAME_MAX = 80;
export const ORDER_TABLE_MAX = 64; // テーブル番号ラベル (checkout description 由来) の上限
export const ORDER_ID_MAX = 64;

export type StoredOrderItem = { name: string; qty: number; price: string };

export type StoredOrder = {
  orderId: string;
  items: StoredOrderItem[]; // 顧客申告 (表示用・突合は店主)
  table: string | null; // 顧客申告: テーブル番号ラベル (description 由来)。テイクアウトは null。
  amount: string; // **実着金 (オンチェーン検証済み・権威)** — JPYC minor units 文字列
  txHash: string;
  chainId: number;
  from: string; // 支払元 (オンチェーン公開情報)
  ts: number; // 受信時刻 (ms)
  fulfilled: boolean; // 「対応済み」フラグ。削除でなくフラグ化し誤操作を復旧可能に (未対応に戻せる)。
};

/** 店主 (受取アドレス) ごとの受注リスト KV キー。受取アドレスでスコープ (read は受取ウォレット SIWE)。 */
export function orderListKey(merchant: string): string {
  return `order:list:${merchant.toLowerCase()}`;
}

/** txHash 冪等鍵 (1 決済 1 注文)。merchant や items は鍵に含めない。 */
export function orderUsedKey(chainId: number, txHash: string): string {
  return `order:used:${chainId}:${txHash.toLowerCase()}`;
}

const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;
const DECIMAL_INT = /^\d+$/;

export function isTxHashLike(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v);
}

/**
 * 申告明細をサニタイズ (webhook payload は顧客側で改ざん可能 → 表示用に最小整形・上限 clamp)。
 * 名前必須・正の整数 qty 必須・price は正の十進文字列のみ (不正は空文字)。件数は ORDER_ITEMS_MAX で打切。
 */
export function sanitizeOrderItems(raw: unknown): StoredOrderItem[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredOrderItem[] = [];
  for (const it of raw) {
    if (out.length >= ORDER_ITEMS_MAX) break;
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, ORDER_ITEM_NAME_MAX) : '';
    if (!name) continue;
    const qtyNum = typeof o.qty === 'number' ? o.qty : Number(o.qty);
    const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.floor(qtyNum) : 0;
    if (qty <= 0) continue;
    const price =
      typeof o.price === 'string' && POSITIVE_DECIMAL.test(o.price) ? o.price : '';
    out.push({ name, qty, price });
  }
  return out;
}

/** テーブル番号ラベル (checkout description) のサニタイズ。空/非文字列は null。 */
export function sanitizeTable(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().slice(0, ORDER_TABLE_MAX);
  return t.length > 0 ? t : null;
}

export function serializeOrder(o: StoredOrder): string {
  return JSON.stringify(o);
}

/** KV から読んだ生文字列 → StoredOrder (不正は null)。read 時も検証 (KV は untrusted 扱い)。 */
export function parseStoredOrder(raw: string): StoredOrder | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.orderId !== 'string' || o.orderId.length === 0) return null;
  if (typeof o.amount !== 'string' || !DECIMAL_INT.test(o.amount)) return null;
  if (!isTxHashLike(o.txHash)) return null;
  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId)) return null;
  return {
    orderId: o.orderId.slice(0, ORDER_ID_MAX),
    items: sanitizeOrderItems(o.items),
    table: sanitizeTable(o.table),
    amount: o.amount,
    txHash: o.txHash,
    chainId: o.chainId,
    from: typeof o.from === 'string' ? o.from : '',
    ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : 0,
    fulfilled: o.fulfilled === true,
  };
}
