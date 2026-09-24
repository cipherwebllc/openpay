'use client';

import { isAddress, type Address, type Hex } from 'viem';
import { canonicalOrder, isUint256Decimal, orderBindSalt, orderDigest, parseOrderBind, type CanonicalOrder, type OrderBind } from '@/lib/orderBind';
import type { RelayIntentMetadata } from '@/lib/paymentIntentStorage';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';

export { matchesOrderDeliveryContext } from '@/lib/orderDeliveryContext';

export const ORDER_DELIVERY_KEY = 'openpay:undelivered-order:v1';
export type OrderDelivery = {
  version: 1;
  order: CanonicalOrder;
  bind: OrderBind;
  intent: RelayIntentMetadata;
  forwarder: Address | null;
  feeReceiver?: Address;
  state: 'signed' | 'notify-pending' | 'terminal';
  txHash?: Hex;
  notifyBody?: string;
};
const hex32 = (s: unknown): s is Hex => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
const address = (s: unknown): s is Address => typeof s === 'string' && isAddress(s);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function sameOrderAuthorization(record: OrderDelivery, intent: RelayIntentMetadata): boolean {
  return record.intent.chainId === intent.chainId && same(record.intent.from, intent.from) &&
    same(record.intent.nonce, intent.nonce) && same(record.intent.merchant, intent.merchant) &&
    record.intent.merchantValue === intent.merchantValue && record.intent.feeValue === intent.feeValue &&
    record.intent.validBefore === intent.validBefore && record.intent.routeKind === intent.routeKind;
}
function bodyFor(record: OrderDelivery, txHash: Hex): string {
  const { tokenAddress: _tokenAddress, handle: _handle, ...order } = record.order;
  return JSON.stringify({ type: 'openpay.checkout.success', mode: 'relay', token: 'jpyc',
    ...order, statusToken: order.statusToken || undefined, from: record.intent.from, txHash, bind: record.bind, ts: record.intent.issuedAt });
}
export function resolveOrderDelivery(record: OrderDelivery, txHash: Hex): OrderDelivery {
  return { ...record, state: 'notify-pending', txHash, notifyBody: bodyFor(record, txHash) };
}
function parseRecord(value: unknown): OrderDelivery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as OrderDelivery;
  if (o.version !== 1 || !o.order || !o.intent || !parseOrderBind(o.bind) ||
    (o.state !== 'signed' && o.state !== 'notify-pending' && o.state !== 'terminal')) return null;
  const canonical = canonicalOrder(o.order);
  if (JSON.stringify(canonical) !== JSON.stringify(o.order)) return null;
  const i = o.intent;
  if (i.chainId !== canonical.chainId || !address(i.from) || !address(i.merchant) ||
    !same(i.merchant, canonical.merchant) || !hex32(i.nonce) ||
    !isUint256Decimal(i.merchantValue) || BigInt(i.merchantValue) <= 0n || !isUint256Decimal(i.feeValue) ||
    i.validBefore !== o.bind.validBefore || !Number.isSafeInteger(i.issuedAt) || i.issuedAt <= 0) return null;
  const salt = orderBindSalt(orderDigest(canonical), o.bind.secret);
  if (i.routeKind === 'free') {
    if (o.forwarder !== null || i.feeValue !== '0' || !same(i.nonce, salt)) return null;
  } else if (i.routeKind === 'recover' && address(o.forwarder)) {
    // The original fee receiver is part of the signed commitment, not today's config.
    if (!address(o.feeReceiver)) return null;
    const feeReceiver = o.feeReceiver!;
    if (!same(i.nonce, buildForwarderNonce({ from: i.from, merchant: i.merchant,
      merchantValue: BigInt(i.merchantValue), feeReceiver, feeValue: BigInt(i.feeValue),
      validAfter: BigInt(o.bind.validAfter), validBefore: BigInt(o.bind.validBefore), intentSalt: salt,
    }, i.chainId, o.forwarder))) return null;
  } else return null;
  if (o.state !== 'signed') {
    if (!hex32(o.txHash) || o.notifyBody !== bodyFor(o, o.txHash)) return null;
  } else if (o.txHash !== undefined || o.notifyBody !== undefined) return null;
  return o;
}
// Each authorization owns a slot. A failed delivery for another order must not block payment.
export function orderDeliveryKey(record: OrderDelivery): string {
  return `${ORDER_DELIVERY_KEY}:${record.order.chainId}:${record.order.tokenAddress.toLowerCase()}:${record.intent.from.toLowerCase()}:${record.intent.nonce.toLowerCase()}`;
}
export function loadOrderDeliveries(): { records: OrderDelivery[]; unavailable: boolean } {
  const records = new Map<string, OrderDelivery | null>();
  const terminals = new Map<string, OrderDelivery>();
  let unavailable = false;
  try {
    const keys = [ORDER_DELIVERY_KEY];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(`${ORDER_DELIVERY_KEY}:`)) keys.push(key);
    }
    for (const key of keys) {
      try {
        const raw = window.sessionStorage.getItem(key);
        if (raw === null) continue;
        const value = JSON.parse(raw);
        // Legacy prepared records may be unsigned; never recover an abandoned wallet prompt.
        if (value?.version === 1 && value.state === 'prepared') continue;
        const record = parseRecord(value);
        if (!record || (key !== ORDER_DELIVERY_KEY && key !== orderDeliveryKey(record))) throw new Error('invalid_order_delivery');
        records.set(orderDeliveryKey(record), record.state === 'terminal' ? null : record);
        if (record.state === 'terminal') terminals.set(key, record);
      } catch {
        // Corrupt slots are isolated: do not fabricate their opening or hide valid other orders.
        // An invalid newer slot must also prevent falling back to its stale legacy record.
        records.set(key, null);
        unavailable = true;
      }
    }
    for (const [key, record] of terminals) {
      if (records.get(orderDeliveryKey(record)) === null) {
        // Remove a terminal slot together with its legacy copy so cleanup cannot resurrect it.
        if (!acknowledgeOrderDelivery(record)) unavailable = true;
      } else {
        // A newer live slot supersedes this legacy terminal; remove only the obsolete copy.
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Storage denial must be observable without substituting a different checkout's payment.
    unavailable = true;
  }
  return { records: [...records.values()].filter((r): r is OrderDelivery => r !== null)
    .sort((a, b) => b.intent.issuedAt - a.intent.issuedAt), unavailable };
}
export function loadOrderDelivery(intent?: RelayIntentMetadata): { kind: 'empty' } | { kind: 'unavailable' } | { kind: 'ready'; record: OrderDelivery } {
  const loaded = loadOrderDeliveries();
  const record = intent ? loaded.records.find((r) => sameOrderAuthorization(r, intent)) : loaded.records[0];
  return record ? { kind: 'ready', record } : loaded.unavailable ? { kind: 'unavailable' } : { kind: 'empty' };
}
export function saveOrderDelivery(record: OrderDelivery): boolean {
  try {
    if (!parseRecord(record)) return false;
    const key = orderDeliveryKey(record);
    const raw = window.sessionStorage.getItem(key);
    if (raw !== null) {
      const existing = parseRecord(JSON.parse(raw));
      // Updating one nonce cannot overwrite an opening for a different authorization window.
      if (!existing || !sameOrderAuthorization(existing, record.intent)) return false;
    }
    window.sessionStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    // Storage failure must stop a new bound payment, but never turn a mined payment into failure.
    return false;
  }
}
export function acknowledgeOrderDelivery(record: OrderDelivery): boolean {
  try {
    for (const key of [ORDER_DELIVERY_KEY, orderDeliveryKey(record)]) {
      const raw = window.sessionStorage.getItem(key);
      if (raw === null) continue;
      const stored = parseRecord(JSON.parse(raw));
      if (!stored || !sameOrderAuthorization(stored, record.intent)) {
        if (key !== ORDER_DELIVERY_KEY) return false;
        continue;
      }
      window.sessionStorage.removeItem(key);
    }
    return true;
  } catch {
    // Cleanup failure retains the opening; another order's slot is never removed.
    return false;
  }
}
// Only call for proven non-broadcast, reverted, or expired-unused authorizations.
export const abandonOrderDelivery = acknowledgeOrderDelivery;

export function terminateOrderDelivery(record: OrderDelivery): boolean {
  // A terminal slot shadows a matching legacy record and leaves every other nonce untouched.
  return saveOrderDelivery({ ...record, state: 'terminal' });
}
