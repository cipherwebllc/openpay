import 'server-only';
import { keccak256, toHex, type Address } from 'viem';
import type { FeeReceiptLog } from '@/lib/feeVerify';
import { canonicalOrder, orderDigest, orderBindSalt, parseOrderBind, type CanonicalOrder } from '@/lib/orderBind';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { receiptAuthorizations, receiptSettlements, receiptTokenTransfers } from '@/lib/order/agentOrderReceipt';
import { ORDER_DUST_FLOOR_WEI } from '@/lib/orderRelay';

export function orderBindEnforced(): boolean {
  return process.env.ENABLE_ORDER_BIND_ENFORCE === 'true' || process.env.ENABLE_ORDER_BIND_ENFORCE === '1';
}
const AUTH_TOPIC = keccak256(toHex('AuthorizationUsed(address,bytes32)'));
const SETTLED_TOPIC = keccak256(toHex('Settled(address,bytes32,address,uint256,address,uint256)'));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Missing receipt logs must not let a deferred fee follow-up downgrade relay to standard.
export function receiptHasRelayEvidence(chainId: number, token: Address, logs: readonly FeeReceiptLog[] | undefined): boolean {
  if (!logs) return true;
  const forwarder = configuredJpycForwarderFor(chainId);
  const transfers = receiptTokenTransfers(logs, token);
  return logs.some((log) => (same(log.address, token) && same(log.topics[0] ?? '', AUTH_TOPIC)) ||
    (!!forwarder && same(log.address, forwarder) && same(log.topics[0] ?? '', SETTLED_TOPIC))) ||
    !!forwarder && transfers.some((t) => same(t.from, forwarder) || same(t.to, forwarder));
}

type Result = { ok: false } | {
  ok: true;
  kind: 'standard' | 'relay';
  bindingMissing?: true;
  order?: CanonicalOrder;
  digest?: string;
  value?: bigint;
  sameSourceFeeValue?: bigint;
};
// Caller already verified receipt success and merchant transfer. Never infer the route from
// body.mode, tx sender, a live fee schedule, or an expired authorization's current validity.
export function verifyOrderBinding(args: {
  body: Record<string, unknown>; handle: string; chainId: number; token: Address;
  merchant: Address; logs: readonly FeeReceiptLog[] | undefined; feeReceiver?: Address;
}): Result {
  const { body, logs, token, merchant, chainId } = args;
  if (!logs) return { ok: false }; // Missing receipt evidence must not downgrade relay to standard.
  const present = Object.hasOwn(body, 'bind');
  const bind = present ? parseOrderBind(body.bind) : null;
  if (present && !bind) return { ok: false };
  const forwarder = configuredJpycForwarderFor(chainId);
  const auths = receiptAuthorizations(logs, token);
  const settlements = forwarder ? receiptSettlements(logs, forwarder) : [];
  const transfers = receiptTokenTransfers(logs, token);
  const relayEvidence = receiptHasRelayEvidence(chainId, token, logs);
  if (!relayEvidence) return present ? { ok: false } : { ok: true, kind: 'standard' };
  if (!bind && orderBindEnforced()) return { ok: false };
  let order: CanonicalOrder | undefined;
  let digest: ReturnType<typeof orderDigest> | undefined;
  if (bind) {
    try {
      order = canonicalOrder({ ...body, handle: args.handle, tokenAddress: token, merchant, chainId });
      digest = orderDigest(order);
    } catch {
      // Malformed order fields must not become a server error or bypass binding verification.
      return { ok: false };
    }
  }
  const salt = bind && digest ? orderBindSalt(digest, bind.secret) : null;
  const verified = (value: bigint, fee: bigint): Result => value < ORDER_DUST_FLOOR_WEI
    ? { ok: false }
    : { ok: true, kind: 'relay', value, sameSourceFeeValue: fee,
      ...(order ? { order, digest } : { bindingMissing: true as const }) };
  if (settlements.length > 0 && forwarder) {
    const matches = settlements.filter((s) => same(s.merchant, merchant) &&
      auths.some((a) => same(a.authorizer, s.from) && same(a.nonce, s.nonce)) &&
      (!bind || same(buildForwarderNonce({
        ...s, validAfter: BigInt(bind.validAfter), validBefore: BigInt(bind.validBefore), intentSalt: salt!,
      }, chainId, forwarder), s.nonce)));
    // Multiple matching settlements cannot be assigned to one public order. For a selected
    // trusted settlement use ONLY its amount/fee, never other customers' receipt-wide totals.
    if (matches.length !== 1) return { ok: false };
    const s = matches[0];
    if (!transfers.some((t) => same(t.from, forwarder) && same(t.to, merchant) && t.value === s.merchantValue)) return { ok: false };
    return verified(s.merchantValue, args.feeReceiver && same(args.feeReceiver, s.feeReceiver) ? s.feeValue : 0n);
  }
  // Free mode has no recipient in AuthorizationUsed. Reject ambiguous batches rather than
  // attributing an unrelated transfer to the nonce. A forwarder leg without Settled is not free.
  if (auths.length !== 1 || transfers.length !== 1 ||
    logs.some((log) => !!forwarder && same(log.address, forwarder) && same(log.topics[0] ?? '', SETTLED_TOPIC))) return { ok: false };
  const auth = auths[0];
  const transfer = transfers[0];
  if (!same(transfer.from, auth.authorizer) || !same(transfer.to, merchant) ||
    (forwarder && (same(transfer.from, forwarder) || same(transfer.to, forwarder))) ||
    (salt && !same(auth.nonce, salt))) return { ok: false };
  return verified(transfer.value, 0n);
}
