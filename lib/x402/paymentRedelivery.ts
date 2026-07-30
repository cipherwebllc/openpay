import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import {
  compactSignatureToSignature,
  parseCompactSignature,
  parseSignature,
  serializeSignature,
  type Hex,
} from 'viem';
import { kvEval, kvGet, kvSetNxGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { caip2ForChainId, chainIdFromCaip2 } from '@/lib/x402/network';

// x402fac idempotency の保持時間 (30分) と同じ窓だけ再配信を許し、決済識別子を恒久保存しない。
export const PAYMENT_REDELIVERY_TTL_SEC = 30 * 60;

const RECORD_VERSION = 1;
const MAX_RECORD_BYTES = 16 * 1024;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_PATTERN = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;
const INTENT_SALT_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_PATTERN = /^[0-9]+$/;

export type PaymentRedeliveryScope = 'first-party' | 'agent-order';

export type PaymentRedeliveryBinding = {
  scope: PaymentRedeliveryScope;
  resource: string;
};

export type PaymentRedeliveryIdentity = {
  keyIdentity: string;
  credential: string;
};

export type PaymentSettlement = Record<string, unknown> & {
  success: true;
  transaction: string;
  network: string;
  payer: string;
};

type PaymentRedeliveryBase<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> = {
  version: typeof RECORD_VERSION;
  scope: PaymentRedeliveryScope;
  resource: string;
  credential: string;
  facilitatorBody: Record<string, unknown>;
  context?: TContext;
};

export type PaymentRedeliveryPendingRecord<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> = PaymentRedeliveryBase<TContext> & {
  state: 'pending';
  // Phase 3 導入前の pending record も読めるよう optional。新規 claim は必ず発行し、
  // broadcast 前拒否の request だけが所有者一致 CAS で marker を解放できる。
  ownerToken?: string;
};

export type OwnedPaymentRedeliveryPendingRecord<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> = PaymentRedeliveryPendingRecord<TContext> & {
  ownerToken: string;
};

export type PaymentRedeliverySettledRecord<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> = PaymentRedeliveryBase<TContext> & {
  state: 'settled';
  settlement: PaymentSettlement;
};

export type PaymentRedeliveryRecord<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> =
  | PaymentRedeliveryPendingRecord<TContext>
  | PaymentRedeliverySettledRecord<TContext>;

export type PaymentRedeliveryLookupResult<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> =
  | { kind: 'missing' }
  | { kind: 'match'; record: PaymentRedeliveryRecord<TContext> }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

export type PaymentRedeliveryClaimResult<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> =
  | {
      kind: 'claimed';
      record: OwnedPaymentRedeliveryPendingRecord<TContext>;
    }
  | { kind: 'match'; record: PaymentRedeliveryRecord<TContext> }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

export type PaymentRedeliveryReleaseResult =
  | { kind: 'released' }
  | { kind: 'missing' }
  | { kind: 'not-owner' }
  | { kind: 'unavailable' };

export type PaymentRedeliveryPromotionResult<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> =
  | { kind: 'promoted'; record: PaymentRedeliverySettledRecord<TContext> }
  | {
      kind: 'already-settled';
      record: PaymentRedeliverySettledRecord<TContext>;
    }
  | { kind: 'missing' }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

type CanonicalPaymentIdentity = {
  network: string;
  from: string;
  validAfter: string;
  validBefore: string;
  intentSalt: string;
};

const PROMOTE_PAYMENT_REDELIVERY = `
local current = redis.call('GET', KEYS[1])
if not current then
  return {0, ''}
end

local decodedOk, decoded = pcall(cjson.decode, current)
if not decodedOk or type(decoded) ~= 'table' then
  return {-1, ''}
end
if decoded.version ~= 1 or decoded.scope ~= ARGV[1] or
    decoded.resource ~= ARGV[2] or decoded.credential ~= ARGV[3] then
  return {-1, ''}
end
if decoded.state == 'settled' then
  return {2, current}
end
if decoded.state ~= 'pending' then
  return {-1, ''}
end

local settlementOk, settlement = pcall(cjson.decode, ARGV[4])
if not settlementOk or type(settlement) ~= 'table' then
  return {-1, ''}
end
decoded.state = 'settled'
decoded.ownerToken = nil
decoded.settlement = settlement
local promoted = cjson.encode(decoded)
if string.len(promoted) > tonumber(ARGV[6]) then
  return {-2, ''}
end
redis.call('SET', KEYS[1], promoted, 'EX', ARGV[5])
return {1, promoted}
`;

const RELEASE_PAYMENT_REDELIVERY = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end

local decodedOk, decoded = pcall(cjson.decode, current)
if not decodedOk or type(decoded) ~= 'table' then
  return -1
end
if decoded.version ~= 1 or decoded.state ~= 'pending' or
    decoded.scope ~= ARGV[1] or decoded.resource ~= ARGV[2] or
    decoded.credential ~= ARGV[3] or decoded.ownerToken ~= ARGV[4] then
  return -1
end
redis.call('DEL', KEYS[1])
return 1
`;

const OWNER_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

// facilitator /settle の現行契約で transaction broadcast より前にしか返らない reason。
// pending/reverted は含めず、broadcast の可能性がある支払いを再試行へ戻す波及を断つ。
const PRE_BROADCAST_REJECTION_REASONS = new Set([
  'ip_rate_limited',
  'relay_not_configured',
  'invalid_json',
  'payload_too_large',
  'invalid_body',
  'unsupported_scheme',
  'invalid_network',
  'unsupported_network',
  'network_mismatch',
  'invalid_payload',
  'invalid_signature',
  'invalid_authorization',
  'invalid_requirements',
  'gas_ceiling_required',
  'kv_required',
  'fee_receiver_unconfigured',
  'forwarder_unconfigured',
  'jpyc_unavailable',
  'reservation_invalid',
  'unsupported_chain',
  'fee_receiver_mismatch',
  'fee_value_mismatch',
  'fee_misconfigured',
  'invalid_merchant_value',
  'zero_merchant',
  'merchant_is_fee_receiver',
  'merchant_is_forwarder',
  'zero_salt',
  'value_exceeds_max',
  'not_yet_valid',
  'expired',
  'validity_too_far',
  'signature_invalid',
  'signature_mismatch',
  'insufficient_balance',
  'preflight_unavailable',
  'rate_limited',
  'daily_budget_exceeded',
  // recoverViaForwarder は submit throw と「未送信が確実」な poll error だけを relay_error にする。
  'relay_error',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function normalizeDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) return null;
  try {
    return BigInt(value).toString();
  } catch {
    return null;
  }
}

function normalizeSignature(value: unknown): string | null {
  if (typeof value !== 'string' || !SIGNATURE_PATTERN.test(value)) return null;
  try {
    const parsed =
      value.length === 132
        ? parseSignature(value as Hex)
        : compactSignatureToSignature(parseCompactSignature(value as Hex));
    return serializeSignature(parsed).toLowerCase();
  } catch {
    return null;
  }
}

function canonicalPaymentParts(
  value: unknown,
): { identity: CanonicalPaymentIdentity; signature: string } | null {
  if (!isRecord(value) || !isRecord(value.payload)) return null;

  let network: unknown;
  if (value.x402Version === 1) {
    network = value.network;
  } else if (value.x402Version === 2 && isRecord(value.accepted)) {
    network = value.accepted.network;
  } else {
    return null;
  }
  if (typeof network !== 'string') return null;
  const chainId = chainIdFromCaip2(network);
  if (chainId === null) return null;

  const authorization = value.payload.authorization;
  const signature = normalizeSignature(value.payload.signature);
  if (!isRecord(authorization)) return null;
  if (
    typeof authorization.from !== 'string' ||
    !ADDRESS_PATTERN.test(authorization.from) ||
    typeof authorization.intentSalt !== 'string' ||
    !INTENT_SALT_PATTERN.test(authorization.intentSalt) ||
    signature === null
  ) {
    return null;
  }
  const validAfter = normalizeDecimal(authorization.validAfter);
  const validBefore = normalizeDecimal(authorization.validBefore);
  if (validAfter === null || validBefore === null) return null;

  return {
    identity: {
      network: caip2ForChainId(chainId),
      from: authorization.from.toLowerCase(),
      validAfter,
      validBefore,
      intentSalt: authorization.intentSalt.toLowerCase(),
    },
    signature,
  };
}

/**
 * JSON 表現や v1/v2 envelope に依存しない payment identity と、cache 解錠用 credential。
 */
export function paymentRedeliveryIdentity(
  paymentPayload: unknown,
): PaymentRedeliveryIdentity | null {
  const parts = canonicalPaymentParts(paymentPayload);
  if (!parts) return null;

  const keyDigest = createHash('sha256')
    .update(JSON.stringify(parts.identity))
    .digest('hex');
  const credential = createHash('sha256')
    .update(parts.signature)
    .digest('hex');
  return {
    keyIdentity: `x402:redelivery:${keyDigest}`,
    credential,
  };
}

/**
 * 生署名から credential と同一の導出 (正規化→sha256) を行う。x402 payload を持たない
 * settle 入口 (relay recover 等) が、hosted PurchaseIntent の claim.signatureFingerprint と
 * 同じ土俵で照合するために使う。導出式を 2 箇所に複製しないための単一ソース。
 */
export function paymentSignatureFingerprint(
  signature: unknown,
): string | null {
  const normalized = normalizeSignature(signature);
  if (normalized === null) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

function parseSettlement(value: unknown): PaymentSettlement | null {
  if (!isRecord(value) || value.success !== true) return null;
  if (
    typeof value.transaction !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.transaction)
  ) {
    return null;
  }
  if (
    typeof value.network !== 'string' ||
    chainIdFromCaip2(value.network) === null
  ) {
    return null;
  }
  if (
    typeof value.payer !== 'string' ||
    !ADDRESS_PATTERN.test(value.payer)
  ) {
    return null;
  }
  return value as PaymentSettlement;
}

function parsePaymentRedeliveryRecord<
  TContext extends Record<string, unknown>,
>(raw: string): PaymentRedeliveryRecord<TContext> | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.version !== RECORD_VERSION ||
    (value.scope !== 'first-party' && value.scope !== 'agent-order') ||
    typeof value.resource !== 'string' ||
    value.resource.length === 0 ||
    typeof value.credential !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.credential) ||
    !isRecord(value.facilitatorBody) ||
    (value.context !== undefined && !isRecord(value.context))
  ) {
    return null;
  }

  const base: PaymentRedeliveryBase<TContext> = {
    version: RECORD_VERSION,
    scope: value.scope,
    resource: value.resource,
    credential: value.credential,
    facilitatorBody: value.facilitatorBody,
  };
  if (value.context !== undefined) {
    base.context = value.context as TContext;
  }
  if (value.state === 'pending') {
    if (
      value.ownerToken !== undefined &&
      (typeof value.ownerToken !== 'string' ||
        !OWNER_TOKEN_PATTERN.test(value.ownerToken))
    ) {
      return null;
    }
    return {
      ...base,
      state: 'pending',
      ...(value.ownerToken === undefined
        ? {}
        : { ownerToken: value.ownerToken }),
    };
  }
  if (value.state === 'settled') {
    const settlement = parseSettlement(value.settlement);
    if (settlement) return { ...base, state: 'settled', settlement };
  }
  return null;
}

function serializeRecord(
  record: PaymentRedeliveryRecord,
): string | null {
  const raw = JSON.stringify(record);
  return Buffer.byteLength(raw, 'utf8') <= MAX_RECORD_BYTES ? raw : null;
}

function bindingMatches(
  record: PaymentRedeliveryRecord,
  identity: PaymentRedeliveryIdentity,
  binding: PaymentRedeliveryBinding,
): boolean {
  return (
    record.scope === binding.scope &&
    record.resource === binding.resource &&
    record.credential === identity.credential
  );
}

function classifyStoredRecord<
  TContext extends Record<string, unknown>,
>(
  raw: string,
  identity: PaymentRedeliveryIdentity,
  binding: PaymentRedeliveryBinding,
):
  | { kind: 'match'; record: PaymentRedeliveryRecord<TContext> }
  | { kind: 'conflict' } {
  const record = parsePaymentRedeliveryRecord<TContext>(raw);
  if (!record || !bindingMatches(record, identity, binding)) {
    // 同じ payment identity の別 credential/resource/scope が既存 payment の
    // settled cache や status/settle 経路へ横入りする波及を断つ。
    return { kind: 'conflict' };
  }
  return { kind: 'match', record };
}

export async function lookupPaymentRedelivery<
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  identity: PaymentRedeliveryIdentity,
  binding: PaymentRedeliveryBinding,
): Promise<PaymentRedeliveryLookupResult<TContext>> {
  try {
    const result = await kvGet(identity.keyIdentity);
    if (!result.ok) {
      if (result.reason !== 'unconfigured') {
        logger.warn('x402.payment_redelivery.lookup_failed', {
          reason: result.reason,
        });
      }
      return { kind: 'unavailable' };
    }
    if (result.value === null) return { kind: 'missing' };
    return classifyStoredRecord<TContext>(result.value, identity, binding);
  } catch (error) {
    // 復旧用 KV の読取障害が従来の verify/settle 経路を 500 に巻き込む波及を断つ。
    logger.warn('x402.payment_redelivery.lookup_failed', { error });
    return { kind: 'unavailable' };
  }
}

export async function claimPaymentRedelivery<
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  identity: PaymentRedeliveryIdentity;
  binding: PaymentRedeliveryBinding;
  facilitatorBody: Record<string, unknown>;
  context?: TContext;
}): Promise<PaymentRedeliveryClaimResult<TContext>> {
  const pending: OwnedPaymentRedeliveryPendingRecord<TContext> = {
    version: RECORD_VERSION,
    state: 'pending',
    scope: input.binding.scope,
    resource: input.binding.resource,
    credential: input.identity.credential,
    ownerToken: randomBytes(32).toString('hex'),
    facilitatorBody: input.facilitatorBody,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
  const raw = serializeRecord(pending);
  if (raw === null) {
    logger.warn('x402.payment_redelivery.claim_record_too_large');
    return { kind: 'unavailable' };
  }

  try {
    const result = await kvSetNxGet(
      input.identity.keyIdentity,
      raw,
      PAYMENT_REDELIVERY_TTL_SEC,
    );
    if (!result.ok) {
      if (result.reason !== 'unconfigured') {
        logger.warn('x402.payment_redelivery.claim_failed', {
          reason: result.reason,
        });
      }
      return { kind: 'unavailable' };
    }
    if (result.value === null) return { kind: 'claimed', record: pending };
    const classified = classifyStoredRecord<TContext>(
      result.value,
      input.identity,
      input.binding,
    );
    return classified.kind === 'match'
      ? { kind: 'match', record: classified.record }
      : { kind: 'conflict' };
  } catch (error) {
    // claim 用 KV の障害が、検証済み payment の従来 settle 開始を止める波及を断つ。
    logger.warn('x402.payment_redelivery.claim_failed', { error });
    return { kind: 'unavailable' };
  }
}

/**
 * /settle の応答が broadcast 前拒否と現在の契約上保証される場合だけ true。
 * pending/reverted/未知 reason は false とし、送信済み payment の claim 解放を防ぐ。
 */
export function isFacilitatorPreBroadcastRejection(
  status: number,
  body: Record<string, unknown>,
): boolean {
  if (status < 400) return false;
  const reason =
    typeof body.errorReason === 'string'
      ? body.errorReason
      : typeof body.error === 'string'
        ? body.error
        : null;
  return reason !== null && PRE_BROADCAST_REJECTION_REASONS.has(reason);
}

/**
 * claim を取得した request が broadcast 前に拒否された場合だけ pending marker を戻す。
 * ownerToken まで一致する Lua CAS により、遅れて返った別 request が後発 claim を消す波及を断つ。
 */
export async function releasePaymentRedelivery(input: {
  identity: PaymentRedeliveryIdentity;
  binding: PaymentRedeliveryBinding;
  ownerToken: string;
}): Promise<PaymentRedeliveryReleaseResult> {
  if (!OWNER_TOKEN_PATTERN.test(input.ownerToken)) {
    return { kind: 'not-owner' };
  }
  try {
    const result = await kvEval<unknown>(
      RELEASE_PAYMENT_REDELIVERY,
      [input.identity.keyIdentity],
      [
        input.binding.scope,
        input.binding.resource,
        input.identity.credential,
        input.ownerToken,
      ],
    );
    if (!result.ok) {
      if (result.reason !== 'unconfigured') {
        logger.warn('x402.payment_redelivery.release_failed', {
          reason: result.reason,
        });
      }
      return { kind: 'unavailable' };
    }
    if (result.value === 1) return { kind: 'released' };
    if (result.value === 0) return { kind: 'missing' };
    if (result.value === -1) return { kind: 'not-owner' };
    logger.warn('x402.payment_redelivery.release_result_invalid');
    return { kind: 'unavailable' };
  } catch (error) {
    // 補助 marker の解放障害が、本来返すべき broadcast 前拒否の応答を 500 に巻き込む波及を断つ。
    logger.warn('x402.payment_redelivery.release_failed', { error });
    return { kind: 'unavailable' };
  }
}

export async function promotePaymentRedelivery<
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  identity: PaymentRedeliveryIdentity;
  binding: PaymentRedeliveryBinding;
  settlement: PaymentSettlement;
}): Promise<PaymentRedeliveryPromotionResult<TContext>> {
  const settlement = parseSettlement(input.settlement);
  if (!settlement) {
    logger.warn('x402.payment_redelivery.invalid_settlement');
    return { kind: 'unavailable' };
  }

  try {
    const result = await kvEval<unknown>(
      PROMOTE_PAYMENT_REDELIVERY,
      [input.identity.keyIdentity],
      [
        input.binding.scope,
        input.binding.resource,
        input.identity.credential,
        JSON.stringify(settlement),
        String(PAYMENT_REDELIVERY_TTL_SEC),
        String(MAX_RECORD_BYTES),
      ],
    );
    if (!result.ok) {
      if (result.reason !== 'unconfigured') {
        logger.warn('x402.payment_redelivery.promotion_failed', {
          reason: result.reason,
        });
      }
      return { kind: 'unavailable' };
    }
    if (
      !Array.isArray(result.value) ||
      typeof result.value[0] !== 'number'
    ) {
      logger.warn('x402.payment_redelivery.promotion_result_invalid');
      return { kind: 'unavailable' };
    }

    const [code, raw] = result.value;
    if (code === 0) return { kind: 'missing' };
    if (code === -1) {
      // CAS 時点で別用途へ束縛済みなら、その record を上書きして誤配信へ波及させない。
      return { kind: 'conflict' };
    }
    if (code === -2) {
      logger.warn('x402.payment_redelivery.promoted_record_too_large');
      return { kind: 'unavailable' };
    }
    if (
      (code === 1 || code === 2) &&
      typeof raw === 'string'
    ) {
      const record = parsePaymentRedeliveryRecord<TContext>(raw);
      if (
        !record ||
        record.state !== 'settled' ||
        !bindingMatches(record, input.identity, input.binding)
      ) {
        return { kind: 'conflict' };
      }
      return code === 1
        ? { kind: 'promoted', record }
        : { kind: 'already-settled', record };
    }
    logger.warn('x402.payment_redelivery.promotion_result_invalid', {
      code,
    });
    return { kind: 'unavailable' };
  } catch (error) {
    // 復旧 cache の CAS 障害が、成立済み決済の既存成功応答を 500 に巻き込む波及を断つ。
    logger.warn('x402.payment_redelivery.promotion_failed', { error });
    return { kind: 'unavailable' };
  }
}
