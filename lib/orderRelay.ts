// モバイル注文「受注リレー」の純ロジック (型・KV キー・直列化・入力サニタイズ・定数)。
// on-chain 検証 (verifyJpycTransferToOnChain) と KV I/O・SIWE は route 側 (app/api/order/*) の責務。
// flag NEXT_PUBLIC_ENABLE_ORDER_RELAY 既定 OFF で全経路 inert。
//
// 設計の核 (plans/swift-puzzling-sky.md):
//   - 受注は **advisory**: 金額のみオンチェーンで真正 (実着金を権威保存)・商品/テーブルは顧客申告。
//   - 冪等は **txHash のみ** (1 決済 1 注文)。
//   - 注文メタは TTL 72h・上限 200 件・資金は不触 (ノンカストディ不変)・顧客 PII は保存しない。

export const ORDER_LIST_TTL_SEC = 72 * 60 * 60; // 受注リストの寿命 (72h・表示用 advisory)
// txHash 冪等マーカーの **二段ロック** (P1-E/P1-F)。表示リスト (ORDER_LIST_TTL_SEC=72h) とは
// 寿命を完全に分離する:
//   - pending = 検証中の **短命クレーム** (ORDER_PENDING_TTL_SEC で自然失効)。maxDuration タイムアウトで
//     done 昇格前にプロセスが強制終了しても pending は自動失効する = 正規注文が最大 72h ロックされ消失する
//     事故 (P1-F) を断ち、短時間後の同一 txHash 再 POST で復旧できる。
//   - done = 検証 + 保存が完了した **恒久ブロック** (TTL 無し)。同一 txHash の **無期限リプレイを永久拒否** し
//     「1 決済 1 注文」を恒久保証する (P1-E)。72h 失効で過去着金 tx を再送する偽注文流入を塞ぐ。
// 昇格は route が保存確定後に kvSet(usedKey, ORDER_MARK_DONE) で値と TTL を上書き (pending→done・EX を落とす)。
export const ORDER_MARK_PENDING = 'pending';
export const ORDER_MARK_DONE = 'done';
export const ORDER_PENDING_TTL_SEC = 120; // pending クレームの寿命 (秒)。検証 + 保存の想定所要 << 120s。
export const ORDER_LIST_MAX = 200; // 1 merchant あたり保持上限 (kvLtrim)
// 最低着金フロア = 1 JPYC (decimals 18)。dust/誤検出を弾く最小値。**権威額は実着金合計**で、
// minValue はあくまで「正の着金があったか」のフロア (申告額には依存しない・advisory 原則)。
export const ORDER_DUST_FLOOR_WEI = 1_000_000_000_000_000_000n;
export const ORDER_ITEMS_MAX = 20; // 申告明細の件数上限
export const ORDER_ITEM_QTY_MAX = 999;
export const ORDER_ITEM_NAME_MAX = 80;
export const ORDER_TABLE_MAX = 64; // テーブル番号ラベル (checkout description 由来) の上限
export const ORDER_ID_MAX = 64;
export const ORDER_MEMO_MAX = 120;

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
  from: string; // 顧客申告の支払元 (**未検証・表示専用**)。feeVerify は from を返さず route も照合しない
                // (forwarder-split では merchant への Transfer の from は forwarder であり顧客ではない)。P1-D
  ts: number; // 受信時刻 (ms)
  fulfilled: boolean; // 「対応済み」フラグ。削除でなくフラグ化し誤操作を復旧可能に (未対応に戻せる)。
  // 受取予定時刻 (ms・Phase 4・preorder で顧客が選んだスロット)。未指定=即時/店頭。表示用 (advisory)。
  pickupAt?: number;
  // 顧客申告の注文メモ。CheckoutItem.memo / HistoryEntry.memo とは分離し、受注面だけに保存・表示する。
  customerMemo?: string;
  // 厨房モニターの **中間「調理済み」フラグ** (店主操作・調理が終わった合図)。fulfilled (対応済み) とは
  // 独立 = 調理済みにしてもオーダーは未対応のまま (ホールが配膳=対応済みにするまで残る)。厨房ボードは
  // これで active/done を分け done は折りたたみへ。保存時は true のときだけ持つ。
  // ※ ホールの「配膳済み」は別フラグを持たず **fulfilled (対応済み) そのもの** (配膳済み=対応済み)。
  kitchenDone?: boolean;
  // お渡し準備完了 (ホール操作・flag ENABLE_ORDER_PICKUP)。fulfilled (受け渡し済=対応済み) の **手前** の
  // 独立状態 = 「準備できた・受取待ち」。顧客の注文状況ページに「お渡しする準備ができました」を出すトリガ。
  // 受け渡し (fulfill) で対応済みになる。保存時は true のときだけ持つ。
  ready?: boolean;
  // ready=true にした時刻 (ms・表示用 advisory)。「HH:mm 準備完了」表示に使う。
  readyAt?: number;
  // 金額突合の advisory フラグ。true のときだけ保存し、false/欠落は同一扱い。
  amountMismatch?: boolean;
  amountUnchecked?: boolean;
};

/**
 * 厨房向けの「調理の締切」近似キー。preorder は受取予定時刻、店頭注文は受信時刻を使う。
 * 受信時刻が不明な店頭注文は、既知時刻の注文より後ろへ送る。
 */
export function orderDeadlineKey(o: StoredOrder): number {
  return o.pickupAt ?? (o.ts > 0 ? o.ts : Number.MAX_SAFE_INTEGER);
}

/** 厨房向け: 未調理 (cooked !== true) の品目数を注文横断で商品名ごとに集計する。 */
export function uncookedItemTotals(orders: StoredOrder[]): { name: string; qty: number }[] {
  const totals = new Map<string, number>();
  for (const order of orders) {
    for (const item of order.items) {
      if (item.cooked === true) continue;
      totals.set(item.name, (totals.get(item.name) ?? 0) + item.qty);
    }
  }
  return [...totals].map(([name, qty]) => ({ name, qty })).sort(
    (a, b) => b.qty - a.qty || a.name.localeCompare(b.name),
  );
}

/** 店主 (受取アドレス) ごとの受注リスト KV キー。受取アドレスでスコープ (read は受取ウォレット SIWE)。 */
export function orderListKey(merchant: string): string {
  return `order:list:${merchant.toLowerCase()}`;
}

/** txHash 冪等鍵 (1 決済 1 注文)。merchant や items は鍵に含めない。 */
export function orderUsedKey(chainId: number, txHash: string): string {
  return `order:used:${chainId}:${txHash.toLowerCase()}`;
}

/** 顧客向け「注文状況」の逆引きポインタ KV キー (status トークン → 受注の所在)。flag ENABLE_ORDER_PICKUP。
 *  token は顧客端末が生成する不可推測の秘密 (43 文字 base64url) = 列挙不可。値は {merchant, chainId, txHash}。
 *  これにより顧客は自分の token でのみ自分の 1 注文の状態を読める (受注リストは受取アドレスでスコープ)。 */
export function orderStatusPointerKey(token: string): string {
  return `order:sv:${token}`;
}

/** order:sv:<token> の値 (JSON) を検証付きで復元。不正/壊れは null (KV は untrusted 扱い)。
 *  merchant の 0x 妥当性は呼出側 (route・viem) が見る (本 lib は viem 非依存を保つ)。 */
export function parseOrderStatusPointer(
  raw: string,
): { merchant: string; chainId: number; txHash: string } | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.merchant !== 'string' ||
    o.merchant.length === 0 ||
    typeof o.chainId !== 'number' ||
    !Number.isInteger(o.chainId) ||
    !isTxHashLike(o.txHash)
  ) {
    return null;
  }
  return { merchant: o.merchant, chainId: o.chainId, txHash: o.txHash };
}

const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;
const DECIMAL_INT = /^\d+$/;
const ORDER_ITEM_PRICE_MAX = 80;
const ORDER_ITEM_DECIMALS_MAX = 36;

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
    const qty =
      Number.isFinite(qtyNum) && qtyNum > 0
        ? Math.min(Math.floor(qtyNum), ORDER_ITEM_QTY_MAX)
        : 0;
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

/** 申告明細の合計を token minor units に厳密変換する。変換不能なら null (= 突合不可)。 */
export function declaredItemsTotalMinor(
  items: StoredOrderItem[],
  decimals: number,
): bigint | null {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > ORDER_ITEM_DECIMALS_MAX
  ) {
    return null;
  }

  let total = 0n;
  for (const item of items) {
    if (
      !Number.isInteger(item.qty) ||
      item.qty < 1 ||
      item.qty > ORDER_ITEM_QTY_MAX
    ) {
      return null;
    }
    if (typeof item.price !== 'string') return null;
    const price = item.price;
    if (
      price.length === 0 ||
      price.length > ORDER_ITEM_PRICE_MAX ||
      !POSITIVE_DECIMAL.test(price)
    ) {
      return null;
    }

    const [integerPart, fractionPart = ''] = price.split('.');
    if (fractionPart.length > decimals) return null;
    const paddedFraction = fractionPart.padEnd(decimals, '0');
    const minorText = paddedFraction.length > 0
      ? `${integerPart}${paddedFraction}`
      : integerPart;
    total += BigInt(minorText) * BigInt(item.qty);
  }
  return total;
}

export function evaluateOrderAmount(
  declaredMinor: bigint | null,
  receiptMinor: bigint,
  floorMinor: bigint,
  bpsCap: number,
): { mismatch: boolean; unchecked: boolean } {
  if (declaredMinor === null) return { mismatch: false, unchecked: true };

  const safeFloor = floorMinor > 0n ? floorMinor : 0n;
  const safeBps = Number.isFinite(bpsCap) && bpsCap > 0 ? Math.floor(bpsCap) : 0;
  const bpsAllowance = (declaredMinor * BigInt(safeBps)) / 10000n;
  const allowance = safeFloor > bpsAllowance ? safeFloor : bpsAllowance;
  const expectedMinNetRaw = declaredMinor - allowance;
  const expectedMinNet = expectedMinNetRaw > 0n ? expectedMinNetRaw : 0n;
  return { mismatch: receiptMinor < expectedMinNet, unchecked: false };
}

/** テーブル番号ラベル (checkout description) のサニタイズ。空/非文字列は null。 */
export function sanitizeTable(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().slice(0, ORDER_TABLE_MAX);
  return t.length > 0 ? t : null;
}

/** 顧客申告の注文メモ。空/非文字列は除外し、制御文字を落として最大 120 コードポイントに制限する。 */
export function sanitizeOrderMemo(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const chars = [...raw.trim()].filter((ch) => {
    const code = ch.charCodeAt(0);
    return !((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f));
  });
  const memo = chars.slice(0, ORDER_MEMO_MAX).join('');
  return memo.length > 0 ? memo : undefined;
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
  const customerMemo = sanitizeOrderMemo(o.customerMemo);
  if (customerMemo) order.customerMemo = customerMemo;
  // 厨房の調理済み (true のときだけ保持・旧データは未設定=未完了)。
  if (o.kitchenDone === true) order.kitchenDone = true;
  // お渡し準備完了 (true のときだけ保持・旧データは未設定)。readyAt は ready=true かつ正の有限数のみ
  // (表示用 advisory・ready 無しの readyAt は無意味なので落とす)。
  if (o.ready === true) {
    order.ready = true;
    if (typeof o.readyAt === 'number' && Number.isFinite(o.readyAt) && o.readyAt > 0) {
      order.readyAt = o.readyAt;
    }
  }
  if (o.amountMismatch === true) order.amountMismatch = true;
  if (o.amountUnchecked === true) order.amountUnchecked = true;
  return order;
}

// ── 受注フィードの状態更新オペレーション (Phase 3・/api/order/feed POST)。txHash で対象注文を
//    指定し、op で何を変えるかを表す。旧 { txHash, fulfilled } も受理 (後方互換)。 ──
export type OrderFeedOp =
  | { kind: 'fulfill'; value: boolean } // 注文「対応済み」(削除でなくフラグ)
  | { kind: 'itemCooked'; index: number; value: boolean } // 商品別「調理済み」(キッチン)
  | { kind: 'itemServed'; index: number; value: boolean } // 商品別「配膳済み」(ホール)
  | { kind: 'kitchenDone'; value: boolean } // 注文単位「調理済み」(厨房モニター・中間・折りたたみへ)
  | { kind: 'markReady'; value: boolean } // お渡し準備完了 (ホール・顧客通知トリガ・flag ENABLE_ORDER_PICKUP)
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
    case 'markReady':
      return typeof o.value === 'boolean'
        ? { txHash, op: { kind: 'markReady', value: o.value } }
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

/** op を純粋適用した新しい StoredOrder を返す (元は不変・変化が無ければ同等値)。nowMs は markReady の
 *  readyAt を刻む server 時刻 (route が Date.now() を注入・純粋性のため引数で受ける)。 */
export function applyOrderOp(
  order: StoredOrder,
  op: OrderFeedOp,
  nowMs?: number,
): StoredOrder {
  switch (op.kind) {
    case 'fulfill':
      return { ...order, fulfilled: op.value };
    case 'kitchenDone':
      return { ...order, kitchenDone: op.value };
    case 'markReady':
      // ready=true で readyAt を server 時刻 (nowMs) で刻む。**既に ready または fulfilled 済なら order を
      // そのまま返す = 冪等/no-op**: ①再クリックで readyAt を再スタンプしない (準備完了時刻は初回確定・
      // CAS も走らない) ②受け渡し済 (fulfilled) を ready に逆行させない — CAS で fulfill が先に勝った後の
      // markReady が ready を立て、後で un-fulfill すると stale な準備完了通知に regress するのを防ぐ
      // (Codex)。false で両方クリア (受取待ち解除)。nowMs 未指定なら既存 readyAt を保つ (表示用 advisory)。
      return op.value
        ? order.ready || order.fulfilled
          ? order
          : { ...order, ready: true, readyAt: nowMs !== undefined ? nowMs : order.readyAt }
        : { ...order, ready: false, readyAt: undefined };
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

// ── 顧客向け「お渡し準備通知」の状態 (flag ENABLE_ORDER_PICKUP)。/api/order/status が返す coarse な
//    state で、顧客の注文状況ページが「受付済み/調理中/お渡し準備完了/受け渡し済」を出し分ける。 ──
export type OrderPickupState = 'received' | 'preparing' | 'ready' | 'done';

/** 受注の顧客向け状態を導出。優先順: 受け渡し済 (fulfilled) > お渡し準備完了 (ready) > 調理中
 *  (kitchenDone または一部 cooked) > 受付済み。fulfilled が ready より優先 = 受け渡し後は done 表示。 */
export function orderPickupState(order: StoredOrder): OrderPickupState {
  if (order.fulfilled) return 'done';
  if (order.ready) return 'ready';
  if (order.kitchenDone === true || order.items.some((it) => it.cooked === true)) {
    return 'preparing';
  }
  return 'received';
}
