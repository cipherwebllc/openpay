import 'server-only';

// 第三者向け dual-rail relay の Arc (Circle Gateway) 面だけに置く「使用済み署名」の印。
//
// 何の波及を断つ防御か: Circle Gateway の verify は使用済みの nonce を `isValid:true` で通す
// (2026-09-17 実測・settle は nonce_already_used で落ちる)。印が無いと、1 回分の支払いの署名を
// 何度でも relay に投げ、出品者サーバーの上流 (LLM 等) を毎回動かせる。settle で止まるので
// 二重課金にはならないが、上流コストが増幅する。relay の rate limit は出品者サーバーの IP 単位で、
// 買い手単位の歯止めにならない。Base (CDP) は on-chain nonce で verify が落ちるので対象外。
//
// 状態遷移 (1 つの authorization = network + from + nonce につき 1 キー):
//   (なし) --verify が isValid:true--> pending(credential, binding) --settle 開始--> settling(credential, binding)
//   settling --settle 成功 / nonce_already_used / 判定なし--> settled
//   settling --settle の明示的な否定判定--> (なし)  ※同じ credential・同じ binding のときだけ消す
// credential は正規化した署名の fingerprint。キーには署名を使わない (s 反転などの malleability でも
// 同じキーに当たる) が、印を進めたり消したりできるのは verify を通った署名だけにする — 同じ from/nonce に
// 不正な署名を添えた settle で、正規の印を消させない。
// binding (印の `a`) は verify を通った支払いそのもの (受け取ったままの payload = 署名と authorization の
// 全項目・出品 id・Gateway へ送る accept) の digest。settle の開始と決済中の印の削除は credential に加えて
// binding の一致も求める。何の波及を断つ防御か: credential は署名しか見ないので、署名・from・nonce は同じで
// authorization.value 等だけ変えた settle (Gateway は拒否する) が印を settling へ進め、その否定判定で印が
// 消えて、元のヘッダーがもう一度 verify を通り、出品者の上流が何度でも動く (全レビュー第 8 回 G-1)。
// `a` の無い印 (この変更の deploy 前に置かれた pending/settling・最長 15 分) は従来どおり credential だけで
// 進め・消す (deploy 直後の正規の settle を止めない)。settled は credential も binding も見ない。
// first-party の vanillaResourceClaim (`x402:vanilla:claim:`) とは別の prefix・別 record。
//
// **KV は money truth ではない** (課金の真実は Gateway の settle)。KV 障害・未構成は fail-open
// (warn のみ) とし、この付帯防御の障害を決済本体へ波及させない。その間は使い回し防止が効かない
// (docs/ENV.md に明記)。

import { createHash } from 'node:crypto';
import { kvEval, kvGet, kvSet, kvSetNxGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { ARC_GATEWAY_MAX_TIMEOUT_SECONDS } from './config';
import { paymentSignatureFingerprint } from './paymentRedelivery';
import type { PaymentRequirementsV2 } from './v2';

const KEY_PREFIX = 'x402:relay:arc:v1:';
/** verify から settle までの処理中の印。出品者サーバーの上流処理 + relay の maxDuration に十分な長さ。 */
export const ARC_PENDING_TTL_SEC = 15 * 60;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;

// pending(credential, binding) → settling(credential, binding)。戻り値: 1 = 遷移した / 0 = 印なし /
// -1 = 別の署名・別の支払い内容 or 処理中 / -2 = 決済済み。壊れた値は -1 (進めない)。
// binding (ARGV[4]) は印に `a` があるときだけ照合する (`a` の無い旧形式の印は従来どおり credential だけ)。
const BEGIN_SETTLE = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
local ok, mark = pcall(cjson.decode, current)
if not ok or type(mark) ~= 'table' then
  return -1
end
if mark.s == 'settled' then
  return -2
end
if mark.s == 'pending' and mark.c == ARGV[1] and (mark.a == nil or mark.a == ARGV[4]) then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return -1
`;

// settling(credential, binding) のときだけ消す。決済済みや別の署名・別の支払い内容の印は残す。
// binding (ARGV[2]) は印に `a` があるときだけ照合する (BEGIN_SETTLE と同じ)。
const RELEASE_SETTLING = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
local ok, mark = pcall(cjson.decode, current)
if ok and type(mark) == 'table' and mark.s == 'settling' and mark.c == ARGV[1] and (mark.a == nil or mark.a == ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

export type ArcMarkIdentity = { key: string; credential: string; binding: string };
/** binding に含める支払い条件。どちらも出品の登録値と設定だけから決まる (呼び出し body 由来ではない)。 */
export type ArcMarkTerms = { resourceId: string; accept: PaymentRequirementsV2 };
export type ArcMarkState = 'none' | 'pending' | 'settling' | 'settled' | 'unavailable';
export type ArcSettleStart = 'started' | 'not_verified' | 'in_use' | 'settled' | 'unavailable';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Arc の支払い (EIP-3009 authorization) の識別キーと署名の credential・支払い内容の binding。
 * from / nonce / 署名が読めなければ null (呼び出し側は 400 にする — Gateway も拒否する値)。
 *
 * binding は payload を**正規化しない** (受け取ったままの JSON)。小文字化・10 進化・compact 署名の展開などで
 * 同じ値に寄せると、Gateway が別物として拒否しうる形 (checksum の崩れた address・EIP-2098 の署名・余分な
 * 項目など) を verify を通った支払いと同じとみなし、その否定判定で印が消える (G-1 と同じ穴が残る)。正規の
 * 出品者サーバーは verify と settle に同じヘッダーを送るので、そのままの形で一致する。terms は出品を
 * 取り替えた settle (同じ署名で別の出品の accepted を名乗る) を同じ支払いとみなさないため。
 */
export function arcMarkIdentity(
  network: string,
  payload: unknown,
  terms: ArcMarkTerms,
): ArcMarkIdentity | null {
  if (!isRecord(payload) || !isRecord(payload.authorization)) return null;
  const { from, nonce } = payload.authorization;
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
    .update(JSON.stringify({ network, from: from.toLowerCase(), nonce: nonce.toLowerCase() }))
    .digest('hex');
  const binding = createHash('sha256')
    .update(JSON.stringify([terms.resourceId, terms.accept, payload]))
    .digest('hex');
  return { key: KEY_PREFIX + digest, credential, binding };
}

function stateOf(value: string | null): ArcMarkState {
  if (value === null) return 'none';
  try {
    const mark: unknown = JSON.parse(value);
    if (isRecord(mark)) {
      if (mark.s === 'settled') return 'settled';
      if (mark.s === 'settling') return 'settling';
    }
  } catch {
    // 壊れた値は「使用中」として扱い、印を進めない。
  }
  return 'pending';
}

function warnUnavailable(op: string): void {
  logger.warn('x402.dualrail.arc_mark_unavailable', { op });
}

/** 現在の印。KV 障害は 'unavailable' (呼び出し側は印が無いものとして進む)。 */
export async function readArcMark(id: ArcMarkIdentity): Promise<ArcMarkState> {
  const res = await kvGet(id.key);
  if (!res.ok) {
    warnUnavailable('read');
    return 'unavailable';
  }
  return stateOf(res.value);
}

/**
 * verify が isValid:true を返した後に、処理中の印を原子的に置く。既に印があればその状態を返す
 * (同じ署名の同時投入・直前の決済)。KV 障害は 'unavailable' (fail-open で進む)。
 */
export async function claimArcPending(id: ArcMarkIdentity): Promise<ArcMarkState> {
  const res = await kvSetNxGet(
    id.key,
    JSON.stringify({ s: 'pending', c: id.credential, a: id.binding }),
    ARC_PENDING_TTL_SEC,
  );
  if (!res.ok) {
    warnUnavailable('claim');
    return 'unavailable';
  }
  return stateOf(res.value);
}

/**
 * settle の前に、同じ署名・同じ支払い内容の処理中の印を「決済中」へ原子的に進める。verify を通っていない
 * settle (印なし)・別の署名・verify と違う支払い内容・決済中/決済済みは進めない。KV 障害は 'unavailable'
 * (fail-open で進む)。
 */
export async function beginArcSettle(id: ArcMarkIdentity): Promise<ArcSettleStart> {
  const res = await kvEval<number>(
    BEGIN_SETTLE,
    [id.key],
    [
      id.credential,
      JSON.stringify({ s: 'settling', c: id.credential, a: id.binding }),
      String(ARC_PENDING_TTL_SEC),
      id.binding,
    ],
  );
  if (!res.ok || typeof res.value !== 'number') {
    warnUnavailable('begin_settle');
    return 'unavailable';
  }
  if (res.value === 1) return 'started';
  if (res.value === 0) return 'not_verified';
  if (res.value === -2) return 'settled';
  return 'in_use';
}

/**
 * 決済済みの印に上書きする (settle 成功・Gateway が nonce_already_used を明言・判定が出なかったとき)。
 * Arc の署名の有効期間と同じだけ保持する。
 */
export async function markArcSettled(id: ArcMarkIdentity): Promise<void> {
  const res = await kvSet(id.key, JSON.stringify({ s: 'settled' }), {
    ttlSec: ARC_GATEWAY_MAX_TIMEOUT_SECONDS,
  });
  if (!res.ok) warnUnavailable('settle');
}

/**
 * settle の明示的な否定判定のあと、同じ署名・同じ支払い内容の「決済中」の印だけを消す (同じ署名で
 * 再試行できるように)。binding の照合は、KV 障害で開始の照合を飛ばした (fail-open) settle が、別の支払い
 * 内容で進行中の正規の印を消さないため。
 */
export async function releaseArcSettling(id: ArcMarkIdentity): Promise<void> {
  const res = await kvEval<number>(RELEASE_SETTLING, [id.key], [id.credential, id.binding]);
  if (!res.ok) warnUnavailable('release');
}
