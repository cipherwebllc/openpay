// 「前回と同じ注文」レコード (lib/lastOrder.ts) の純関数テスト。
// 柱: (1) validator は不正 shape を全て弾く (fail-safe)、(2) 店舗キーは handle 優先・無ければ受取先、
// (3) カート状態 → wire 形式 (selections は single=文字列 / multi=配列)、(4) 支払い判定は
// 同店舗・confirmed・ハンドオフ以降のみ。

import { describe, expect, it } from 'vitest';
import {
  cartFromState,
  isLastOrderRecord,
  lastOrderPaid,
  lastOrderShopKey,
  lastOrderStorageKey,
  selectionsToOptionSelection,
  type LastOrderRecord,
} from '@/lib/lastOrder';
import { buildPayerReceipt } from '@/lib/payerReceipt';

const RECEIVER = '0x1111111111111111111111111111111111111111';
const TX = `0x${'ab'.repeat(32)}`;

describe('isLastOrderRecord', () => {
  const valid: LastOrderRecord = {
    receiver: RECEIVER,
    cart: [{ id: 'a', qty: 2 }, { id: 'b', qty: 1, options: { size: 'l', top: ['x', 'y'] } }],
    ts: 1_700_000_000_000,
  };
  it('正常 shape を受理', () => {
    expect(isLastOrderRecord(valid)).toBe(true);
  });
  it('不正 shape は全て拒否 (fail-safe)', () => {
    const bad: unknown[] = [
      null,
      'x',
      { ...valid, receiver: '' },
      { ...valid, cart: [] },
      { ...valid, cart: [{ id: 'a', qty: 0 }] },
      { ...valid, cart: [{ id: 'a', qty: 1.5 }] },
      { ...valid, cart: [{ id: '', qty: 1 }] },
      { ...valid, cart: [{ id: 'a', qty: 1, options: { size: 1 } }] },
      { ...valid, cart: [{ id: 'a', qty: 1, options: { size: ['a', 2] } }] },
      { ...valid, ts: 0 },
      { ...valid, ts: 'yesterday' },
    ];
    for (const o of bad) expect(isLastOrderRecord(o), JSON.stringify(o)).toBe(false);
  });
});

describe('lastOrderShopKey / lastOrderStorageKey', () => {
  it('handle 優先・無ければ受取先 (小文字)', () => {
    expect(lastOrderShopKey('coffee', RECEIVER)).toBe('h:coffee');
    expect(lastOrderShopKey(undefined, RECEIVER.toUpperCase())).toBe(`addr:${RECEIVER}`);
    expect(lastOrderStorageKey('coffee', RECEIVER)).toBe('openpay:last-order:v1:h:coffee');
  });
});

describe('selectionsToOptionSelection / cartFromState', () => {
  it('single は文字列・multi は配列・空は undefined', () => {
    expect(selectionsToOptionSelection([])).toBeUndefined();
    expect(
      selectionsToOptionSelection([
        { groupId: 'size', choiceId: 'l' },
        { groupId: 'top', choiceId: 'x' },
        { groupId: 'top', choiceId: 'y' },
      ]),
    ).toEqual({ size: 'l', top: ['x', 'y'] });
  });

  it('qty マップ + オプション行 → wire カート (0 数量・selections 無しの行は除外)', () => {
    const cart = cartFromState(
      { a: 2, b: 0 },
      [
        { itemId: 'c', qty: 1, selections: [{ groupId: 'size', choiceId: 'l' }] },
        { itemId: 'd', qty: 1 }, // selections 無し (復元不能) → 保存しない
        { itemId: 'e', qty: 0, selections: [] },
      ],
    );
    expect(cart).toEqual([
      { id: 'a', qty: 2 },
      { id: 'c', qty: 1, options: { size: 'l' } },
    ]);
  });
});

describe('lastOrderPaid', () => {
  const record: LastOrderRecord = {
    receiver: RECEIVER,
    cart: [{ id: 'a', qty: 1 }],
    ts: Date.parse('2026-09-01T10:00:00Z'),
  };
  const receipt = (over: Partial<Parameters<typeof buildPayerReceipt>[0]> = {}, at = '2026-09-01T10:05:00Z') =>
    buildPayerReceipt(
      { asset: 'jpyc', amount: '500', merchantAddress: RECEIVER, txHash: TX, ...over },
      new Date(at),
    );

  it('同店舗・confirmed・ハンドオフ以降の控えがあれば true', () => {
    expect(lastOrderPaid(record, [receipt()])).toBe(true);
    // 受取先の大文字小文字は無視
    expect(lastOrderPaid(record, [receipt({ merchantAddress: RECEIVER.toUpperCase() })])).toBe(true);
  });

  it('別店舗 / ハンドオフより前 (5 分の時計ずれ超) / pending は false', () => {
    expect(lastOrderPaid(record, [])).toBe(false);
    expect(
      lastOrderPaid(record, [receipt({ merchantAddress: '0x2222222222222222222222222222222222222222' })]),
    ).toBe(false);
    expect(lastOrderPaid(record, [receipt({}, '2026-09-01T09:50:00Z')])).toBe(false);
    const pending = { ...receipt(), status: 'pending' as const };
    expect(lastOrderPaid(record, [pending])).toBe(false);
  });
});
