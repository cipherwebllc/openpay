import { describe, expect, it } from 'vitest';
import { canonicalOrder, orderDigest, orderBindSalt, parseOrderBind } from '@/lib/orderBind';

export const orderInput = {
  chainId: 80002,
  tokenAddress: '0x0000000000000000000000000000000000000abc',
  merchant: '0x1111111111111111111111111111111111111111',
  handle: 'Alice', orderId: 'order-1',
  items: [{ name: 'Cafe\u0301', qty: 2, price: '01.00' }],
  description: 'Table 1', pickupAt: 1800000000000,
  statusToken: 's'.repeat(43), customerMemo: ' No ice ',
};
const secret = `0x${'12'.repeat(32)}` as const;

describe('A2c canonical order binding', () => {
  it('fixes the versioned ABI golden vector', () => {
    expect(orderDigest(canonicalOrder(orderInput))).toBe('0xa604da5b53a869469e68109ae2e4ce47367ba3458370a494ee233e8a366f0e09');
  });
  it('normalizes NFC and handle case explicitly', () => {
    expect(canonicalOrder(orderInput)).toEqual(canonicalOrder({ ...orderInput, handle: 'alice', items: [{ name: 'Café', qty: 2, price: '01.00' }] }));
  });
  it('survives the actual client JSON server path including non-idempotent sanitizer edges', () => {
    const client = canonicalOrder({ ...orderInput, items: [{ name: `${'x'.repeat(79)} y`, qty: '1000', price: '01.00' }], description: `${'t'.repeat(63)} rest`, customerMemo: `\u0000 ${'m'.repeat(118)} rest` });
    const server = canonicalOrder(JSON.parse(JSON.stringify(client)));
    expect(server).toEqual(client);
    expect(orderDigest(server)).toBe(orderDigest(client));
  });
  it.each([
    { chainId: 137 }, { tokenAddress: '0x2222222222222222222222222222222222222222' },
    { merchant: '0x2222222222222222222222222222222222222222' }, { handle: 'bob' },
    { orderId: 'other' }, { items: [{ name: 'Café', qty: 2, price: '1' }] },
    { pickupAt: 1800000000001 }, { statusToken: 't'.repeat(43) },
    { customerMemo: 'other' }, { description: 'Table 2' },
  ])('commits every fulfillment field: %j', (change) => {
    expect(orderDigest(canonicalOrder({ ...orderInput, ...change }))).not.toBe(orderDigest(canonicalOrder(orderInput)));
  });
  it('excludes transport fields and keeps absolute pickup milliseconds', () => {
    const order = canonicalOrder({ ...orderInput, ts: 1, blockNumber: '2', feeTxHash: 'ignored' });
    expect(order.pickupAt).toBe(1800000000000);
    expect(orderDigest(order)).toBe(orderDigest(canonicalOrder(orderInput)));
  });
  it('a copied public salt cannot open a different order', () => {
    const digest = orderDigest(canonicalOrder(orderInput));
    const salt = orderBindSalt(digest, secret);
    expect(orderBindSalt(digest, salt)).not.toBe(salt);
    expect(orderBindSalt(orderDigest(canonicalOrder({ ...orderInput, orderId: 'stolen' })), secret)).not.toBe(salt);
  });
  it.each([null, {}, { v: 2, secret, validAfter: '0', validBefore: '1' }, { v: 1, secret }, { v: 1, secret, validAfter: '-1', validBefore: '1' }, { v: 1, secret, validAfter: '0', validBefore: String(2n ** 256n) }])('rejects malformed present binding %j', (bind) => {
    expect(parseOrderBind(bind)).toBeNull();
  });
});

it('NFC remains stable when removing memo controls creates a combining sequence', () => {
  const canonical = canonicalOrder({ ...orderInput, customerMemo: 'e\u0000\u0301' });
  expect(canonical.customerMemo).toBe('é');
  expect(canonicalOrder(JSON.parse(JSON.stringify(canonical)))).toEqual(canonical);
});
