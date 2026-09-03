import 'server-only';

// vanilla x402 (素の exact scheme・外部 facilitator 精算) 用の resource 束縛 claim。
//
// 何の波及を断つ防御か (掟 13): **1 通の署名済み X-PAYMENT が、同額 (または安い) 別 resource
// へ同時に投げられたときの二重解錠**。exact scheme の verify は
// `value >= maxAmountRequired` しか見ず、resource/description は署名にも facilitator の
// 判定にも入らない (lib/x402/v2.ts toV2Accept は resource を落とす)。settle の原子性は
// 2 本目の**課金**だけを止めるが、そのときには 2 本目のコンテンツ生成は既に終わっている。
// そこで **verify が isValid:true を返した後・content 生成の前**に「payment identity →
// resource + canonical query」を KV へ原子的に束縛し、別束縛での再利用だけを弾く。
// (verify の前に置くと、署名を検証していない誰でも KV に 30 分キーを作れてしまう。
// first-party JPYC 経路 app/api/paid/_shared.ts の claim 位置と同じ。)
//
// first-party JPYC 経路の claimPaymentRedelivery (lib/x402/paymentRedelivery.ts) と同じ
// 意味論 (同一束縛 = 再配信を許す / 別束縛 = 拒否) を、vanilla の authorization 形
// (intentSalt ではなく EIP-3009 nonce) 向けに最小構成で持つ。**KV は money truth ではない** —
// 決済の真実は facilitator の verify/settle とオンチェーンのみ。したがって KV 障害・未構成は
// fail-open (warn のみ) とし、この付帯防御の障害を決済本体へ波及させない。

import { createHash } from 'node:crypto';
import { kvEval, kvSetNxGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { paymentSignatureFingerprint } from '@/lib/x402/paymentRedelivery';

const RECORD_VERSION = 1;
/**
 * 読み出し側だけのガード。record は sha256 束縛 + fingerprint の固定長になったので書き込みが
 * ここを超えることは無い。KV から異常に大きい値が返った場合 (別用途キーの衝突・破損) を
 * 「一致しない」として扱い、巨大文字列の JSON.parse を避ける。
 */
const MAX_RECORD_BYTES = 4 * 1024;
/**
 * claim の TTL。値は PAYMENT_REDELIVERY_TTL_SEC と同じ 30 分だが**別定数**にする —
 * 再配信 cache のチューニング (短縮) が、二重解錠を防ぐ claim の有効窓を巻き添えで
 * 縮める波及を断つため (掟 13)。
 */
export const VANILLA_CLAIM_TTL_SEC = 30 * 60;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;

// KV 未構成 (fail-open) の warn はプロセスに 1 回だけ。有料 GET ごとにログを吐いて
// 本番ログを埋めるのを避ける。
let warnedUnconfigured = false;

function warnUnconfiguredOnce(): void {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  logger.warn('x402.vanilla.claim_unconfigured');
}

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

// 自分が置いた record (version + bindingHash + credential が完全一致) のときだけ DEL する。
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
if decoded.version ~= 1 or decoded.bindingHash ~= ARGV[1] or
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

/**
 * 束縛は**生文字列でなく sha256 (hex) で保存する**。断つ波及: query は長さ無制限なので、
 * 生の束縛を持つ record は 4KB 超の query で MAX_RECORD_BYTES を越え、claim が
 * 'unavailable' → fail-open となり **claim ごと無効化できてしまう** (ゴミ query を足した
 * 1 通の authorization で複数 resource が解錠できる)。hash なら record は常に固定長。
 * 副作用: 生 query (検索語・アドレス等) は KV に残らない — 照合は hash 一致で足りる。
 */
function bindingHash(binding: string): string {
  return createHash('sha256').update(binding).digest('hex');
}

function serialize(bindingDigest: string, credential: string): string {
  return JSON.stringify({
    version: RECORD_VERSION,
    bindingHash: bindingDigest,
    credential,
  });
}

function storedMatches(
  raw: string,
  bindingDigest: string,
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
    value.bindingHash === bindingDigest &&
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
  const digest = bindingHash(input.binding);
  const raw = serialize(digest, input.identity.credential);
  try {
    const result = await kvSetNxGet(
      input.identity.key,
      raw,
      VANILLA_CLAIM_TTL_SEC,
    );
    if (!result.ok) {
      if (result.reason === 'unconfigured') {
        warnUnconfiguredOnce();
      } else {
        logger.warn('x402.vanilla.claim_failed', { reason: result.reason });
      }
      return { kind: 'unavailable' };
    }
    if (result.value === null) return { kind: 'claimed' };
    return storedMatches(result.value, digest, input.identity.credential)
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
      [bindingHash(input.binding), input.identity.credential],
    );
    if (!result.ok) {
      if (result.reason === 'unconfigured') {
        warnUnconfiguredOnce();
      } else {
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
