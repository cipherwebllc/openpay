// 受注リレーの純ロジック (lib/orderRelay.ts) を実コードで検証。
// KV キー / txHash 判定 / 申告明細サニタイズ / 直列化・復元 (untrusted な KV 値の検証込み)。

import { describe, it, expect } from 'vitest';
import {
  orderListKey,
  orderUsedKey,
  isTxHashLike,
  sanitizeOrderItems,
  sanitizeTable,
  serializeOrder,
  parseStoredOrder,
  parseOrderFeedOp,
  applyOrderOp,
  ORDER_ITEMS_MAX,
  ORDER_ITEM_NAME_MAX,
  type StoredOrder,
} from '@/lib/orderRelay';

const TX = `0x${'a'.repeat(64)}`;

function order(over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: 'oid-1',
    items: [{ name: 'ブレンド', qty: 2, price: '500' }],
    table: 'テーブル 7',
    amount: '1000000000000000000', // 1 JPYC (minor units)
    txHash: TX,
    chainId: 137,
    from: '0x1111111111111111111111111111111111111111',
    ts: 1_700_000_000_000,
    fulfilled: false,
    ...over,
  };
}

describe('orderRelay: KV キー', () => {
  it('orderListKey は受取アドレスを小文字化', () => {
    expect(orderListKey('0xABCdef0000000000000000000000000000000000')).toBe(
      'order:list:0xabcdef0000000000000000000000000000000000',
    );
  });
  it('orderUsedKey は chainId + txHash 小文字 (merchant/items は含めない=1決済1注文)', () => {
    expect(orderUsedKey(137, `0x${'A'.repeat(64)}`)).toBe(`order:used:137:0x${'a'.repeat(64)}`);
  });
});

describe('orderRelay: isTxHashLike', () => {
  it('0x + 64 hex のみ true', () => {
    expect(isTxHashLike(TX)).toBe(true);
    expect(isTxHashLike(`0x${'a'.repeat(63)}`)).toBe(false); // 短い
    expect(isTxHashLike(`${'a'.repeat(64)}`)).toBe(false); // 0x 無し
    expect(isTxHashLike(123)).toBe(false);
    expect(isTxHashLike(undefined)).toBe(false);
  });
});

describe('orderRelay: sanitizeOrderItems (申告明細・改ざん耐性)', () => {
  it('有効な明細を整形 (name trim・qty 整数・price 十進)', () => {
    expect(
      sanitizeOrderItems([{ name: '  水  ', qty: 3, price: '100' }]),
    ).toEqual([{ name: '水', qty: 3, price: '100' }]);
  });
  it('名前空 / qty 非正 / price 不正は除外 or 空 price', () => {
    expect(sanitizeOrderItems([{ name: '', qty: 1, price: '1' }])).toEqual([]); // 名前必須
    expect(sanitizeOrderItems([{ name: 'x', qty: 0, price: '1' }])).toEqual([]); // qty>0
    expect(sanitizeOrderItems([{ name: 'x', qty: -2, price: '1' }])).toEqual([]);
    expect(sanitizeOrderItems([{ name: 'x', qty: 2, price: 'abc' }])).toEqual([
      { name: 'x', qty: 2, price: '' }, // 不正 price は空 (行は残す)
    ]);
  });
  it('qty は floor (小数は切り捨て)', () => {
    expect(sanitizeOrderItems([{ name: 'x', qty: 2.9, price: '1' }])[0].qty).toBe(2);
  });
  it('非配列は空配列', () => {
    expect(sanitizeOrderItems('x')).toEqual([]);
    expect(sanitizeOrderItems(null)).toEqual([]);
    expect(sanitizeOrderItems({ name: 'x' })).toEqual([]);
  });
  it('件数は ORDER_ITEMS_MAX で打ち切り・名前は長さ clamp', () => {
    const many = Array.from({ length: ORDER_ITEMS_MAX + 5 }, () => ({ name: 'x', qty: 1, price: '1' }));
    expect(sanitizeOrderItems(many)).toHaveLength(ORDER_ITEMS_MAX);
    const long = sanitizeOrderItems([{ name: 'あ'.repeat(ORDER_ITEM_NAME_MAX + 10), qty: 1, price: '1' }]);
    expect(long[0].name.length).toBe(ORDER_ITEM_NAME_MAX);
  });
});

describe('orderRelay: sanitizeTable', () => {
  it('文字列を trim・空/非文字列は null', () => {
    expect(sanitizeTable('  テーブル 5  ')).toBe('テーブル 5');
    expect(sanitizeTable('   ')).toBeNull();
    expect(sanitizeTable(undefined)).toBeNull();
    expect(sanitizeTable(42)).toBeNull();
  });
});

describe('orderRelay: serialize/parse (KV は untrusted・read 時も検証)', () => {
  it('round-trip 一致', () => {
    const o = order();
    expect(parseStoredOrder(serializeOrder(o))).toEqual(o);
  });
  it('非 JSON / 非オブジェクトは null', () => {
    expect(parseStoredOrder('not json')).toBeNull();
    expect(parseStoredOrder('"x"')).toBeNull();
    expect(parseStoredOrder('42')).toBeNull();
  });
  it('amount が非数字文字列 → null', () => {
    expect(parseStoredOrder(serializeOrder(order({ amount: '12.3' } as Partial<StoredOrder>)))).toBeNull();
    expect(parseStoredOrder(JSON.stringify({ ...order(), amount: 'abc' }))).toBeNull();
  });
  it('txHash 不正 / chainId 非整数 → null', () => {
    expect(parseStoredOrder(JSON.stringify({ ...order(), txHash: '0xnope' }))).toBeNull();
    expect(parseStoredOrder(JSON.stringify({ ...order(), chainId: 1.5 }))).toBeNull();
  });
  it('orderId 空 → null', () => {
    expect(parseStoredOrder(JSON.stringify({ ...order(), orderId: '' }))).toBeNull();
  });
  it('items が壊れていても他が valid なら復元 (items はサニタイズ)', () => {
    const parsed = parseStoredOrder(JSON.stringify({ ...order(), items: 'oops' }));
    expect(parsed).not.toBeNull();
    expect(parsed?.items).toEqual([]);
  });
  it('fulfilled は true のみ true・それ以外/欠落は false', () => {
    expect(parseStoredOrder(serializeOrder(order({ fulfilled: true })))?.fulfilled).toBe(true);
    expect(parseStoredOrder(JSON.stringify({ ...order(), fulfilled: 'yes' }))?.fulfilled).toBe(false);
    const noField = JSON.parse(serializeOrder(order())) as Record<string, unknown>;
    delete noField.fulfilled;
    expect(parseStoredOrder(JSON.stringify(noField))?.fulfilled).toBe(false);
  });

  it('kitchenDone は true のときだけ復元 (旧データ=未設定)', () => {
    const k = parseStoredOrder(serializeOrder(order({ kitchenDone: true })));
    expect(k?.kitchenDone).toBe(true);
    // 非 true / 欠落は undefined。
    expect(parseStoredOrder(JSON.stringify({ ...order(), kitchenDone: 'yes' }))?.kitchenDone).toBeUndefined();
    expect(parseStoredOrder(serializeOrder(order()))?.kitchenDone).toBeUndefined();
  });
});

describe('orderRelay: 厨房の調理済み op (kitchenDone) — 配膳済みは fulfill を使う', () => {
  it('parseOrderFeedOp: boolean のみ受理・非 boolean は null', () => {
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'kitchenDone', value: true } })).toEqual({
      txHash: TX,
      op: { kind: 'kitchenDone', value: true },
    });
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'kitchenDone', value: false } })).toEqual({
      txHash: TX,
      op: { kind: 'kitchenDone', value: false },
    });
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'kitchenDone', value: 'x' } })).toBeNull();
    // hallDone op は廃止 (ホール配膳済み=fulfill)。未知の kind は null。
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'hallDone', value: true } })).toBeNull();
  });

  it('applyOrderOp: kitchenDone は fulfilled (対応済み) に影響しない (中間フラグ)', () => {
    const o = order();
    const k = applyOrderOp(o, { kind: 'kitchenDone', value: true });
    expect(k.kitchenDone).toBe(true);
    expect(k.fulfilled).toBe(false); // 調理済みにしても未対応のまま (ホール配膳で対応済みに)
    // ホールの配膳済み = fulfill op = 対応済み。kitchenDone は維持。
    const h = applyOrderOp(k, { kind: 'fulfill', value: true });
    expect(h.kitchenDone).toBe(true); // 厨房側は維持
    expect(h.fulfilled).toBe(true); // 配膳済み=対応済み
  });
});
