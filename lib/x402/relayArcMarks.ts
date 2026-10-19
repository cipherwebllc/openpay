import 'server-only';

// 第三者向け dual-rail relay の Arc (Circle Gateway) 面だけに置く「使用済み署名」の印。
//
// 何の波及を断つ防御か: Circle Gateway の verify は使用済みの nonce を `isValid:true` で通す
// (2026-09-17 実測・settle は nonce_already_used で落ちる)。印が無いと、1 回分の支払いの署名を
// 何度でも relay に投げ、出品者サーバーの上流 (LLM 等) を毎回動かせる。settle で止まるので
// 二重課金にはならないが、上流コストが増幅する。relay の rate limit は出品者サーバーの IP 単位で、
// 買い手単位の歯止めにならない。Base (CDP) は on-chain nonce で verify が落ちるので対象外。
//
// 識別子は (network, from, nonce) だけ。署名は使わない (s 反転などの malleability でも同じキーに
// 当たる)。first-party の vanillaResourceClaim (`x402:vanilla:claim:`) とは別の prefix・別 record
// にする — 同じキーに別形式を書くと first-party の照合が常に conflict になる。
//
// **KV は money truth ではない** (課金の真実は Gateway の settle)。KV 障害・未構成は fail-open
// (warn のみ) とし、この付帯防御の障害を決済本体へ波及させない。その間は使い回し防止が効かない
// (docs/ENV.md に明記)。

import { createHash } from 'node:crypto';
import { kvEval, kvGet, kvSet, kvSetNxGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { ARC_GATEWAY_MAX_TIMEOUT_SECONDS } from './config';

const KEY_PREFIX = 'x402:relay:arc:v1:';
const PENDING = 'pending';
const SETTLED = 'settled';
/** verify から settle までの処理中の印。出品者サーバーの上流処理 + relay の maxDuration に十分な長さ。 */
export const ARC_PENDING_TTL_SEC = 15 * 60;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const RELEASE_PENDING = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

export type ArcMarkState = 'none' | 'pending' | 'settled' | 'unavailable';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Arc の支払い (EIP-3009 authorization) の識別キー。from / nonce が読めなければ null
 * (呼び出し側は 400 にする — Gateway も拒否する値)。
 */
export function arcMarkKey(network: string, payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.authorization)) return null;
  const { from, nonce } = payload.authorization;
  if (
    typeof from !== 'string' ||
    !ADDRESS_PATTERN.test(from) ||
    typeof nonce !== 'string' ||
    !NONCE_PATTERN.test(nonce)
  ) {
    return null;
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ network, from: from.toLowerCase(), nonce: nonce.toLowerCase() }))
    .digest('hex');
  return KEY_PREFIX + digest;
}

function stateOf(value: string | null): ArcMarkState {
  if (value === null) return 'none';
  if (value === SETTLED) return 'settled';
  return 'pending';
}

function warnUnavailable(op: string): void {
  logger.warn('x402.dualrail.arc_mark_unavailable', { op });
}

/** 現在の印。KV 障害は 'unavailable' (呼び出し側は印が無いものとして進む)。 */
export async function readArcMark(key: string): Promise<ArcMarkState> {
  const res = await kvGet(key);
  if (!res.ok) {
    warnUnavailable('read');
    return 'unavailable';
  }
  return stateOf(res.value);
}

/**
 * verify 成功後に処理中の印を原子的に置く。既に印があればその状態を返す
 * (同じ署名の同時投入・直前の決済)。KV 障害は 'unavailable' (fail-open で進む)。
 */
export async function claimArcPending(key: string): Promise<ArcMarkState> {
  const res = await kvSetNxGet(key, PENDING, ARC_PENDING_TTL_SEC);
  if (!res.ok) {
    warnUnavailable('claim');
    return 'unavailable';
  }
  return stateOf(res.value);
}

/**
 * 決済済みの印に上書きする (settle 成功、または Gateway が nonce_already_used を明言したとき)。
 * Arc の署名の有効期間と同じだけ保持する。
 */
export async function markArcSettled(key: string): Promise<void> {
  const res = await kvSet(key, SETTLED, { ttlSec: ARC_GATEWAY_MAX_TIMEOUT_SECONDS });
  if (!res.ok) warnUnavailable('settle');
}

/** settle の否定判定のあと、処理中の印だけを消す (同じ署名で再試行できるように)。決済済みは消さない。 */
export async function releaseArcPending(key: string): Promise<void> {
  const res = await kvEval<number>(RELEASE_PENDING, [key], [PENDING]);
  if (!res.ok) warnUnavailable('release');
}
