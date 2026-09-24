import { describe, expect, it } from 'vitest';
import { matchesOrderDeliveryContext, type OrderDeliveryContext } from '@/lib/orderDeliveryContext';
import { bindingFixture } from '../_helpers/orderBinding';
const origin = 'https://open-pay.test';
const order = bindingFixture('free', { chainId: 80002, tokenAddress: '0x0000000000000000000000000000000000000abc', merchant: '0x1111111111111111111111111111111111111111', handle: 'alice', orderId: 'saved', items: [] }).order;
const intent = { merchantValue: '1000', feeValue: '0' };
const context: OrderDeliveryContext = { merchant: order.merchant, tokenAddress: order.tokenAddress, chainId: order.chainId, orderId: order.orderId, webhook: `${origin}/api/order/notify?h=alice`, totalValue: 1000n };
describe('checkout delivery context', () => {
  it('matches the same checkout, allowing an omitted orderId and address case differences', () => {
    expect(matchesOrderDeliveryContext(order, context, origin, intent)).toBe(true);
    expect(matchesOrderDeliveryContext(order, { ...context, orderId: undefined, tokenAddress: order.tokenAddress.toUpperCase() }, origin, intent)).toBe(true);
  });
  it.each(['Alice', '%40alice'])('normalizes handle %s before matching', (h) => {
    expect(matchesOrderDeliveryContext(order, { ...context, webhook: `${origin}/api/order/notify?h=${h}` }, origin, intent)).toBe(true);
  });
  it.each([
    { merchant: '0x2222222222222222222222222222222222222222' }, { chainId: 137 },
    { tokenAddress: '0x0000000000000000000000000000000000000def' }, { orderId: 'new' },
    { webhook: undefined }, { webhook: 'invalid' }, { webhook: 'https://third.example/api/order/notify?h=alice' },
    { webhook: `${origin}/api/order/notify/extra?h=alice` }, { webhook: `${origin}/api/order/notify?h=bob` },
    { webhook: `${origin}/api/order/notify?h=alice&h=alice` },
  ])('rejects mismatching checkout context %j', (change) => {
    expect(matchesOrderDeliveryContext(order, { ...context, ...change }, origin, intent)).toBe(false);
  });
});

it('payment amount must equal merchantValue plus feeValue', () => {
  const intent = { merchantValue: '1000', feeValue: '13' };
  const exact = { ...context, totalValue: 1013n };
  expect(matchesOrderDeliveryContext(order, exact, origin, intent)).toBe(true);
  expect(matchesOrderDeliveryContext(order, { ...exact, totalValue: 1000n }, origin, intent)).toBe(false);
});
