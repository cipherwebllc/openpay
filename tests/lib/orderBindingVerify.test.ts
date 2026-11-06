import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyOrderBinding, orderBindEnforced } from '@/lib/order/orderBindingVerify';
import { bindingFixture, BIND_FORWARDER, BIND_FEE, bindTransfer } from '../_helpers/orderBinding';
vi.mock('@/lib/relay/forwarderConfig', async (original) => ({ ...await original<typeof import('@/lib/relay/forwarderConfig')>(), configuredJpycForwarderFor: () => '0x3333333333333333333333333333333333333333' }));
const input = { chainId: 80002, tokenAddress: '0x0000000000000000000000000000000000000abc', merchant: '0x9999999999999999999999999999999999999999', handle: 'alice', orderId: 'test', items: [{ name: 'Tea', qty: 1, price: '1000' }], description: 'Table 1', statusToken: 's'.repeat(43) };
afterEach(() => vi.unstubAllEnvs());
function check(f: ReturnType<typeof bindingFixture>, logs = f.logs, body: Record<string, unknown> = f.body) {
  return verifyOrderBinding({ body, chainId: f.order.chainId, merchant: f.order.merchant, token: f.order.tokenAddress, handle: 'alice', logs, feeReceiver: BIND_FEE });
}
describe('A2c receipt attribution and downgrade fences', () => {
  it('flag is server-only and default OFF; accepts both documented project boolean forms', () => {
    vi.stubEnv('ENABLE_ORDER_BIND_ENFORCE', undefined); expect(orderBindEnforced()).toBe(false);
    vi.stubEnv('ENABLE_ORDER_BIND_ENFORCE', '1'); expect(orderBindEnforced()).toBe(true);
    vi.stubEnv('ENABLE_ORDER_BIND_ENFORCE', 'true'); expect(orderBindEnforced()).toBe(true);
  });
  it.each(['free', 'recover'] as const)('%s malformed/missing evidence never falls into standard residual', (mode) => {
    const f = bindingFixture(mode, input);
    const { bind: _bind, ...absent } = f.body;
    expect(check(f, f.logs.map((l, i) => i === 0 ? { ...l, address: BIND_FEE } : l), absent)).toEqual(mode === 'recover' ? { ok: false, reason: 'settlement_unmatched' } : { ok: true, kind: 'standard' });
    expect(check(f, f.logs.map((l, i) => i === 0 ? { ...l, topics: l.topics.slice(0, 2) } : l), absent)).toEqual({ ok: false, reason: mode === 'recover' ? 'settlement_unmatched' : 'free_ambiguous' });
    expect(check(f, f.logs.filter((_, i) => i !== 0), f.body)).toEqual({ ok: false, reason: mode === 'recover' ? 'settlement_unmatched' : 'bind_on_standard' });
  });
  it('a fake forwarder Settled cannot establish a valid recover opening', () => {
    const f = bindingFixture('recover', input);
    expect(check(f, f.logs.map((log) => log.address === BIND_FORWARDER ? { ...log, address: BIND_FEE } : log))).toEqual({ ok: false, reason: 'free_ambiguous' });
  });
  it('multiple free authorizations cannot borrow an unrelated merchant transfer', () => {
    const f = bindingFixture('free', input);
    const other = bindingFixture('free', { ...input, orderId: 'other' });
    expect(check(f, [f.logs[0], other.logs[0], other.logs[1]])).toEqual({ ok: false, reason: 'free_ambiguous' });
  });
  it('recover selects its own authorizer/nonce/settlement and fee; unrelated money is excluded', () => {
    const f = bindingFixture('recover', input, 50n * 10n ** 18n);
    const other = bindingFixture('recover', { ...input, orderId: 'other' }, 9000n * 10n ** 18n);
    expect(check(f, [...other.logs, ...f.logs])).toMatchObject({ ok: true, value: 50n * 10n ** 18n, sameSourceFeeValue: 13n * 10n ** 18n });
    expect(check(f, [...other.logs, ...f.logs.filter((_, i) => i !== 0)])).toEqual({ ok: false, reason: 'settlement_unmatched' });
  });
  it('a bound dust settlement cannot use another payment to reach the floor', () => {
    const f = bindingFixture('recover', input, 1n);
    const other = bindingFixture('recover', { ...input, orderId: 'other' });
    expect(check(f, [...other.logs, ...f.logs])).toEqual({ ok: false, reason: 'below_dust' });
  });
  it('recover missing Settled cannot downgrade even if bind was entirely omitted while OFF', () => {
    const f = bindingFixture('recover', input);
    const { bind: _bind, ...body } = f.body;
    expect(check(f, f.logs.slice(0, -1), body)).toEqual({ ok: false, reason: 'free_ambiguous' });
  });
  it('standard receipt remains unbound even with enforcement ON, never displays bindingMissing as cryptographic proof', () => {
    vi.stubEnv('ENABLE_ORDER_BIND_ENFORCE', 'true');
    const f = bindingFixture('free', input);
    const { bind: _bind, ...body } = f.body;
    expect(check(f, [bindTransfer(f.order.tokenAddress, BIND_FEE, f.order.merchant, 1000n)], body)).toEqual({ ok: true, kind: 'standard' });
  });
});

it('ignores fake emitters in an otherwise standard transfer without pretending they prove a binding', () => {
  const f = bindingFixture('free', input);
  const { bind: _bind, ...body } = f.body;
  const logs = [{ ...f.logs[0], address: BIND_FEE }, f.logs[1]];
  expect(check(f, logs, body)).toEqual({ ok: true, kind: 'standard' });
  expect(check(f, logs)).toEqual({ ok: false, reason: 'bind_on_standard' });
});

// The reason is a server-log label only (route warn order.notify.binding_rejected・DEPLOY_CHECKLIST §13.7): one per
// existing rejecting return, never a new condition. Pin the labels not already pinned by the fences above.
it('labels each remaining rejecting return without changing which inputs are rejected', () => {
  const free = bindingFixture('free', input);
  const recover = bindingFixture('recover', input);
  const { bind: _bind, ...absent } = free.body;
  expect(verifyOrderBinding({ body: free.body, chainId: free.order.chainId, merchant: free.order.merchant, token: free.order.tokenAddress, handle: 'alice', logs: undefined, feeReceiver: BIND_FEE }))
    .toEqual({ ok: false, reason: 'receipt_logs_missing' });
  expect(check(free, free.logs, { ...free.body, bind: { v: 2 } })).toEqual({ ok: false, reason: 'bind_malformed' });
  expect(check(free, free.logs, { ...free.body, orderId: ' ' })).toEqual({ ok: false, reason: 'order_malformed' });
  expect(check(free, free.logs, { ...free.body, items: [{ name: 'stolen', qty: 1, price: '1000' }] })).toEqual({ ok: false, reason: 'free_unmatched' });
  expect(check(recover, recover.logs.filter((_, i) => i !== 2))).toEqual({ ok: false, reason: 'settlement_transfer_unmatched' });
  expect(check(free, free.logs, absent)).toMatchObject({ ok: true, kind: 'relay', bindingMissing: true });
  vi.stubEnv('ENABLE_ORDER_BIND_ENFORCE', 'true');
  expect(check(free, free.logs, absent)).toEqual({ ok: false, reason: 'bind_required' });
});
