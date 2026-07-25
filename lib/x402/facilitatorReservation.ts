import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { kvEval, kvSet } from '@/lib/kv';

const RESERVATION_PREFIX = 'x402fac:reservation:v1:';
export const DEFAULT_MAX_UPSTREAM_SECONDS = 60;
export const DEFAULT_SETTLEMENT_GRACE_SECONDS = 30;
export const RESERVATION_ADMISSION_MARGIN_SECONDS = 5;

const CONSUME_RESERVATION =
  "local current=redis.call('GET',KEYS[1]); " +
  'if not current then return 0 end; ' +
  'local ok,record=pcall(cjson.decode,current); ' +
  'if not ok or record.version~=1 then return -2 end; ' +
  'if record.resource~=ARGV[1] then return -1 end; ' +
  'if ARGV[3]=="1" and record.token~=ARGV[2] then return -1 end; ' +
  'if record.state=="consumed" then return 2 end; ' +
  'if record.state~="reserved" then return -2 end; ' +
  "local ttl=redis.call('TTL',KEYS[1]); " +
  'if ttl<=0 then return 0 end; ' +
  'record.state="consumed"; ' +
  "redis.call('SET',KEYS[1],cjson.encode(record),'EX',ttl); return 1";
// 公開済み SDK は /verify の追加 token を echo しないため、token 未指定なら同じ
// resource の予約だけを原子的に consume/replay する互換経路を残す。

type ReservationIdentity = {
  chainId: number;
  from: Address;
  nonce: Hex;
};

type ReservationInput = ReservationIdentity & {
  raw: unknown;
  validBefore: bigint;
  nowSec: number;
  nowMs?: () => number;
};

type ReservationRecord = {
  version: 1;
  state: 'reserved' | 'consumed';
  resource: string;
  paymentHash: string;
  token: string;
};

export type ReserveFacilitatorPaymentResult =
  | { ok: true; token: string }
  | {
      ok: false;
      reason:
        | 'authorization_reserved'
        | 'insufficient_validity_window'
        | 'invalid_reservation'
        | 'reservation_unavailable';
    };

export type ConsumeFacilitatorPaymentResult =
  | { status: 'consumed' | 'replay' | 'missing' | 'invalid' }
  | { status: 'unavailable' };

type ReservationKv = {
  set: (
    key: string,
    value: string,
    options?: { nx?: boolean; ttlSec?: number },
  ) => Promise<
    | { ok: true; value: 'OK' | null }
    | { ok: false; reason: string }
  >;
  eval: (
    script: string,
    keys: string[],
    args: string[],
  ) => Promise<
    | { ok: true; value: number }
    | { ok: false; reason: string }
  >;
};

const DEFAULT_KV: ReservationKv = {
  set: (key, value, options) => kvSet(key, value, options),
  eval: (script, keys, args) => kvEval<number>(script, keys, args),
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

function reservationWindow(raw: unknown): number | null {
  if (!isObject(raw)) return null;
  const context = raw.reservation;
  if (context === undefined) {
    // 公開済み gate は upstream 時間を送らないが verify 後の処理を許すため、0 秒扱いで
    // 短期限署名を通し無料 upstream へ波及させず、新 gate と同じ既定時間を確保する。
    return DEFAULT_MAX_UPSTREAM_SECONDS + DEFAULT_SETTLEMENT_GRACE_SECONDS;
  }
  if (!isObject(context)) return null;

  const maxUpstreamSeconds = nonNegativeInteger(
    context.maxUpstreamSeconds ?? 0,
  );
  const settlementGraceSeconds = positiveInteger(
    context.settlementGraceSeconds ?? DEFAULT_SETTLEMENT_GRACE_SECONDS,
  );
  if (maxUpstreamSeconds === null || settlementGraceSeconds === null) {
    return null;
  }
  const required = maxUpstreamSeconds + settlementGraceSeconds;
  return Number.isSafeInteger(required) ? required : null;
}

function reservationDescriptor(raw: unknown): {
  resource: string;
  paymentHash: string;
} | null {
  if (!isObject(raw)) return null;
  const paymentPayload = raw.paymentPayload;
  const paymentRequirements = raw.paymentRequirements;
  if (!isObject(paymentPayload) || !isObject(paymentRequirements)) return null;
  const resource = paymentRequirements.resource;
  if (typeof resource !== 'string' || resource.length === 0) return null;

  const paymentHash = createHash('sha256')
    .update(
      stableJson({
        x402Version: raw.x402Version,
        paymentPayload,
        paymentRequirements,
      }),
    )
    .digest('hex');
  return {
    resource,
    paymentHash,
  };
}

function reservationKey({ chainId, from, nonce }: ReservationIdentity): string {
  return `${RESERVATION_PREFIX}${chainId}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
}

function recordFor(
  descriptor: NonNullable<ReturnType<typeof reservationDescriptor>>,
  state: ReservationRecord['state'],
  token: string,
): string {
  return JSON.stringify({
    version: 1,
    state,
    ...descriptor,
    token,
  } satisfies ReservationRecord);
}

export async function reserveFacilitatorPayment(
  input: ReservationInput,
  store: ReservationKv = DEFAULT_KV,
): Promise<ReserveFacilitatorPaymentResult> {
  const nowMs = input.nowMs ?? Date.now;
  const admissionStartedAtMs = nowMs();
  const descriptor = reservationDescriptor(input.raw);
  const requiredValiditySeconds = reservationWindow(input.raw);
  if (!descriptor || requiredValiditySeconds === null) {
    return { ok: false, reason: 'invalid_reservation' };
  }

  const remaining = input.validBefore - BigInt(input.nowSec);
  // SET NX の通信・scheduler 遅延で、token を返す時点には seller の宣言した
  // upstream + settle 猶予を割り込む波及を断つ。境界値も余裕なしとして拒否する。
  const requiredAtAdmission =
    BigInt(requiredValiditySeconds) +
    BigInt(RESERVATION_ADMISSION_MARGIN_SECONDS);
  if (remaining < requiredAtAdmission) {
    return { ok: false, reason: 'insufficient_validity_window' };
  }
  if (remaining <= 0n || remaining > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: 'invalid_reservation' };
  }

  const token = `x402r1_${randomBytes(32).toString('hex')}`;
  const result = await store.set(
    reservationKey(input),
    recordFor(descriptor, 'reserved', token),
    {
      nx: true,
      ttlSec: Number(remaining),
    },
  );
  if (!result.ok) {
    // KV 応答喪失時に未確認の token を返す波及を断ち、呼び出し側の従来 verify 経路へ委ねる。
    return { ok: false, reason: 'reservation_unavailable' };
  }
  if (result.value === null) {
    return { ok: false, reason: 'authorization_reserved' };
  }
  const elapsedMs = Math.max(0, nowMs() - admissionStartedAtMs);
  const elapsedSeconds = Math.ceil(elapsedMs / 1000);
  const remainingAfterReserve = remaining - BigInt(elapsedSeconds);
  if (remainingAfterReserve < requiredAtAdmission) {
    // token はまだ外部へ返していない。予約を残したまま token 発行だけを見送り、
    // 期限余裕のない補助 reservation を settle の必須条件にする波及を断つ。
    return { ok: false, reason: 'insufficient_validity_window' };
  }
  return { ok: true, token };
}

export async function consumeFacilitatorPayment(
  input: ReservationIdentity & { raw: unknown; reservationToken?: unknown },
  store: ReservationKv = DEFAULT_KV,
): Promise<ConsumeFacilitatorPaymentResult> {
  const descriptor = reservationDescriptor(input.raw);
  const tokenProvided = input.reservationToken !== undefined;
  const token =
    typeof input.reservationToken === 'string'
      ? input.reservationToken
      : '__invalid_reservation_token__';
  const result = await store.eval(
    CONSUME_RESERVATION,
    [reservationKey(input)],
    [descriptor?.resource ?? '', token, tokenProvided ? '1' : '0'],
  );
  if (!result.ok) {
    // 呼び出し側が補助 reservation の障害を既存 settle 経路から隔離できるよう明示する。
    return { status: 'unavailable' };
  }
  if (result.value === 1) return { status: 'consumed' };
  if (result.value === 2) return { status: 'replay' };
  if (result.value === 0) return { status: 'missing' };
  if (result.value === -1) return { status: 'invalid' };
  return { status: 'unavailable' };
}
