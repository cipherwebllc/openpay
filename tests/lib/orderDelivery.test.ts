import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalOrder, orderBindSalt, orderDigest } from '@/lib/orderBind';
import { loadOrderDelivery, saveOrderDelivery, resolveOrderDelivery, acknowledgeOrderDelivery, ORDER_DELIVERY_KEY, type OrderDelivery } from '@/lib/orderDelivery';
const order = canonicalOrder({ chainId: 80002, tokenAddress: '0x0000000000000000000000000000000000000abc', merchant: '0x1111111111111111111111111111111111111111', handle: 'alice', orderId: 'id', items: [{ name: 'Tea', qty: 1, price: '100' }], statusToken: 's'.repeat(43) });
const secret = `0x${'12'.repeat(32)}` as const;
const record: OrderDelivery = {
  version: 1, order, bind: { v: 1, secret, validAfter: '0', validBefore: '1800000000' },
  intent: { chainId: 80002, from: '0x2222222222222222222222222222222222222222', merchant: order.merchant, merchantValue: '100000000000000000000', feeValue: '0', nonce: orderBindSalt(orderDigest(order), secret), validBefore: '1800000000', routeKind: 'free', issuedAt: 1700000000000 },
  forwarder: null, state: 'signed',
};
beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
describe('A2c undelivered order persistence', () => {
  it('stores a separate validated snapshot before broadcast and retains it at payment resolution', () => {
    expect(saveOrderDelivery(record)).toBe(true);
    expect(loadOrderDelivery()).toEqual({ kind: 'ready', record });
    const resolved = resolveOrderDelivery(record, `0x${'ab'.repeat(32)}`);
    expect(resolved.state).toBe('notify-pending');
    expect(saveOrderDelivery(resolved)).toBe(true);
    const reloaded = loadOrderDelivery();
    expect(reloaded).toEqual({ kind: 'ready', record: resolved });
    expect(JSON.parse(resolved.notifyBody!)).toMatchObject({ orderId: 'id', bind: record.bind, statusToken: order.statusToken });
    expect(acknowledgeOrderDelivery(resolved)).toBe(true);
    expect(loadOrderDelivery()).toEqual({ kind: 'empty' });
  });
  it('lost acknowledgement preserves identical bytes and replacement resolution changes only the hash', () => {
    const resolved = resolveOrderDelivery(record, `0x${'ab'.repeat(32)}`);
    saveOrderDelivery(resolved);
    const loaded = loadOrderDelivery();
    if (loaded.kind !== 'ready') throw new Error('missing record');
    expect(resolveOrderDelivery(loaded.record, resolved.txHash!).notifyBody).toBe(resolved.notifyBody);
    const replaced = resolveOrderDelivery(loaded.record, `0x${'cd'.repeat(32)}`);
    expect(replaced.bind).toEqual(resolved.bind);
    expect(replaced.order).toEqual(resolved.order);
    expect(JSON.parse(replaced.notifyBody!).txHash).toBe(replaced.txHash);
  });
  it('session loss cannot invent a snapshot or opening', () => {
    expect(loadOrderDelivery()).toEqual({ kind: 'empty' });
  });
  it.each(['order', 'nonce', 'body'])('rejects corrupted %s instead of regenerating an opening', (field) => {
    const saved = resolveOrderDelivery(record, `0x${'ab'.repeat(32)}`);
    const corrupt = field === 'order' ? { ...saved, order: { ...order, orderId: 'stolen' } } : field === 'nonce' ? { ...saved, intent: { ...saved.intent, nonce: `0x${'00'.repeat(32)}` } } : { ...saved, notifyBody: '{}' };
    sessionStorage.setItem(ORDER_DELIVERY_KEY, JSON.stringify(corrupt));
    expect(loadOrderDelivery()).toEqual({ kind: 'unavailable' });
  });
  it('storage read/write/remove failures are explicit and never create a false acknowledgement', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(saveOrderDelivery(record)).toBe(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(loadOrderDelivery()).toEqual({ kind: 'unavailable' });
    expect(acknowledgeOrderDelivery(record)).toBe(false);
  });
});

it('failed acknowledgement cleanup retains the record and does not remove a different authorization', () => {
  saveOrderDelivery(record);
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
  expect(acknowledgeOrderDelivery(record)).toBe(false);
  expect(loadOrderDelivery().kind).toBe('ready');
  remove.mockRestore();
  expect(acknowledgeOrderDelivery({ ...record, intent: { ...record.intent, nonce: `0x${'ab'.repeat(32)}` } })).toBe(true);
  expect(loadOrderDelivery().kind).toBe('ready');
});

 it('legacy unsigned prepared records never restore or block the next order', () => {
  sessionStorage.setItem(ORDER_DELIVERY_KEY, JSON.stringify({ ...record, state: 'prepared' }));
  expect(loadOrderDelivery()).toEqual({ kind: 'empty' });
});
 it('terminal delivery is cleaned on load and never restored or treated as an active order', () => {
  const resolved = resolveOrderDelivery(record, `0x${'ab'.repeat(32)}`);
  sessionStorage.setItem(ORDER_DELIVERY_KEY, JSON.stringify({ ...resolved, state: 'terminal' }));
  expect(loadOrderDelivery()).toEqual({ kind: 'empty' });
});

it('separate authorization slots preserve another order through acknowledgement and termination', async () => {
  const { bindingFixture } = await import('../_helpers/orderBinding');
  const { loadOrderDeliveries, terminateOrderDelivery } = await import('@/lib/orderDelivery');
  const other = bindingFixture('free', { ...order, orderId: 'other', handle: 'bob' }).record;
  const first = resolveOrderDelivery(record, `0x${'ab'.repeat(32)}`);
  const second = resolveOrderDelivery(other, `0x${'cd'.repeat(32)}`);
  expect(saveOrderDelivery(first)).toBe(true); expect(saveOrderDelivery(second)).toBe(true);
  expect(loadOrderDeliveries().records).toHaveLength(2);
  expect(acknowledgeOrderDelivery(first)).toBe(true);
  expect(loadOrderDeliveries().records).toEqual([second]);
  expect(terminateOrderDelivery(second)).toBe(true);
  expect(loadOrderDeliveries().records).toEqual([]);
});
it('an empty canonical statusToken stays bound but is absent from the flag-OFF notify payload', () => {
  const empty = { ...order, statusToken: '' };
  const withoutPickup = { ...record, order: empty, intent: { ...record.intent, nonce: orderBindSalt(orderDigest(empty), secret) } };
  const resolved = resolveOrderDelivery(withoutPickup, `0x${'ab'.repeat(32)}`);
  expect(JSON.parse(resolved.notifyBody!)).not.toHaveProperty('statusToken');
  expect(saveOrderDelivery(resolved)).toBe(true);
});

it('removes terminal slots on the next load without removing another live order', async () => {
  const { bindingFixture } = await import('../_helpers/orderBinding');
  const { orderDeliveryKey, terminateOrderDelivery, loadOrderDeliveries } = await import('@/lib/orderDelivery');
  const dead = resolveOrderDelivery(record, `0x${'ab'.repeat(32)}`);
  const next = bindingFixture('free', { ...order, orderId: 'next' }).record;
  sessionStorage.setItem(ORDER_DELIVERY_KEY, JSON.stringify(dead));
  expect(terminateOrderDelivery(dead)).toBe(true); expect(saveOrderDelivery(next)).toBe(true);
  expect(loadOrderDeliveries().records).toEqual([next]);
  expect(sessionStorage.getItem(orderDeliveryKey(dead))).toBeNull();
  expect(sessionStorage.getItem(ORDER_DELIVERY_KEY)).toBeNull();
});
