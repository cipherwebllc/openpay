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

export type StoredOrderItem = {
  name: string;
  qty: number;
  price: string;
  // 受注フルフィルメント (Phase 3・flag ENABLE_ORDER_FULFILLMENT)。商品別の進捗。保存時は常に未設定
  // (false 相当)、店主操作でのみ true 化。配列 index が安定キー (ops は index で対象を指定する)。
  cooked?: boolean; // 調理済み (キッチン)
  served?: boolean; // 配膳済み (ホール)
};

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
  // 受取予定時刻 (ms・Phase 4・preorder で顧客が選んだスロット)。未指定=即時/店頭。表示用 (advisory)。
  pickupAt?: number;
  // 厨房モニターの **中間「調理済み」フラグ** (店主操作・調理が終わった合図)。fulfilled (対応済み) とは
  // 独立 = 調理済みにしてもオーダーは未対応のまま (ホールが配膳=対応済みにするまで残る)。厨房ボードは
  // これで active/done を分け done は折りたたみへ。保存時は true のときだけ持つ。
  // ※ ホールの「配膳済み」は別フラグを持たず **fulfilled (対応済み) そのもの** (配膳済み=対応済み)。
  kitchenDone?: boolean;
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
export function sanitizeOrderItems(
  raw: unknown,
  opts: { preserveStatus?: boolean } = {},
): StoredOrderItem[] {
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
    const item: StoredOrderItem = { name, qty, price };
    // 進捗フラグ (cooked/served) は **保存データ (parseStoredOrder) からのみ** 復元する。webhook
    // (顧客申告) からは受け取らない = 顧客が調理済み/配膳済みを偽装注入できない。
    if (opts.preserveStatus) {
      if (o.cooked === true) item.cooked = true;
      if (o.served === true) item.served = true;
    }
    out.push(item);
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
  const order: StoredOrder = {
    orderId: o.orderId.slice(0, ORDER_ID_MAX),
    items: sanitizeOrderItems(o.items, { preserveStatus: true }),
    table: sanitizeTable(o.table),
    amount: o.amount,
    txHash: o.txHash,
    chainId: o.chainId,
    from: typeof o.from === 'string' ? o.from : '',
    ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : 0,
    fulfilled: o.fulfilled === true,
  };
  // 受取予定時刻 (任意・正の有限数のみ・preorder)。不正は黙って除外 (旧データは未設定=即時)。
  if (typeof o.pickupAt === 'number' && Number.isFinite(o.pickupAt) && o.pickupAt > 0) {
    order.pickupAt = o.pickupAt;
  }
  // 厨房の調理済み (true のときだけ保持・旧データは未設定=未完了)。
  if (o.kitchenDone === true) order.kitchenDone = true;
  return order;
}

// ── 受注フィードの状態更新オペレーション (Phase 3・/api/order/feed POST)。txHash で対象注文を
//    指定し、op で何を変えるかを表す。旧 { txHash, fulfilled } も受理 (後方互換)。 ──
export type OrderFeedOp =
  | { kind: 'fulfill'; value: boolean } // 注文「対応済み」(削除でなくフラグ)
  | { kind: 'itemCooked'; index: number; value: boolean } // 商品別「調理済み」(キッチン)
  | { kind: 'itemServed'; index: number; value: boolean } // 商品別「配膳済み」(ホール)
  | { kind: 'kitchenDone'; value: boolean } // 注文単位「調理済み」(厨房モニター・中間・折りたたみへ)
  | { kind: 'setTable'; table: string | null }; // テーブル訂正
// ※ ホールの「配膳済み」は専用 op を持たず fulfill (対応済み) を使う (配膳済み=対応済み)。

function isItemIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < ORDER_ITEMS_MAX;
}

/** untrusted な POST body → { txHash, op } | null。新 {op:...} と旧 {fulfilled} の両方を受理。 */
export function parseOrderFeedOp(body: unknown): { txHash: string; op: OrderFeedOp } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!isTxHashLike(b.txHash)) return null;
  const txHash = b.txHash;
  const raw = b.op;
  // 旧 schema: { txHash, fulfilled? } (op 無し) → fulfill op (既定 true)。
  if (raw === undefined) {
    return { txHash, op: { kind: 'fulfill', value: b.fulfilled !== false } };
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  switch (o.kind) {
    case 'fulfill':
      return typeof o.value === 'boolean'
        ? { txHash, op: { kind: 'fulfill', value: o.value } }
        : null;
    case 'itemCooked':
      return isItemIndex(o.index) && typeof o.value === 'boolean'
        ? { txHash, op: { kind: 'itemCooked', index: o.index, value: o.value } }
        : null;
    case 'itemServed':
      return isItemIndex(o.index) && typeof o.value === 'boolean'
        ? { txHash, op: { kind: 'itemServed', index: o.index, value: o.value } }
        : null;
    case 'kitchenDone':
      return typeof o.value === 'boolean'
        ? { txHash, op: { kind: 'kitchenDone', value: o.value } }
        : null;
    case 'setTable':
      // table は **明示的に string か null のみ** 受理 (未指定/数値等の誤入力で既存テーブルを
      // 黙ってクリアしない)。null は意図的なクリア (テイクアウト化)。
      if (o.table !== null && typeof o.table !== 'string') return null;
      return { txHash, op: { kind: 'setTable', table: sanitizeTable(o.table) } };
    default:
      return null;
  }
}

/** op を純粋適用した新しい StoredOrder を返す (元は不変・変化が無ければ同等値)。 */
export function applyOrderOp(order: StoredOrder, op: OrderFeedOp): StoredOrder {
  switch (op.kind) {
    case 'fulfill':
      return { ...order, fulfilled: op.value };
    case 'kitchenDone':
      return { ...order, kitchenDone: op.value };
    case 'setTable':
      return { ...order, table: op.table };
    case 'itemCooked':
    case 'itemServed': {
      if (op.index >= order.items.length) return order; // 範囲外は no-op
      const items = order.items.map((it, i) =>
        i !== op.index
          ? it
          : op.kind === 'itemCooked'
            ? { ...it, cooked: op.value }
            : { ...it, served: op.value },
      );
      return { ...order, items };
    }
  }
}
