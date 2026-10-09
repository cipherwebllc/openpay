import 'server-only';

import { randomBytes } from 'node:crypto';
import { after } from 'next/server';
import { createPublicClient, type Hex } from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { kvEval, kvLrange, kvSetNxGet } from '@/lib/kv';
import { resolveHandle } from '@/lib/handleStore';
import { nearestPickupSlot, pickupSlots } from '@/lib/shopTime';
import { verifyJpycTransferToOnChain } from '@/lib/feeVerify';
import { logger } from '@/lib/logger';
import { recordMetric } from '@/lib/metrics';
import { notifyPaymentReceived } from '@/lib/push/notify';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { legacyBillingPaymentKey, paymentClaimKey, paymentClaimResultValue } from '@/lib/paymentClaim';
import { declaredItemsTotalMinor, evaluateOrderAmount, orderListKey, orderUsedKey, parseStoredOrder, sanitizeOrderItems, sanitizeTable, serializeOrder, ORDER_DONE_TTL_SEC, ORDER_DUST_FLOOR_WEI, ORDER_LIST_MAX, ORDER_LIST_TTL_SEC, ORDER_PENDING_TTL_SEC, type StoredOrder } from '@/lib/orderRelay';
import { parseAgentOrderSettlement, type AgentOrderSettlement } from '@/lib/x402/agentOrderRecovery';
import { agentCompletionKey, agentTransactionKey, readAgentOrderReservation, type AgentOrderReservation } from './agentOrderReservation';
import { matchesAgentSettlement } from './agentOrderReceipt';
import { standardFeeObligationFromReceipt } from './orderFeeObligation';

// KEYS: reservation, authorization completion, public tx claim, agent tx marker, list,
// global fee claim, legacy fee claim. ARGV: immutable reservation, owner, digest, unpaid order,
// paid order, inline fee flag, fee claim value, list limit, list TTL, done marker TTL.
// The public tx claim ('done') and its agent tx marker share ORDER_DONE_TTL_SEC (C10/R6): both are read
// together (public=='done' needs agent=='agent'), so they must expire together. Fee claims and the
// completion digest keep no TTL.
// Redis Lua does not roll back runtime errors: validate every type/argument and decode before
// the first write. JSON orders remain bytes, without cjson table aliases or null conversion.
const SAVE = [
  "for i=1,7 do local t=redis.call('TYPE',KEYS[i]).ok; local want='string'; if i==5 then want='list' end; if t~='none' and t~=want then return -2 end end",
  "if redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end",
  "local complete=redis.call('GET',KEYS[2]); if complete==ARGV[3] then return 2 end; if complete~=ARGV[2] then return 0 end",
  "local public=redis.call('GET',KEYS[3]); if public and public~='done' then return 0 end",
  "if public=='done' and redis.call('GET',KEYS[4])~='agent' then return -1 end",
  "local limit=tonumber(ARGV[8]); local ttl=tonumber(ARGV[9]); local doneTtl=tonumber(ARGV[10]); if not limit or limit<1 or not ttl or ttl<1 or not doneTtl or doneTtl<1 then return -2 end",
  "local ok,order=pcall(cjson.decode,ARGV[4]); if not ok or type(order)~='table' or not order.orderId then return -2 end",
  "local paidOk,paid=pcall(cjson.decode,ARGV[5]); if not paidOk or type(paid)~='table' or paid.orderId~=order.orderId then return -2 end",
  "local inline=ARGV[6]=='1' and redis.call('EXISTS',KEYS[6])==0 and redis.call('EXISTS',KEYS[7])==0",
  // LPUSH precedes completion. Type/ARGV preflight above removes deterministic partial errors.
  "if inline then redis.call('LPUSH',KEYS[5],ARGV[5]); redis.call('SET',KEYS[6],ARGV[7]); else redis.call('LPUSH',KEYS[5],ARGV[4]); end",
  "redis.call('LTRIM',KEYS[5],0,limit-1); redis.call('EXPIRE',KEYS[5],ttl)",
  "redis.call('SET',KEYS[4],'agent','EX',doneTtl); redis.call('SET',KEYS[3],'done','EX',doneTtl); redis.call('SET',KEYS[2],ARGV[3]); return 1",
].join('\n');
const RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0";

// pickupAt / pickupAtRequested = 保存された受注の受取時刻 (重複のときは保存済みの受注から読む・読めなければ無し)。
export type AgentOrderFinalizeResult =
  | { ok: true; duplicate: boolean; pickupAt?: number; pickupAtRequested?: number }
  | { ok: false; reason: 'processing' | 'conflict' | 'storage_unavailable' | 'settlement_mismatch' };
type StoredPickup = { pickupAt?: number; pickupAtRequested?: number };

// 受注を保存する瞬間に 1 回だけ、エージェントの指定時刻を店舗の候補枠 (最短準備時間・ラストオーダー・15 分刻み・
// 猶予なし = 過去の枠は候補にならない) の最寄りへ正規化する (第 7 回レビュー B12・user 裁定 R3)。予約 snapshot と
// digest は生の指定値のまま (時刻に依存しない) なので、再試行や redelivery の経路は main と同じ。finalize は冪等
// (同じ予約の 2 回目は duplicate) なので最初に保存した値が正本。店舗設定は表示用の metadata で、handle の読取障害や
// 候補枠が無い状態は受注の保存を止めず生の指定値のまま保存する (付帯処理の隔離・掟 13)。
async function normalizedPickup(handle: string, requested: number | null): Promise<{ pickupAt: number | null; requested?: number }> {
  if (requested === null || !env.enablePreorderTime) return { pickupAt: requested };
  const resolved = await resolveHandle(handle);
  const storefront = resolved.ok ? resolved.record?.storefront : undefined;
  if (!storefront || storefront.mode !== 'preorder') return { pickupAt: requested };
  const slot = nearestPickupSlot(pickupSlots(Date.now(), storefront.minLeadMinutes, storefront.lastOrder), requested);
  return slot === requested ? { pickupAt: requested } : { pickupAt: slot, requested };
}
function pickupOf(order: Pick<StoredOrder, 'pickupAt' | 'pickupAtRequested'>): StoredPickup {
  if (order.pickupAt === undefined) return {};
  return { pickupAt: order.pickupAt, ...(order.pickupAtRequested !== undefined ? { pickupAtRequested: order.pickupAtRequested } : {}) };
}
// 重複 (保存済み) の応答に載せる受取時刻を保存済みの受注から読む。読めなければ応答に載せないだけで結果は変えない。
async function storedPickup(merchant: string, orderId: string): Promise<StoredPickup> {
  const list = await kvLrange(orderListKey(merchant), 0, ORDER_LIST_MAX - 1);
  if (!list.ok) return {};
  for (const raw of list.value) {
    const order = parseStoredOrder(raw);
    if (order?.orderId === orderId) return pickupOf(order);
  }
  return {};
}

export async function finalizeAgentOrder(input: { reservation: AgentOrderReservation; settlement: AgentOrderSettlement }): Promise<AgentOrderFinalizeResult> {
  const { reservation, settlement } = input;
  // Re-read immutable ownership after settlement: redelivery promotion may have conflicted.
  const stored = await readAgentOrderReservation(reservation.key);
  if (stored.kind !== 'match' || stored.reservation.raw !== reservation.raw) return { ok: false, reason: stored.kind === 'unavailable' ? 'storage_unavailable' : 'conflict' };
  const { snapshot, tuple, digest, feeConfig, feeModel } = stored.reservation.record;
  if (!parseAgentOrderSettlement(settlement, snapshot)) return { ok: false, reason: 'settlement_mismatch' };
  const completionKey = agentCompletionKey(reservation.key);
  const orderId = `agent-${tuple.nonce.slice(0, 18)}`;
  const owner = 'pending:' + randomBytes(32).toString('hex');
  const claim = await kvSetNxGet(completionKey, owner, ORDER_PENDING_TTL_SEC);
  if (!claim.ok) return { ok: false, reason: 'storage_unavailable' };
  if (claim.value === digest) return { ok: true, duplicate: true, ...(await storedPickup(snapshot.merchant, orderId)) };
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
    const order: StoredOrder = { orderId, items, table: sanitizeTable(snapshot.table), amount: amount.toString(),
      txHash: settlement.transaction, chainId: tuple.chainId, from: snapshot.payer, ts: Date.now(), fulfilled: false };
    if (advisory.mismatch) order.amountMismatch = true;
    if (advisory.unchecked) order.amountUnchecked = true;
    const picked = await normalizedPickup(snapshot.handle, snapshot.pickupAt);
    const at = picked.pickupAt;
    // Same advisory near-future window as public notify; stale pickup metadata must not pollute boards.
    if (at !== null && at > Date.now() - 3600_000 && at < Date.now() + 14 * 86400_000) {
      order.pickupAt = at;
      if (picked.requested !== undefined) order.pickupAtRequested = picked.requested;
    }
    // x402 の注文は、手数料を x402 料金 (server が requirements で決め、上の matchesAgentSettlement が Settled の
    // feeValue を照合済み) で同じ settle の中で徴収している → 人払いの料金式で判定し直さず「徴収済み」とする
    // (第 7 回レビュー B2)。モバイル注文の利用料が OFF (feeConfig なし) のときは従来どおり義務を作らない。
    const obligation = feeModel === 'x402'
      ? (feeConfig ? { expected: BigInt(tuple.feeValue), collectedInline: true } : null)
      : standardFeeObligationFromReceipt({ receiptValue: amount, sameSourceFeeValue: BigInt(tuple.feeValue), config: feeConfig });
    const unpaid = { ...order };
    if (obligation) {
      unpaid.feeUncollected = true;
      unpaid.feeExpectedAmount = obligation.expected.toString();
      if (obligation.alternate !== undefined) unpaid.feeExpectedAmountAlt = obligation.alternate.toString();
    }
    const result = await kvEval<number>(SAVE, [reservation.key, completionKey, orderUsedKey(tuple.chainId, settlement.transaction), agentTransactionKey(tuple.chainId, settlement.transaction),
      orderListKey(snapshot.merchant), paymentClaimKey(tuple.chainId, settlement.transaction), legacyBillingPaymentKey(tuple.chainId, settlement.transaction)],
    [reservation.raw, owner, digest, serializeOrder(unpaid), serializeOrder(order), obligation?.collectedInline ? '1' : '0', paymentClaimResultValue('order'), String(ORDER_LIST_MAX), String(ORDER_LIST_TTL_SEC), String(ORDER_DONE_TTL_SEC)]);
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
    if (result.value === 2) return { ok: true, duplicate: true, ...(await storedPickup(snapshot.merchant, orderId)) };
    return { ok: true, duplicate: false, ...pickupOf(order) };
  } finally {
    // CAS leaves another worker's lease and any completed marker intact, even after a lost ack.
    await kvEval(RELEASE, [completionKey], [owner]);
  }
}
