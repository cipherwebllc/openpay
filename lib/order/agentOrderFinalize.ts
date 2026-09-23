import 'server-only';

import { randomBytes } from 'node:crypto';
import { after } from 'next/server';
import { createPublicClient, type Hex } from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { kvEval, kvSetNxGet } from '@/lib/kv';
import { verifyJpycTransferToOnChain } from '@/lib/feeVerify';
import { logger } from '@/lib/logger';
import { recordMetric } from '@/lib/metrics';
import { notifyPaymentReceived } from '@/lib/push/notify';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { legacyBillingPaymentKey, paymentClaimKey, paymentClaimResultValue } from '@/lib/paymentClaim';
import { declaredItemsTotalMinor, evaluateOrderAmount, orderListKey, orderUsedKey, sanitizeOrderItems, sanitizeTable, serializeOrder, ORDER_DUST_FLOOR_WEI, ORDER_LIST_MAX, ORDER_LIST_TTL_SEC, ORDER_PENDING_TTL_SEC, type StoredOrder } from '@/lib/orderRelay';
import { parseAgentOrderSettlement, type AgentOrderSettlement } from '@/lib/x402/agentOrderRecovery';
import { agentCompletionKey, agentTransactionKey, readAgentOrderReservation, type AgentOrderReservation } from './agentOrderReservation';
import { matchesAgentSettlement } from './agentOrderReceipt';
import { standardFeeObligationFromReceipt } from './orderFeeObligation';

// KEYS: reservation, authorization completion, public tx claim, agent tx marker, list,
// global fee claim, legacy fee claim. ARGV: immutable reservation, owner, digest, unpaid order,
// paid order, inline fee flag, fee claim value, list limit, list TTL.
// Redis Lua does not roll back runtime errors: validate every type/argument and decode before
// the first write. JSON orders remain bytes, without cjson table aliases or null conversion.
const SAVE = [
  "for i=1,7 do local t=redis.call('TYPE',KEYS[i]).ok; local want='string'; if i==5 then want='list' end; if t~='none' and t~=want then return -2 end end",
  "if redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end",
  "local complete=redis.call('GET',KEYS[2]); if complete==ARGV[3] then return 2 end; if complete~=ARGV[2] then return 0 end",
  "local public=redis.call('GET',KEYS[3]); if public and public~='done' then return 0 end",
  "if public=='done' and redis.call('GET',KEYS[4])~='agent' then return -1 end",
  "local limit=tonumber(ARGV[8]); local ttl=tonumber(ARGV[9]); if not limit or limit<1 or not ttl or ttl<1 then return -2 end",
  "local ok,order=pcall(cjson.decode,ARGV[4]); if not ok or type(order)~='table' or not order.orderId then return -2 end",
  "local paidOk,paid=pcall(cjson.decode,ARGV[5]); if not paidOk or type(paid)~='table' or paid.orderId~=order.orderId then return -2 end",
  "local inline=ARGV[6]=='1' and redis.call('EXISTS',KEYS[6])==0 and redis.call('EXISTS',KEYS[7])==0",
  // LPUSH precedes completion. Type/ARGV preflight above removes deterministic partial errors.
  "if inline then redis.call('LPUSH',KEYS[5],ARGV[5]); redis.call('SET',KEYS[6],ARGV[7]); else redis.call('LPUSH',KEYS[5],ARGV[4]); end",
  "redis.call('LTRIM',KEYS[5],0,limit-1); redis.call('EXPIRE',KEYS[5],ttl)",
  "redis.call('SET',KEYS[4],'agent'); redis.call('SET',KEYS[3],'done'); redis.call('SET',KEYS[2],ARGV[3]); return 1",
].join('\n');
const RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0";

export type AgentOrderFinalizeResult = { ok: true; duplicate: boolean } | { ok: false; reason: 'processing' | 'conflict' | 'storage_unavailable' | 'settlement_mismatch' };

export async function finalizeAgentOrder(input: { reservation: AgentOrderReservation; settlement: AgentOrderSettlement }): Promise<AgentOrderFinalizeResult> {
  const { reservation, settlement } = input;
  // Re-read immutable ownership after settlement: redelivery promotion may have conflicted.
  const stored = await readAgentOrderReservation(reservation.key);
  if (stored.kind !== 'match' || stored.reservation.raw !== reservation.raw) return { ok: false, reason: stored.kind === 'unavailable' ? 'storage_unavailable' : 'conflict' };
  const { snapshot, tuple, digest, feeConfig } = stored.reservation.record;
  if (!parseAgentOrderSettlement(settlement, snapshot)) return { ok: false, reason: 'settlement_mismatch' };
  const completionKey = agentCompletionKey(reservation.key);
  const owner = 'pending:' + randomBytes(32).toString('hex');
  const claim = await kvSetNxGet(completionKey, owner, ORDER_PENDING_TTL_SEC);
  if (!claim.ok) return { ok: false, reason: 'storage_unavailable' };
  if (claim.value === digest) return { ok: true, duplicate: true };
  if (claim.value !== null) return { ok: false, reason: claim.value.startsWith('pending:') ? 'processing' : 'conflict' };
  try {
    const chain = chainObjectForId(tuple.chainId);
    if (!chain) return { ok: false, reason: 'settlement_mismatch' };
    const client = createPublicClient({ chain, transport: transportForChain(tuple.chainId) });
    const verified = await verifyJpycTransferToOnChain({ publicClient: client, txHash: settlement.transaction as Hex, includeReceiptLogs: true,
      expected: { token: tuple.token, to: tuple.merchant, minValue: ORDER_DUST_FLOOR_WEI } });
    if (!verified.ok || !matchesAgentSettlement(verified.receiptLogs ?? [], tuple)) return { ok: false, reason: 'settlement_mismatch' };

    // Merchant is the pre-settlement snapshot's authority. A deleted/reassigned handle is only
    // display metadata and must not divert a paid order to the handle's new owner.
    // Per-authorization Settled amount, never the receipt-wide Transfer total of a batch.
    const items = sanitizeOrderItems(snapshot.items);
    const amount = BigInt(tuple.merchantValue);
    const advisory = evaluateOrderAmount(declaredItemsTotalMinor(items, snapshot.decimals), amount, relayGasFeeValue(tuple.chainId), 300);
    const order: StoredOrder = { orderId: `agent-${tuple.nonce.slice(0, 18)}`, items, table: sanitizeTable(snapshot.table), amount: amount.toString(),
      txHash: settlement.transaction, chainId: tuple.chainId, from: snapshot.payer, ts: Date.now(), fulfilled: false };
    if (advisory.mismatch) order.amountMismatch = true;
    if (advisory.unchecked) order.amountUnchecked = true;
    const at = snapshot.pickupAt;
    // Same advisory near-future window as public notify; stale pickup metadata must not pollute boards.
    if (at !== null && at > Date.now() - 3600_000 && at < Date.now() + 14 * 86400_000) order.pickupAt = at;
    const obligation = standardFeeObligationFromReceipt({ receiptValue: amount, sameSourceFeeValue: BigInt(tuple.feeValue), config: feeConfig });
    const unpaid = { ...order };
    if (obligation) {
      unpaid.feeUncollected = true;
      unpaid.feeExpectedAmount = obligation.expected.toString();
      if (obligation.alternate !== undefined) unpaid.feeExpectedAmountAlt = obligation.alternate.toString();
    }
    const result = await kvEval<number>(SAVE, [reservation.key, completionKey, orderUsedKey(tuple.chainId, settlement.transaction), agentTransactionKey(tuple.chainId, settlement.transaction),
      orderListKey(snapshot.merchant), paymentClaimKey(tuple.chainId, settlement.transaction), legacyBillingPaymentKey(tuple.chainId, settlement.transaction)],
    [reservation.raw, owner, digest, serializeOrder(unpaid), serializeOrder(order), obligation?.collectedInline ? '1' : '0', paymentClaimResultValue('order'), String(ORDER_LIST_MAX), String(ORDER_LIST_TTL_SEC)]);
    if (!result.ok || result.value === -2) return { ok: false, reason: 'storage_unavailable' };
    if (result.value === -1) {
      logger.error('order.agent.finalize_conflict', { chainId: tuple.chainId, txHash: settlement.transaction });
      return { ok: false, reason: 'conflict' };
    }
    if (result.value === 0) return { ok: false, reason: 'processing' };
    if (result.value === 1) {
      after(async () => {
        // Metrics/push outages must not change an already persisted order or settled payment.
        try { await recordMetric('order'); if (env.enablePushNotify) await notifyPaymentReceived(snapshot.merchant, 'order'); }
        catch (error) { logger.warn('order.agent.notify_failed', { error }); }
      });
    }
    return { ok: true, duplicate: result.value === 2 };
  } finally {
    // CAS leaves another worker's lease and any completed marker intact, even after a lost ack.
    await kvEval(RELEASE, [completionKey], [owner]);
  }
}
