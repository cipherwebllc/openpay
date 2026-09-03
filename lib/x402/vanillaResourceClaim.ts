import 'server-only';

// vanilla x402 (素の exact scheme・外部 facilitator 精算) 用の resource 束縛 claim。
//
// 何の波及を断つ防御か (掟 13): **1 通の署名済み X-PAYMENT が、同額 (または安い) 別 resource
// へ同時に投げられたときの二重解錠**。exact scheme の verify は
// `value >= maxAmountRequired` しか見ず、resource/description は署名にも facilitator の
// 判定にも入らない (lib/x402/v2.ts toV2Accept は resource を落とす)。settle の原子性は
// 2 本目の**課金**だけを止めるが、そのときには 2 本目のコンテンツ生成は既に終わっている。
// そこで verify の前に「payment identity → resource + canonical query」を KV へ原子的に
// 束縛し、別束縛での再利用だけを弾く。
//
// first-party JPYC 経路の claimPaymentRedelivery (lib/x402/paymentRedelivery.ts) と同じ
// 意味論 (同一束縛 = 再配信を許す / 別束縛 = 拒否) を、vanilla の authorization 形
// (intentSalt ではなく EIP-3009 nonce) 向けに最小構成で持つ。**KV は money truth ではない** —
// 決済の真実は facilitator の verify/settle とオンチェーンのみ。したがって KV 障害・未構成は
// fail-open (warn のみ) とし、この付帯防御の障害を決済本体へ波及させない。

import { createHash } from 'node:crypto';
import { kvEval, kvSetNxGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  PAYMENT_REDELIVERY_TTL_SEC,
  paymentSignatureFingerprint,
} from '@/lib/x402/paymentRedelivery';

const RECORD_VERSION = 1;
const MAX_RECORD_BYTES = 4 * 1024;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export type VanillaResourceClaimIdentity = {
  /** KV key。authorization (network + from + nonce) から導出し、署名の malleability に依存しない。 */
  key: string;
  /** 正規化署名の fingerprint。key を知るだけの第三者が束縛を横取りできないようにする。 */
  credential: string;
};

export type VanillaResourceClaimResult =
  | { kind: 'claimed' }
  | { kind: 'match' }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

export type VanillaResourceReleaseResult =
  | { kind: 'released' }
  | { kind: 'missing' }
  | { kind: 'not-owner' }
  | { kind: 'unavailable' };

// 自分が置いた record (version + binding + credential が完全一致) のときだけ DEL する。
// 遅れて返った別 request が、後から張られた別束縛の claim を消す波及を断つ。
const RELEASE_VANILLA_CLAIM = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end

local decodedOk, decoded = pcall(cjson.decode, current)
if not decodedOk or type(decoded) ~= 'table' then
  return -1
end
if decoded.version ~= 1 or decoded.binding ~= ARGV[1] or
    decoded.credential ~= ARGV[2] then
  return -1
end
redis.call('DEL', KEYS[1])
return 1
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * claim の束縛キー: canonical な resource URL + **正規化した query**。
 * query を含めるのは、検索 API のように「同じ path・別 query = 別コンテンツ」の資源が
 * あるため。key/value でソートして正規化するのは、並び順だけが違う正直な再送を
 * 別束縛 (= 409) と誤判定しないため。
 */
export function vanillaResourceBinding(
  resourceUrl: string,
  requestUrl: string,
): string {
  let canonicalQuery = '';
  try {
    const entries = [...new URL(requestUrl).searchParams.entries()].sort(
      (a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1),
    );
    const params = new URLSearchParams();
    for (const [key, value] of entries) params.append(key, value);
    canonicalQuery = params.toString();
  } catch {
    // URL として解釈できない request は query 無しとして扱う (claim は付帯防御であり、
    // ここで例外を投げて決済本体を落とさない)。
    canonicalQuery = '';
  }
  return canonicalQuery ? `${resourceUrl}?${canonicalQuery}` : resourceUrl;
}

/**
 * facilitator body の paymentPayload (v1 命名) から payment identity を導出する。
 * 形が想定外 (nonce/from/署名を読めない) なら null — その場合 claim は行わず、判定は
 * 従来どおり facilitator に委ねる (既存の応答・順序を変えないため)。
 */
export function vanillaPaymentIdentity(
  paymentPayload: unknown,
): VanillaResourceClaimIdentity | null {
  if (!isRecord(paymentPayload)) return null;
  const { network, payload } = paymentPayload;
  if (typeof network !== 'string' || !isRecord(payload)) return null;
  const authorization = payload.authorization;
  if (!isRecord(authorization)) return null;
  const from = authorization.from;
  const nonce = authorization.nonce;
  const credential = paymentSignatureFingerprint(payload.signature);
  if (
    typeof from !== 'string' ||
    !ADDRESS_PATTERN.test(from) ||
    typeof nonce !== 'string' ||
    !NONCE_PATTERN.test(nonce) ||
    credential === null
  ) {
    return null;
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        network,
        from: from.toLowerCase(),
        nonce: nonce.toLowerCase(),
      }),
    )
    .digest('hex');
  return { key: `x402:vanilla:claim:${digest}`, credential };
}

function serialize(binding: string, credential: string): string {
  return JSON.stringify({ version: RECORD_VERSION, binding, credential });
}

function storedMatches(
  raw: string,
  binding: string,
  credential: string,
): boolean {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) return false;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  return (
    isRecord(value) &&
    value.version === RECORD_VERSION &&
    value.binding === binding &&
    value.credential === credential
  );
}

/**
 * payment identity を resource 束縛へ原子的に claim する (SET NX EX GET)。
 * 同一束縛の再送は 'match' (再配信を許す・既存挙動を変えない)、別束縛は 'conflict'。
 */
export async function claimVanillaResource(input: {
  identity: VanillaResourceClaimIdentity;
  binding: string;
}): Promise<VanillaResourceClaimResult> {
  const raw = serialize(input.binding, input.identity.credential);
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) {
    logger.warn('x402.vanilla.claim_record_too_large');
    return { kind: 'unavailable' };
  }
  try {
    const result = await kvSetNxGet(
      input.identity.key,
      raw,
      PAYMENT_REDELIVERY_TTL_SEC,
    );
    if (!result.ok) {
      if (result.reason !== 'unconfigured') {
        logger.warn('x402.vanilla.claim_failed', { reason: result.reason });
      }
      return { kind: 'unavailable' };
    }
    if (result.value === null) return { kind: 'claimed' };
    return storedMatches(result.value, input.binding, input.identity.credential)
      ? { kind: 'match' }
      : { kind: 'conflict' };
  } catch (error) {
    // 付帯 claim の KV 障害が、検証済み payment の従来経路を止める波及を断つ (fail-open)。
    logger.warn('x402.vanilla.claim_failed', { error });
    return { kind: 'unavailable' };
  }
}

/**
 * settle が始まる前に落ちた request だけが claim を戻す。
 * 解放しないと「A で verify に失敗した authorization を、正直に B で使い直す」ことが
 * TTL の間できなくなる (未使用の署名を人質に取る) — その波及を断つための解放。
 * broadcast の可能性がある settle 失敗では**呼ばない** (使用済みかもしれない署名を
 * 別 resource へ流用させないため)。
 */
export async function releaseVanillaResource(input: {
  identity: VanillaResourceClaimIdentity;
  binding: string;
}): Promise<VanillaResourceReleaseResult> {
  try {
    const result = await kvEval<unknown>(
      RELEASE_VANILLA_CLAIM,
      [input.identity.key],
      [input.binding, input.identity.credential],
    );
    if (!result.ok) {
      if (result.reason !== 'unconfigured') {
        logger.warn('x402.vanilla.claim_release_failed', {
          reason: result.reason,
        });
      }
      return { kind: 'unavailable' };
    }
    if (result.value === 1) return { kind: 'released' };
    if (result.value === 0) return { kind: 'missing' };
    if (result.value === -1) return { kind: 'not-owner' };
    logger.warn('x402.vanilla.claim_release_result_invalid');
    return { kind: 'unavailable' };
  } catch (error) {
    // 補助 marker の解放障害が、本来返すべき 402/503 を 500 に巻き込む波及を断つ。
    logger.warn('x402.vanilla.claim_release_failed', { error });
    return { kind: 'unavailable' };
  }
}
