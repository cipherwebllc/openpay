import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import { isKvConfigured, kvEval, kvGet } from '@/lib/kv';
import { readAuthorizationUsed } from '@/lib/relay/relayProvider';
import { SHARED_RECOVER_IDEM_PREFIX } from '@/lib/relay/relayGuards';
import { logger } from '@/lib/logger';
import { resolveDeployment } from '@/lib/tokens';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { parseFacilitatorRequest } from '@/lib/x402/facilitatorSettle';
import {
  parseBoundAgentOrderSnapshot, parseAgentOrderSettlement,
  type AgentOrderSettlement, type AgentOrderSnapshot,
} from '@/lib/x402/agentOrderRecovery';
import type {
  PaymentRedeliveryBinding, PaymentRedeliveryIdentity, PaymentRedeliveryRecord,
} from '@/lib/x402/paymentRedelivery';
import { receiptAuthorizations, type AgentSettlementTuple } from './agentOrderReceipt';
import type { FeeReceiptLog } from '@/lib/feeVerify';
import type { StandardFeeConfig } from './orderFeeObligation';

// 20-minute authorization + public notify's 30-minute admission window + outage margin.
// Snapshot retention is independent of the 30-minute redelivery cache. Hashless recovery still
// uses facilitatorStatus's last 10,000 blocks; 24h storage does NOT promise 24h log discovery.
// The repo's Polygon/Amoy estimate is 2s/block (crossChain/burnMarker.ts): ~5h33m20s,
// not 24h. Recovery requires the customer's same-payment retry; there is no background worker.
export const AGENT_RESERVATION_TTL_SEC = 24 * 60 * 60;

type ReservationRecord = {
  v: 1;
  identity: PaymentRedeliveryIdentity;
  snapshot: AgentOrderSnapshot;
  facilitatorBody: Record<string, unknown>;
  tuple: AgentSettlementTuple;
  feeConfig: StandardFeeConfig | null;
  // 手数料の徴収方式 (第 7 回レビュー B2)。'x402' = 買い手上乗せの x402 料金を Settled tuple で照合済み。
  // 無い (この field を足す前の予約) は従来どおり人払いの料金式で判定する。digest には在るときだけ入れる (旧予約の digest は不変)。
  feeModel?: 'x402';
  digest: string;
  createdAt: number;
};
export type AgentOrderReservation = { key: string; raw: string; record: ReservationRecord };
type Lookup =
  | { kind: 'match'; reservation: AgentOrderReservation }
  | { kind: 'missing' | 'conflict' | 'unavailable' };

export function agentReservationKey(chainId: number, token: string, authorizer: string, nonce: string): string {
  return `order:agentres:${chainId}:${token.toLowerCase()}:${authorizer.toLowerCase()}:${nonce.toLowerCase()}`;
}
export function agentCompletionKey(key: string): string {
  return key.replace('order:agentres:', 'order:used:agent:');
}
function bindingKey(identity: PaymentRedeliveryIdentity): string {
  return 'order:agentbinding:' + identity.keyIdentity;
}
function attemptKey(key: string): string {
  return key.replace('order:agentres:', 'order:agentattempt:');
}
export function agentTransactionKey(chainId: number, txHash: string): string {
  return `order:agenttx:${chainId}:${txHash.toLowerCase()}`;
}

function tupleFor(body: Record<string, unknown>): AgentSettlementTuple | null {
  const parsed = parseFacilitatorRequest(body);
  if (!parsed.ok) return null;
  const { chainId, params } = parsed.parsed;
  const token = resolveDeployment('jpyc', chainId)?.address;
  const forwarder = configuredJpycForwarderFor(chainId);
  if (!token || !forwarder) return null;
  return {
    chainId,
    token: getAddress(token),
    forwarder: getAddress(forwarder),
    authorizer: params.from,
    nonce: buildForwarderNonce(params, chainId, forwarder),
    merchant: params.merchant,
    merchantValue: params.merchantValue.toString(),
    feeReceiver: params.feeReceiver,
    feeValue: params.feeValue.toString(),
  };
}
// A saved agent binding must predate submission. A public human recover authorization must
// never acquire an attacker-selected cart, even when facilitator status can recover its hash.
export async function checkAgentOrderAuthorization(
  body: Record<string, unknown>,
  hasPriorAgentBinding: boolean,
): Promise<'clear' | 'conflict' | 'unavailable' | 'indeterminate'> {
  const tuple = tupleFor(body);
  if (!tuple) return 'conflict';
  const suffix = `${tuple.chainId}:${tuple.authorizer.toLowerCase()}:${tuple.nonce.toLowerCase()}`;
  const [human, shared] = await Promise.all([
    kvGet('relay:idem:' + suffix),
    kvGet(SHARED_RECOVER_IDEM_PREFIX + suffix),
  ]);
  if (!human.ok || !shared.ok) return 'unavailable';
  // '1' is an in-flight claim, not absence: mined and mempool human payments both stay human.
  if (human.value !== null) return 'conflict';
  if (shared.value !== null) {
    if (!hasPriorAgentBinding) return 'conflict';
    const own = await kvGet('x402fac:idem:' + suffix);
    if (!own.ok) return 'unavailable';
    if (own.value === null) return 'conflict';
  }
  // Our immutable reservation (or pre-upgrade redelivery) was saved before broadcasting.
  // Its own consumed nonce must remain recoverable, including after relay key TTL expiry.
  if (hasPriorAgentBinding) return 'clear';
  try {
    return await readAuthorizationUsed(tuple.chainId, tuple.token, tuple.authorizer, tuple.nonce)
      ? 'conflict' : 'clear';
  } catch {
    // RPC uncertainty must not become permission to reserve someone else's mined payment,
    // or a re-sign challenge while its settlement is unknown. Retry read-only checks first.
    logger.warn('order.agent.authorization_read_failed');
    return 'indeterminate';
  }
}

function digestFor(
  identity: PaymentRedeliveryIdentity,
  snapshot: AgentOrderSnapshot,
  tuple: AgentSettlementTuple,
  feeConfig: StandardFeeConfig | null,
  feeModel?: 'x402',
): string {
  return createHash('sha256')
    .update(JSON.stringify({ identity, snapshot, tuple, feeConfig, ...(feeModel ? { feeModel } : {}) }))
    .digest('hex');
}
// 同じ支払い (identity・tuple・料金条件) の同じ注文 (resource・明細・合計・table・エージェントの指定時刻) か。
// 受取時刻 (pickupAt) だけは店舗の候補枠へ正規化した値で時刻に依存するため比べない: 402 の有効時間を過ぎた
// 再試行は snapshot を作り直すと枠が動き digest が合わなくなるが、保存済み予約の snapshot が正本
// (PR #775 Codex P2-2)。正規化が起きない注文は snapshot が時刻に依存しないので digest が合い、ここに来ない。
function sameOrderExceptPickup(
  stored: ReservationRecord,
  attempt: Pick<ReservationRecord, 'identity' | 'snapshot' | 'tuple' | 'feeConfig' | 'feeModel'>,
): boolean {
  const strip = (s: AgentOrderSnapshot) => {
    const { pickupAt: _pickupAt, pickupAtRequested: _requested, ...rest } = s;
    return JSON.stringify(rest);
  };
  return (
    stored.identity.keyIdentity === attempt.identity.keyIdentity &&
    stored.identity.credential === attempt.identity.credential &&
    JSON.stringify(stored.tuple) === JSON.stringify(attempt.tuple) &&
    JSON.stringify(stored.feeConfig) === JSON.stringify(attempt.feeConfig) &&
    stored.feeModel === attempt.feeModel &&
    strip(stored.snapshot) === strip(attempt.snapshot) &&
    (stored.snapshot.pickupAtRequested ?? stored.snapshot.pickupAt) ===
      (attempt.snapshot.pickupAtRequested ?? attempt.snapshot.pickupAt)
  );
}
function decodeReservation(key: string, raw: string): AgentOrderReservation | null {
  try {
    const value = JSON.parse(raw) as ReservationRecord;
    if (
      value.v !== 1 || !value.identity || !value.snapshot || !value.facilitatorBody ||
      !Number.isSafeInteger(value.createdAt)
    ) return null;
    const snapshot = parseBoundAgentOrderSnapshot({
      context: value.snapshot,
      facilitatorBody: value.facilitatorBody,
      resource: value.snapshot.resource,
      identity: value.identity,
    });
    const tuple = tupleFor(value.facilitatorBody);
    if (!snapshot || !tuple || key !== agentReservationKey(tuple.chainId, tuple.token, tuple.authorizer, tuple.nonce)) return null;
    if (value.feeConfig !== null && (
      !value.feeConfig || !['storefront', 'preorder'].includes(value.feeConfig.kind) ||
      !['merchant', 'customer'].includes(value.feeConfig.feePayer)
    )) return null;
    if (value.feeModel !== undefined && value.feeModel !== 'x402') return null;
    if (
      JSON.stringify(tuple) !== JSON.stringify(value.tuple) ||
      digestFor(value.identity, snapshot, tuple, value.feeConfig, value.feeModel) !== value.digest
    ) return null;
    return { key, raw, record: { ...value, snapshot, tuple } };
  } catch {
    // Corrupt persisted binding must not substitute another cart or authorize settlement.
    return null;
  }
}

// All predictable type/argument errors are checked before writes: Redis Lua does not roll back.
// Keep immutable JSON as bytes (no decode/encode roundtrip losing nulls or sharing cjson tables).
const RESERVE = [
  "for i=1,3 do local t=redis.call('TYPE',KEYS[i]).ok; if t~='none' and t~='string' then return {-2,''} end end",
  "local indexed=redis.call('GET',KEYS[2]); if indexed and indexed~=KEYS[1] then return {-1,''} end",
  "local current=redis.call('GET',KEYS[1])",
  "if current then local ok,r=pcall(cjson.decode,current); if not ok or type(r)~='table' or (r.digest~=ARGV[2] and r.digest~=ARGV[5]) then return {-1,''} end; return {0,current} end",
  "if indexed then return {-2,''} end",
  "local ttl=tonumber(ARGV[3]); if not ttl or ttl<=0 then return {-2,''} end",
  "redis.call('SET',KEYS[1],ARGV[1],'EX',ttl)",
  "redis.call('SET',KEYS[2],KEYS[1],'EX',ttl)",
  "redis.call('SET',KEYS[3],ARGV[4],'EX',ttl)",
  "return {1,ARGV[1]}",
].join('\n');

// Only a proven pre-broadcast failure permits another attempt (including a lost reserve ack:
// that request never called settle). Missing ownership or unknown settle acks stay recovery-only.
const RETRY_ATTEMPT = [
  "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end",
  "if redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end",
  "local ttl=redis.call('PTTL',KEYS[1]); if ttl<=0 then return 0 end",
  "redis.call('SET',KEYS[2],ARGV[3],'PX',ttl); return 1",
].join('\n');

export async function lookupAgentOrderReservation(
  identity: PaymentRedeliveryIdentity,
  binding: PaymentRedeliveryBinding,
): Promise<Lookup> {
  const index = await kvGet(bindingKey(identity));
  if (!index.ok) return { kind: 'unavailable' };
  if (index.value === null) return { kind: 'missing' };
  const stored = await readAgentOrderReservation(index.value);
  if (stored.kind !== 'match') {
    return stored.kind === 'missing' ? { kind: 'unavailable' } : stored;
  }
  const { record } = stored.reservation;
  return record.identity.keyIdentity === identity.keyIdentity &&
    record.identity.credential === identity.credential && record.snapshot.resource === binding.resource
    ? stored : { kind: 'conflict' };
}
export async function readAgentOrderReservation(key: string): Promise<Lookup> {
  const value = await kvGet(key);
  if (!value.ok) return { kind: 'unavailable' };
  if (value.value === null) return { kind: 'missing' };
  const reservation = decodeReservation(key, value.value);
  return reservation ? { kind: 'match', reservation } : { kind: 'conflict' };
}
export async function reservationForBinding(
  identity: PaymentRedeliveryIdentity,
  snapshot: AgentOrderSnapshot,
  body: Record<string, unknown>,
): Promise<Lookup> {
  const tuple = tupleFor(body);
  if (!tuple) return { kind: 'conflict' };
  const key = agentReservationKey(tuple.chainId, tuple.token, tuple.authorizer, tuple.nonce);
  const stored = await readAgentOrderReservation(key);
  if (stored.kind !== 'match') return stored;
  const r = stored.reservation.record;
  return digestFor(identity, snapshot, tuple, r.feeConfig, r.feeModel) === r.digest ||
    sameOrderExceptPickup(r, { identity, snapshot, tuple, feeConfig: r.feeConfig, feeModel: r.feeModel })
    ? stored : { kind: 'conflict' };
}
export async function reserveAgentOrder(input: {
  identity: PaymentRedeliveryIdentity;
  snapshot: AgentOrderSnapshot;
  facilitatorBody: Record<string, unknown>;
  feeConfig: StandardFeeConfig | null;
  feeModel?: 'x402';
}): Promise<{ kind: 'created'; reservation: AgentOrderReservation; owner: string } | Lookup> {
  const tuple = tupleFor(input.facilitatorBody);
  if (!tuple || !parseBoundAgentOrderSnapshot({
    context: input.snapshot,
    facilitatorBody: input.facilitatorBody,
    identity: input.identity,
    resource: input.snapshot.resource,
  })) return { kind: 'conflict' };
  const key = agentReservationKey(tuple.chainId, tuple.token, tuple.authorizer, tuple.nonce);
  const record: ReservationRecord = {
    v: 1, ...input, tuple,
    digest: digestFor(input.identity, input.snapshot, tuple, input.feeConfig, input.feeModel),
    createdAt: Date.now(),
  };
  const raw = JSON.stringify(record);
  const owner = randomBytes(32).toString('hex');
  // feeModel を足す前に作られた同じ内容の予約は、その digest (feeModel なし) のまま同一とみなして返す
  // (再予約が conflict = 402 に化けない・旧予約は旧い手数料判定のまま・第 7 回レビュー B2 の互換読み)。
  const legacyDigest = digestFor(input.identity, input.snapshot, tuple, input.feeConfig);
  const result = await kvEval<[number, string]>(
    RESERVE,
    [key, bindingKey(input.identity), attemptKey(key)],
    [raw, record.digest, String(AGENT_RESERVATION_TTL_SEC), owner, legacyDigest],
  );
  if (!result.ok || !result.value || result.value[0] === -2) {
    // A lost reserve ack must not strand an unused payment. This request has not broadcast;
    // compare both immutable bytes and its own owner so another request's attempt stays held.
    await releaseAgentOrderAttempt({ key, raw, record }, owner);
    return { kind: 'unavailable' };
  }
  if (result.value[0] === -1) {
    // digest 不一致でも、受取時刻の正規化だけが違う同じ支払い・同じ注文なら保存済み予約を正本に同じ経路へ進む
    // (早期復旧の index 読取が落ちた再試行・PR #775 P2-2)。読み直せなければ 503 (新しい支払い要求にしない)。
    // RESERVE は -1 を返す前に何も書かないので、解放する attempt は無い。
    const stored = await readAgentOrderReservation(key);
    if (stored.kind === 'unavailable') return { kind: 'unavailable' };
    if (stored.kind === 'match' && sameOrderExceptPickup(stored.reservation.record, record)) {
      return { kind: 'match', reservation: stored.reservation };
    }
    return { kind: 'conflict' };
  }
  const reservation = decodeReservation(key, result.value[1]);
  if (!reservation) {
    await releaseAgentOrderAttempt({ key, raw, record }, owner);
    return { kind: 'unavailable' };
  }
  return result.value[0] === 1 ? { kind: 'created', reservation, owner } : { kind: 'match', reservation };
}
const REMEMBER_SETTLEMENT = [
  "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end",
  "local ttl=redis.call('PTTL',KEYS[1]); if ttl<=0 then return 0 end",
  "redis.call('SET',KEYS[2],ARGV[2],'PX',ttl); return 1",
].join('\n');
function settlementKey(key: string): string { return key.replace('order:agentres:', 'order:agentsettlement:'); }
export async function rememberAgentSettlement(
  reservation: AgentOrderReservation,
  settlement: AgentOrderSettlement,
): Promise<void> {
  const result = await kvEval(
    REMEMBER_SETTLEMENT,
    [reservation.key, settlementKey(reservation.key)],
    [reservation.raw, JSON.stringify({ digest: reservation.record.digest, settlement })],
  );
  if (!result.ok) logger.warn('order.agent.settlement_save_failed');
}
export async function reservationRecoveryRecord(reservation: AgentOrderReservation): Promise<PaymentRedeliveryRecord> {
  const r = reservation.record;
  const base = {
    version: 1 as const,
    scope: 'agent-order' as const,
    resource: r.snapshot.resource,
    credential: r.identity.credential,
    facilitatorBody: r.facilitatorBody,
    context: r.snapshot,
  };
  const stored = await kvGet(settlementKey(reservation.key));
  if (stored.ok && stored.value !== null) {
    try {
      const value = JSON.parse(stored.value);
      const settlement = parseAgentOrderSettlement(value.settlement, r.snapshot);
      if (value.digest === r.digest && settlement) return { ...base, state: 'settled', settlement };
    } catch {
      // Corrupt advisory settlement cache must not unlock an order; fall back to on-chain status.
      logger.warn('order.agent.settlement_cache_invalid');
    }
  }
  return { ...base, state: 'pending' };
}
export async function releaseAgentOrderAttempt(reservation: AgentOrderReservation, owner: string): Promise<void> {
  const result = await kvEval(
    RETRY_ATTEMPT, [reservation.key, attemptKey(reservation.key)],
    [reservation.raw, owner, 'retryable'],
  );
  if (!result.ok) logger.warn('order.agent.attempt_release_failed');
}
export async function claimAgentOrderRetry(reservation: AgentOrderReservation): Promise<string | null> {
  const owner = randomBytes(32).toString('hex');
  const result = await kvEval<number>(
    RETRY_ATTEMPT, [reservation.key, attemptKey(reservation.key)],
    [reservation.raw, 'retryable', owner],
  );
  return result.ok && result.value === 1 ? owner : null;
}

export async function receiptHasAgentReservation(
  chainId: number,
  token: Address,
  logs: readonly FeeReceiptLog[] | undefined,
): Promise<'reserved' | 'clear' | 'unavailable'> {
  // No agent can reserve or settle without KV; preserve the existing unconfigured human path.
  if (!isKvConfigured()) return 'clear';
  // Missing evidence must not turn a receipt integration failure into a public bypass.
  if (!logs) return 'unavailable';
  for (const auth of receiptAuthorizations(logs, token)) {
    const found = await kvGet(agentReservationKey(chainId, token, auth.authorizer, auth.nonce));
    if (!found.ok) return 'unavailable';
    // Even corrupt records still fence public writes; corruption must never reopen order theft.
    if (found.value !== null) return 'reserved';
  }
  return 'clear';
}
