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
  orderPickupState,
  parseOrderStatusPointer,
  ORDER_ITEMS_MAX,
  ORDER_ITEM_NAME_MAX,
  ORDER_TABLE_MAX,
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

describe('orderRelay: parseStoredOrder の pickupAt / 進捗フラグ復元 (KV untrusted)', () => {
  it('pickupAt は正の有限数のみ復元 (0/負/非数/欠落は undefined)', () => {
    expect(parseStoredOrder(serializeOrder(order({ pickupAt: 1_700_000_500_000 })))?.pickupAt).toBe(
      1_700_000_500_000,
    );
    // 0 は「未指定 (即時/店頭)」と区別できないので除外 (手動 pickup_at=0 混入もここで弾く)。
    expect(parseStoredOrder(JSON.stringify({ ...order(), pickupAt: 0 }))?.pickupAt).toBeUndefined();
    expect(parseStoredOrder(JSON.stringify({ ...order(), pickupAt: -5 }))?.pickupAt).toBeUndefined();
    expect(parseStoredOrder(JSON.stringify({ ...order(), pickupAt: 'soon' }))?.pickupAt).toBeUndefined();
    expect(parseStoredOrder(serializeOrder(order()))?.pickupAt).toBeUndefined(); // 欠落
  });

  it('進捗フラグ (cooked/served) は **保存データからのみ** 復元・webhook 申告では落とす (改竄注入防止)', () => {
    // parseStoredOrder は preserveStatus:true → 保存済みの cooked/served を復元。
    const stored = parseStoredOrder(
      JSON.stringify({
        ...order(),
        items: [{ name: 'A', qty: 1, price: '100', cooked: true, served: true }],
      }),
    );
    expect(stored?.items[0]).toEqual({ name: 'A', qty: 1, price: '100', cooked: true, served: true });
    // sanitizeOrderItems の既定 (= webhook/顧客申告経路) は cooked/served を **無視** する。
    expect(sanitizeOrderItems([{ name: 'A', qty: 1, price: '100', cooked: true, served: true }])).toEqual([
      { name: 'A', qty: 1, price: '100' },
    ]);
  });

  it('ts は有限数のみ・非数/非有限は 0 (sentinel)', () => {
    expect(parseStoredOrder(serializeOrder(order({ ts: 1_700_000_000_000 })))?.ts).toBe(1_700_000_000_000);
    expect(parseStoredOrder(JSON.stringify({ ...order(), ts: 'x' }))?.ts).toBe(0);
  });
});

describe('orderRelay: parseOrderFeedOp (untrusted POST body・全 op 網羅)', () => {
  it('不正な body は null (null / 非 object / txHash 欠落 / txHash 不正)', () => {
    expect(parseOrderFeedOp(null)).toBeNull();
    expect(parseOrderFeedOp('x')).toBeNull();
    expect(parseOrderFeedOp(123)).toBeNull();
    expect(parseOrderFeedOp({})).toBeNull();
    expect(parseOrderFeedOp({ txHash: '0xnope' })).toBeNull();
  });

  it('旧 schema {fulfilled} (op 無し): 既定 true・false 明示は false', () => {
    expect(parseOrderFeedOp({ txHash: TX })).toEqual({ txHash: TX, op: { kind: 'fulfill', value: true } });
    expect(parseOrderFeedOp({ txHash: TX, fulfilled: false })).toEqual({
      txHash: TX,
      op: { kind: 'fulfill', value: false },
    });
    expect(parseOrderFeedOp({ txHash: TX, fulfilled: true })).toEqual({
      txHash: TX,
      op: { kind: 'fulfill', value: true },
    });
  });

  it('fulfill op: boolean のみ・非 boolean は null', () => {
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'fulfill', value: false } })).toEqual({
      txHash: TX,
      op: { kind: 'fulfill', value: false },
    });
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'fulfill', value: 1 } })).toBeNull();
  });

  it('itemCooked / itemServed: index は [0, MAX) の整数・value は boolean', () => {
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'itemCooked', index: 0, value: true } })).toEqual({
      txHash: TX,
      op: { kind: 'itemCooked', index: 0, value: true },
    });
    expect(
      parseOrderFeedOp({ txHash: TX, op: { kind: 'itemServed', index: ORDER_ITEMS_MAX - 1, value: false } }),
    ).toEqual({ txHash: TX, op: { kind: 'itemServed', index: ORDER_ITEMS_MAX - 1, value: false } });
    // 境界: ORDER_ITEMS_MAX は範囲外 (0-indexed)。
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'itemCooked', index: ORDER_ITEMS_MAX, value: true } })).toBeNull();
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'itemCooked', index: -1, value: true } })).toBeNull();
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'itemCooked', index: 1.5, value: true } })).toBeNull();
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'itemCooked', value: true } })).toBeNull(); // index 欠落
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'itemServed', index: 0, value: 'x' } })).toBeNull();
  });

  it('setTable: string は trim+clamp(MAX)・null 受理・非 string/null は null・欠落は null', () => {
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'setTable', table: '  B2  ' } })).toEqual({
      txHash: TX,
      op: { kind: 'setTable', table: 'B2' },
    });
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'setTable', table: null } })).toEqual({
      txHash: TX,
      op: { kind: 'setTable', table: null },
    });
    const long = parseOrderFeedOp({ txHash: TX, op: { kind: 'setTable', table: 'x'.repeat(100) } });
    expect((long?.op as { kind: 'setTable'; table: string }).table.length).toBe(ORDER_TABLE_MAX);
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'setTable', table: 42 } })).toBeNull();
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'setTable' } })).toBeNull(); // 誤入力でテーブルを黙ってクリアしない
  });

  it('未知の kind / op 不正は null', () => {
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'explode', value: true } })).toBeNull();
    expect(parseOrderFeedOp({ txHash: TX, op: {} })).toBeNull();
    expect(parseOrderFeedOp({ txHash: TX, op: 'nope' })).toBeNull();
  });
});

describe('orderRelay: applyOrderOp (純粋・不変・範囲外 no-op・データ検査)', () => {
  const base = () =>
    order({
      items: [
        { name: 'A', qty: 1, price: '100' },
        { name: 'B', qty: 2, price: '200' },
      ],
    });

  it('itemCooked/itemServed: 対象 index のみ更新・非対象は同一参照・元は不変', () => {
    const b = base();
    const out = applyOrderOp(b, { kind: 'itemCooked', index: 0, value: true });
    expect(out).not.toBe(b); // 新オブジェクト
    expect(out.items[0]).toEqual({ name: 'A', qty: 1, price: '100', cooked: true });
    expect(out.items[1]).toBe(b.items[1]); // 非対象 item は同一参照 (不要な再生成なし)
    expect(b.items[0].cooked).toBeUndefined(); // 元は不変
    const served = applyOrderOp(b, { kind: 'itemServed', index: 1, value: true });
    expect(served.items[1]).toEqual({ name: 'B', qty: 2, price: '200', served: true });
    expect(served.items[0]).toBe(b.items[0]);
  });

  it('範囲外 index は no-op (同一オブジェクトを返す)', () => {
    const b = base();
    // items.length(2) <= index(5) → 変更なし。route は parseOrderFeedOp で <MAX に制限するが
    // items.length 未満の保証はないため applyOrderOp 側でも範囲外を弾く。
    expect(applyOrderOp(b, { kind: 'itemCooked', index: 5, value: true })).toBe(b);
    expect(applyOrderOp(b, { kind: 'itemServed', index: 2, value: true })).toBe(b); // index==length も範囲外
  });

  it('fulfill / kitchenDone / setTable は該当フィールドのみ変更 (元は不変)', () => {
    const b = base();
    expect(applyOrderOp(b, { kind: 'fulfill', value: true })).toMatchObject({ fulfilled: true });
    expect(applyOrderOp(b, { kind: 'kitchenDone', value: true })).toMatchObject({ kitchenDone: true });
    expect(applyOrderOp(b, { kind: 'setTable', table: 'Z9' })).toMatchObject({ table: 'Z9' });
    expect(applyOrderOp(b, { kind: 'setTable', table: null })).toMatchObject({ table: null });
    expect(b.fulfilled).toBe(false); // 元は不変
    expect(b.kitchenDone).toBeUndefined();
  });
});

describe('orderRelay: お渡し準備完了 (markReady / ready / readyAt・flag ENABLE_ORDER_PICKUP)', () => {
  const NOW = 1_700_000_900_000;

  it('parseOrderFeedOp: markReady は boolean のみ受理・非 boolean / 欠落は null', () => {
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'markReady', value: true } })).toEqual({
      txHash: TX,
      op: { kind: 'markReady', value: true },
    });
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'markReady', value: false } })).toEqual({
      txHash: TX,
      op: { kind: 'markReady', value: false },
    });
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'markReady', value: 'x' } })).toBeNull();
    expect(parseOrderFeedOp({ txHash: TX, op: { kind: 'markReady' } })).toBeNull();
  });

  it('applyOrderOp: markReady(true) は ready+readyAt(nowMs) を立て fulfilled は不変・元は不変', () => {
    const o = order();
    const r = applyOrderOp(o, { kind: 'markReady', value: true }, NOW);
    expect(r.ready).toBe(true);
    expect(r.readyAt).toBe(NOW);
    expect(r.fulfilled).toBe(false); // 準備完了 ≠ 受け渡し済 (独立状態)
    expect(o.ready).toBeUndefined(); // 元は不変
    expect(o.readyAt).toBeUndefined();
  });

  it('applyOrderOp: markReady(false) は ready=false + readyAt クリア (受取待ち解除)', () => {
    const r = applyOrderOp(order({ ready: true, readyAt: NOW }), { kind: 'markReady', value: false }, NOW);
    expect(r.ready).toBe(false);
    expect(r.readyAt).toBeUndefined();
  });

  it('applyOrderOp: markReady(true) で nowMs 未指定なら既存 readyAt を保つ', () => {
    expect(applyOrderOp(order(), { kind: 'markReady', value: true }).readyAt).toBeUndefined();
    expect(
      applyOrderOp(order({ ready: true, readyAt: NOW }), { kind: 'markReady', value: true }).readyAt,
    ).toBe(NOW);
  });

  it('applyOrderOp: 既に ready な order への markReady(true) は冪等 (別 nowMs でも再スタンプせず不変)', () => {
    const ready = order({ ready: true, readyAt: NOW });
    const r = applyOrderOp(ready, { kind: 'markReady', value: true }, NOW + 5000);
    expect(r).toBe(ready); // 同一参照 = no-op (feed の CAS が走らない・readyAt 不変)
    expect(r.readyAt).toBe(NOW); // 準備完了時刻は最初の 1 回で確定 (再クリックで動かない)
  });

  it('markReady と fulfill は独立 (準備完了 → 受け渡し済 の遷移で両立)', () => {
    const r = applyOrderOp(order(), { kind: 'markReady', value: true }, NOW);
    const f = applyOrderOp(r, { kind: 'fulfill', value: true });
    expect(f.ready).toBe(true); // 準備完了は維持
    expect(f.fulfilled).toBe(true); // 受け渡し済
  });

  it('parseStoredOrder: ready は true のみ復元・readyAt は ready かつ正の有限数のみ', () => {
    const ok = parseStoredOrder(serializeOrder(order({ ready: true, readyAt: NOW })));
    expect(ok?.ready).toBe(true);
    expect(ok?.readyAt).toBe(NOW);
    // ready=false / 欠落 → undefined。
    expect(parseStoredOrder(serializeOrder(order()))?.ready).toBeUndefined();
    expect(parseStoredOrder(JSON.stringify({ ...order(), ready: 'yes' }))?.ready).toBeUndefined();
    // ready 無しの readyAt は無意味 → 落とす。
    expect(parseStoredOrder(JSON.stringify({ ...order(), readyAt: NOW }))?.readyAt).toBeUndefined();
    // ready=true でも readyAt が 0/負/非数なら undefined。
    expect(parseStoredOrder(JSON.stringify({ ...order(), ready: true, readyAt: 0 }))?.readyAt).toBeUndefined();
    expect(parseStoredOrder(JSON.stringify({ ...order(), ready: true, readyAt: 'soon' }))?.readyAt).toBeUndefined();
    // ready=true・readyAt 無しは ready のみ。
    const noAt = parseStoredOrder(JSON.stringify({ ...order(), ready: true }));
    expect(noAt?.ready).toBe(true);
    expect(noAt?.readyAt).toBeUndefined();
  });
});

describe('orderRelay: orderPickupState (顧客向け状態導出・優先順)', () => {
  it('fulfilled > ready > preparing > received の優先順', () => {
    expect(orderPickupState(order())).toBe('received');
    expect(
      orderPickupState(order({ items: [{ name: 'A', qty: 1, price: '1', cooked: true }] })),
    ).toBe('preparing');
    expect(orderPickupState(order({ kitchenDone: true }))).toBe('preparing');
    expect(orderPickupState(order({ ready: true }))).toBe('ready');
    // fulfilled (受け渡し済) は ready/preparing より優先 = done。
    expect(orderPickupState(order({ ready: true, fulfilled: true }))).toBe('done');
    expect(orderPickupState(order({ kitchenDone: true, fulfilled: true }))).toBe('done');
  });
  it('一部だけ cooked でも preparing (全品である必要はない)', () => {
    expect(
      orderPickupState(
        order({
          items: [
            { name: 'A', qty: 1, price: '1', cooked: true },
            { name: 'B', qty: 1, price: '1' },
          ],
        }),
      ),
    ).toBe('preparing');
  });
});

describe('orderRelay: parseOrderStatusPointer (order:sv 値・KV untrusted)', () => {
  it('valid round-trip', () => {
    const raw = JSON.stringify({ merchant: '0xabc', chainId: 137, txHash: TX });
    expect(parseOrderStatusPointer(raw)).toEqual({ merchant: '0xabc', chainId: 137, txHash: TX });
  });
  it('不正は null (非JSON / 非object / merchant空 / chainId非整数 / txHash不正)', () => {
    expect(parseOrderStatusPointer('nope')).toBeNull();
    expect(parseOrderStatusPointer('42')).toBeNull();
    expect(parseOrderStatusPointer(JSON.stringify({ merchant: '', chainId: 137, txHash: TX }))).toBeNull();
    expect(parseOrderStatusPointer(JSON.stringify({ merchant: '0xabc', chainId: 1.5, txHash: TX }))).toBeNull();
    expect(parseOrderStatusPointer(JSON.stringify({ merchant: '0xabc', chainId: 137, txHash: '0xnope' }))).toBeNull();
  });
});

describe('orderRelay: parseStoredOrder ready/readyAt 境界 (KV untrusted・正の有限数のみ復元)', () => {
  it('readyAt が 0/負/NaN/Infinity/文字列/null → 復元しない (ready は true でも readyAt は undefined)', () => {
    for (const bad of [0, -5, NaN, Infinity, '123', null]) {
      const o = parseStoredOrder(JSON.stringify({ ...order(), ready: true, readyAt: bad }));
      expect(o?.ready).toBe(true);
      expect(o?.readyAt).toBeUndefined();
    }
  });
  it('ready が === true 以外 (false/文字列/欠落) → ready を復元しない', () => {
    expect(parseStoredOrder(JSON.stringify({ ...order(), ready: false, readyAt: 999 }))?.ready).toBeUndefined();
    expect(parseStoredOrder(JSON.stringify({ ...order(), ready: 'true' }))?.ready).toBeUndefined();
    expect(parseStoredOrder(JSON.stringify(order()))?.ready).toBeUndefined();
  });
  it('ready が false なら readyAt も復元しない (孤児 readyAt を作らない)', () => {
    const o = parseStoredOrder(JSON.stringify({ ...order(), ready: false, readyAt: 1_700_000_000_000 }));
    expect(o?.ready).toBeUndefined();
    expect(o?.readyAt).toBeUndefined();
  });
});

describe('orderPickupState: items 空 / 境界', () => {
  it('items 空 + フラグ無 → received', () => {
    expect(orderPickupState(order({ items: [] }))).toBe('received');
  });
  it('items 空 + kitchenDone → preparing (cooked 走査に依存せず判定)', () => {
    expect(orderPickupState(order({ items: [], kitchenDone: true }))).toBe('preparing');
  });
  it('ready + fulfilled 同時 → done (fulfilled が最優先)', () => {
    expect(orderPickupState(order({ ready: true, fulfilled: true, kitchenDone: true }))).toBe('done');
  });
});
