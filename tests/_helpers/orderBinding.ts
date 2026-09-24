import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from 'viem';
import { canonicalOrder, orderBindSalt, orderDigest } from '@/lib/orderBind';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import type { FeeReceiptLog } from '@/lib/feeVerify';
import type { OrderDelivery } from '@/lib/orderDelivery';
export const BIND_FORWARDER: Address = '0x3333333333333333333333333333333333333333';
export const BIND_PAYER: Address = '0x2222222222222222222222222222222222222222';
export const BIND_FEE: Address = '0x1111111111111111111111111111111111111111';
export const BIND_SECRET = `0x${'12'.repeat(32)}` as Hex;
export const BIND_TX = `0x${'ab'.repeat(32)}` as Hex;
const ABI = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);
export function bindTransfer(token: Address, from: Address, to: Address, value: bigint): FeeReceiptLog {
  return { address: token, topics: encodeEventTopics({ abi: ABI, eventName: 'Transfer', args: { from, to } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}
export function bindingFixture(mode: 'free' | 'recover', input: Record<string, unknown>, value = 1000n * 10n ** 18n, feeValue = 13n * 10n ** 18n) {
  const order = canonicalOrder(input);
  // Intentionally expired: mined authorizations must use their original window, not wall-clock expiry.
  const bind = { v: 1 as const, secret: BIND_SECRET, validAfter: '0', validBefore: '1700000000' };
  const salt = orderBindSalt(orderDigest(order), bind.secret);
  const nonce = mode === 'free' ? salt : buildForwarderNonce({ from: BIND_PAYER, merchant: order.merchant, merchantValue: value, feeReceiver: BIND_FEE, feeValue, validAfter: 0n, validBefore: BigInt(bind.validBefore), intentSalt: salt }, order.chainId, BIND_FORWARDER);
  const auth: FeeReceiptLog = { address: order.tokenAddress, topics: encodeEventTopics({ abi: ABI, eventName: 'AuthorizationUsed', args: { authorizer: BIND_PAYER, nonce } }) as Hex[], data: '0x' };
  const settled: FeeReceiptLog = { address: BIND_FORWARDER, topics: encodeEventTopics({ abi: ABI, eventName: 'Settled', args: { from: BIND_PAYER, nonce, merchant: order.merchant } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [value, BIND_FEE, feeValue]) };
  const logs = mode === 'free' ? [auth, bindTransfer(order.tokenAddress, BIND_PAYER, order.merchant, value)] : [auth, bindTransfer(order.tokenAddress, BIND_PAYER, BIND_FORWARDER, value + feeValue), bindTransfer(order.tokenAddress, BIND_FORWARDER, order.merchant, value), bindTransfer(order.tokenAddress, BIND_FORWARDER, BIND_FEE, feeValue), settled];
  const record: OrderDelivery = { version: 1, order, bind, state: 'signed', forwarder: mode === 'recover' ? BIND_FORWARDER : null, ...(mode === 'recover' ? { feeReceiver: BIND_FEE } : {}), intent: { chainId: order.chainId, from: BIND_PAYER, merchant: order.merchant, merchantValue: value.toString(), feeValue: mode === 'recover' ? feeValue.toString() : '0', nonce, routeKind: mode, validBefore: bind.validBefore, issuedAt: 1699990000000 } };
  return { order, bind, salt, nonce, logs, record, body: { ...order, token: 'jpyc', txHash: BIND_TX, bind } };
}
