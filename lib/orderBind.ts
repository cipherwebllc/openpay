// Shared browser/server v1 schema. Only this module canonicalizes an order for binding.
// The wire snapshot is a fixed point: trimming AFTER truncation/control removal prevents
// a second server pass from changing the signed payload. NFC is explicit, before sanitation.
import { encodeAbiParameters, getAddress, isAddress, keccak256, parseAbiParameters, toHex, type Address, type Hex } from 'viem';
import { normalizeHandle, isValidHandleFormat } from '@/lib/handle';
import { isOrderTokenLike } from '@/lib/orderToken';
import { ORDER_ID_MAX, sanitizeOrderItems, sanitizeOrderMemo, sanitizeTable } from '@/lib/orderRelay';

export type CanonicalOrder = {
  chainId: number;
  tokenAddress: Address;
  merchant: Address;
  handle: string;
  orderId: string;
  items: { name: string; qty: number; price: string }[];
  pickupAt: number;
  statusToken: string;
  customerMemo: string;
  description: string;
};
export type OrderBind = { v: 1; secret: Hex; validAfter: string; validBefore: string };
export const ORDER_BIND_TAG = keccak256(toHex('openpay.order-bind.v1'));
const SALT_TAG = keccak256(toHex('openpay.order-bind.salt.v1'));
// Fixed absent values: items=[], optional strings='', pickupAt=0. Price stays a string.
const SCHEMA = parseAbiParameters('bytes32,uint256,address,address,string,string,(string name,uint256 qty,string price)[],uint256,string,string,string');
const nfc = (value: unknown) => typeof value === 'string' ? value.normalize('NFC') : value;
// sanitizeOrderItems/Table truncate UTF-16. Drop a dangling high surrogate so encoding does
// not replace it on one side of the browser→JSON→server boundary only.
const finalText = (value: string) => value.replace(/[\uD800-\uDBFF]$/, '').trim().normalize('NFC');

export function canonicalOrder(input: Record<string, unknown>): CanonicalOrder {
  const handle = normalizeHandle(typeof input.handle === 'string' ? input.handle.normalize('NFC') : '');
  if (!Number.isSafeInteger(input.chainId) || Number(input.chainId) <= 0 ||
    typeof input.tokenAddress !== 'string' || !isAddress(input.tokenAddress) ||
    typeof input.merchant !== 'string' || !isAddress(input.merchant) ||
    !isValidHandleFormat(handle) || typeof input.orderId !== 'string' || !input.orderId.trim()) {
    throw new Error('order_binding_mismatch');
  }
  const statusToken = input.statusToken ?? '';
  if (statusToken !== '' && !isOrderTokenLike(statusToken)) throw new Error('order_binding_mismatch');
  const pickupAt = input.pickupAt ?? 0;
  if (typeof pickupAt !== 'number' || !Number.isSafeInteger(pickupAt) || pickupAt < 0) throw new Error('order_binding_mismatch');
  const orderId = finalText(input.orderId.normalize('NFC').trim().slice(0, ORDER_ID_MAX));
  if (!orderId) throw new Error('order_binding_mismatch');
  const rawItems = Array.isArray(input.items) ? input.items.map((item: unknown) => {
    if (!item || typeof item !== 'object') return item;
    const o = item as Record<string, unknown>;
    return { ...o, name: nfc(o.name) };
  }) : input.items;
  return {
    chainId: Number(input.chainId),
    tokenAddress: getAddress(input.tokenAddress).toLowerCase() as Address,
    merchant: getAddress(input.merchant).toLowerCase() as Address,
    handle,
    orderId,
    items: sanitizeOrderItems(rawItems).map(({ name, qty, price }) => ({ name: finalText(name), qty, price })).filter((item) => item.name.length > 0),
    pickupAt,
    statusToken: statusToken as string,
    customerMemo: finalText(sanitizeOrderMemo(nfc(input.customerMemo)) ?? ''),
    description: finalText(sanitizeTable(nfc(input.description)) ?? ''),
  };
}

// Input is the canonical snapshot, never a second sanitization pass inside the digest.
export function orderDigest(order: CanonicalOrder): Hex {
  return keccak256(encodeAbiParameters(SCHEMA, [
    ORDER_BIND_TAG, BigInt(order.chainId), order.tokenAddress, order.merchant,
    order.handle, order.orderId, order.items.map((item) => ({ ...item, qty: BigInt(item.qty) })),
    BigInt(order.pickupAt), order.statusToken, order.customerMemo, order.description,
  ]));
}
export function orderBindSalt(digest: Hex, secret: Hex): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,bytes32'), [SALT_TAG, digest, secret]));
}
export function isUint256Decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
}
export function parseOrderBind(value: unknown): OrderBind | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (o.v !== 1 || typeof o.secret !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.secret) ||
    !isUint256Decimal(o.validAfter) || !isUint256Decimal(o.validBefore) || BigInt(o.validBefore) <= BigInt(o.validAfter)) return null;
  return { v: 1, secret: o.secret as Hex, validAfter: o.validAfter, validBefore: o.validBefore };
}
