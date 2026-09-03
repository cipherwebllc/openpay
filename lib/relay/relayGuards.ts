// JPYC relay の共有ガード群 (rate-limit / 日次予算 / idempotency)。決済 relay (/api/relay/jpyc) と
// CSV パス購入 relay (/api/csv-pass/relay) の両方が同一の relayer ウォレット (POL/KAIA) を消費するため、
// 守る資源は共通。とりわけ **rate-limit (relay:rl:) と日次予算 (relay:budget:{chainId}:{YYYYMMDD}) は
// 両 route で同一キーを共有**し、パス購入経由で決済 relay の上限を回避できないようにする (Codex)。
//
// idempotency は route ごとに専用 prefix を持つ (決済=relay:idem: / パス=csvpassrelay:idem:)。これは
// idem が「同一 authorization の重複 POST」を区別するための per-payload キーで、別 route の同 nonce と
// 衝突させない方が安全なため (prefix を引数化し makeIdempotency で束ねる)。
// **例外は recover (forwarder.settle)**: nonce が決定論的コミットメント = 同 nonce は同一支払いなので、
// 決済 relay と x402 facilitator の二入口が並行 broadcast しないよう共有 claim
// (SHARED_RECOVER_IDEM_PREFIX) を route 別 claim に重ねる (makeRecoverIdempotency・A7)。
//
// 抽出元は app/api/relay/jpyc/route.ts の同名関数。**挙動は完全に同一** (決済 route の既存テストが
// 無改変で green であることが受け入れ条件)。実依存 (KV) は lib/kv をそのまま使う。

import type { Address, Hex } from 'viem';
import {
  kvLpush,
  kvLrange,
  kvSet,
  kvGet,
  kvIncr,
  kvDecr,
  kvExpire,
  kvDel,
  isKvConfigured,
} from '@/lib/kv';
import { logger } from '@/lib/logger';

export const RL_MAX = 5; // window 内の最大 relay 回数 (per key)
export const RL_WINDOW_MS = 60_000;
const DEFAULT_RELAY_DAILY_TX_CAP = 500;
const CAP_RATIO_DIVISOR = 5; // 20%

// cap を巨大値/NaN 相当で事実上無効化すると、低回収 settle が共有予算を枯らす波及を再び許す。
// env は非負の decimal safe integer だけを採用し、それ以外は呼出側の安全な既定値へ倒す。
function nonNegativeSafeInteger(raw: string | undefined): number | null {
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const twentyPercent = (cap: number) => Math.floor(cap / CAP_RATIO_DIVISOR);

// B4: chain 日次の relay 件数上限 (Sybil による POL 枯渇 griefing の circuit breaker)。
export const RELAY_DAILY_TX_CAP =
  nonNegativeSafeInteger(process.env.RELAY_DAILY_TX_CAP) ??
  DEFAULT_RELAY_DAILY_TX_CAP;
// ガスフロア未満しか回収しない settle の専用日次枠。共有 relay:budget: より先にこの小さい枠を
// 消費させ、低回収 settle の連打が決済 / CSV パス / x402 共通の日次枠を枯らす波及を断つ。
// 未指定/不正値は実効共有枠の 20%。明示値も共有枠が正なら 1 件以上小さく clamp し、専用枠が
// 共有枠を丸ごと消費して通常 relay を止める波及を断つ。0 は sub-floor settle の停止設定として維持。
const requestedSubfloorCap =
  nonNegativeSafeInteger(process.env.RELAY_SUBFLOOR_DAILY_TX_CAP) ??
  twentyPercent(RELAY_DAILY_TX_CAP);
export const RELAY_SUBFLOOR_DAILY_TX_CAP =
  RELAY_DAILY_TX_CAP > 0
    ? Math.min(requestedSubfloorCap, RELAY_DAILY_TX_CAP - 1)
    : requestedSubfloorCap;
// 同じ払い元が専用日次枠を単独で枯らさないための UTC 日次 cap。未指定/不正値は実効専用枠の 20%。
// fresh EOA への迂回は上の chain 単位 cap が止めるため、この limiter 単独を Sybil 防御とはしない。
const requestedSubfloorPayerCap =
  nonNegativeSafeInteger(process.env.RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP) ??
  twentyPercent(RELAY_SUBFLOOR_DAILY_TX_CAP);
export const RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP =
  RELAY_SUBFLOOR_DAILY_TX_CAP === 0
    ? 0
    : RELAY_SUBFLOOR_DAILY_TX_CAP === 1
      ? Math.min(requestedSubfloorPayerCap, 1)
      : Math.min(
          requestedSubfloorPayerCap,
          RELAY_SUBFLOOR_DAILY_TX_CAP - 1,
        );
export const IDEM_TTL_SEC = 1800;

declare const gasBudgetRefundTokenBrand: unique symbol;
declare const subfloorBudgetRefundTokenBrand: unique symbol;

// refund 対象は check 時に実際に INCR した UTC 日付込み key そのもの。opaque token として
// 呼出側へ渡し、refund 時の再計算で翌日 counter を減らす波及を構造的に断つ。
export type GasBudgetRefundToken = string & {
  readonly [gasBudgetRefundTokenBrand]: true;
};
export type SubfloorBudgetRefundToken = string & {
  readonly [subfloorBudgetRefundTokenBrand]: true;
};
export type BudgetCheckResult<TToken> =
  | { allowed: boolean; consumed: true; refundToken: TToken }
  | { allowed: boolean; consumed: false; refundToken: null };

// KV sliding-window rate-limit (kv は list ops のみなので timestamp list で近似)。
// KV 未設定時は通す (本番は KV 設定が前提)。**両 route 共有キー** relay:rl: (関所資源が同一 relayer)。
export async function checkRateLimit(keys: string[]): Promise<boolean> {
  if (!isKvConfigured()) return true;
  const now = Date.now();
  for (const key of keys) {
    const k = `relay:rl:${key}`;
    const updated = await kvLpush(k, String(now), {
      trimStart: 0,
      trimStop: RL_MAX * 4,
      ttlSec: (RL_WINDOW_MS / 1000) * 2,
    });
    // rate-limit storage の障害で stale な既存履歴を採用し、relay 本体を止める波及を断つ。
    if (!updated.ok) continue;
    const r = await kvLrange(k, 0, RL_MAX * 4);
    const recent = (r.ok ? r.value : []).filter(
      (ts) => now - Number(ts) < RL_WINDOW_MS,
    );
    if (recent.length > RL_MAX) return false;
  }
  return true;
}

// 固定窓 IP レート制限 (read endpoint 用・O(1) kvIncr)。sliding-window の checkRateLimit は list が
// max*4 まで伸び、高頻度ポーリング (例: 注文状況 8s) を寛容な上限で守るには重い (毎回 max*4 件の
// list 読み)。read poll 向けに INCR ベースの固定窓で近似する。allowed = 窓内カウント ≤ max。
// fail-open: KV 未設定/障害は許可 (可用性優先・checkRateLimit と同方針)。
export async function checkReadRateLimit(
  key: string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  if (!isKvConfigured()) return true;
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const k = `rl:read:${key}:${bucket}`;
  const r = await kvIncr(k);
  if (!r.ok) return true; // KV 障害は通す (fail-open)
  if (r.value === 1) await kvExpire(k, windowSec * 2); // 初回のみ TTL (窓 2 つ分で確実に失効)
  return r.value <= max;
}

// 生 IP を保存しない write/auth endpoint 用の固定窓 limiter。呼出側で HMAC 済み IP を渡し、
// scope ごとに bucket を分離する。IP hash 無しは共有 unknown bucket に寄せず skip する。
export async function checkIpRateLimit(
  scope: string,
  hashedIp: string | null,
  max: number,
  windowSec: number,
): Promise<boolean> {
  if (hashedIp === null) return true;

  try {
    if (!isKvConfigured()) return true;
    const key = `iprl:v1:${scope}:${hashedIp}`;
    const r = await kvIncr(key, { initialTtlSec: windowSec });
    if (!r.ok) return true;
    return r.value <= max;
  } catch {
    // rate-limit storage の障害を auth/resource 管理本体へ波及させない (fail-open)。
    return true;
  }
}

// 日次予算カウンタのキー導出。check が導出した UTC 日付込み key を refundToken として返し、
// DECR 側は再計算しない。YYYYMMDD は UTC。**両 route 共有キー**。
export const gasBudgetKey = (chainId: number) =>
  `relay:budget:${chainId}:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

const utcDateKey = () =>
  new Date().toISOString().slice(0, 10).replace(/-/g, '');

// ガスフロア未満 settle 専用の chain 日次予算。通常 relay の gasBudgetKey と名前空間を分け、
// 専用 cap 超過を共有 relay:budget: へ到達させない。
export const subfloorBudgetKey = (chainId: number) =>
  `relay:subfloor:budget:${chainId}:${utcDateKey()}`;

// 署名検証済みの払い元ごとの UTC 日次 limiter。生 IP や未署名 hint ではなく EIP-3009 の from を
// 鍵にするため、同じ資金元からの低回収 settle 連打を実際に制限できる。
export const subfloorPayerRateLimitKey = (
  chainId: number,
  payer: string,
) => `relay:subfloor:payer:${chainId}:${payer.toLowerCase()}:${utcDateKey()}`;

export async function checkSubfloorPayerRateLimit(
  chainId: number,
  payer: string,
): Promise<boolean> {
  if (!isKvConfigured()) return true;
  const key = subfloorPayerRateLimitKey(chainId, payer);
  const r = await kvIncr(key);
  if (!r.ok) {
    // 専用 limiter のストレージ障害を、正規の小口決済本体へ波及させない (fail-open)。
    logger.warn('relay subfloor payer limit INCR failed (fail-open)', {
      chainId,
    });
    return true;
  }
  // EXPIRE 応答喪失で古い日次キーが永続しても UTC 日付で次日の判定は分離される。毎回の再設定で
  // stale key 自体も回収し、付帯 limiter の障害が翌日の小口決済へ波及しないようにする。
  await kvExpire(key, 2 * 24 * 3600);
  return r.value <= RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP;
}

// ガスフロア未満 settle 専用の日次予算。checkGasBudget と同じ
// { allowed, consumed, refundToken } 契約を独立の名前空間で持ち、未送信が確実な場合だけ
// refundSubfloorBudget で戻す。
export async function checkSubfloorBudget(
  chainId: number,
): Promise<BudgetCheckResult<SubfloorBudgetRefundToken>> {
  if (!isKvConfigured()) {
    return { allowed: true, consumed: false, refundToken: null };
  }
  const key = subfloorBudgetKey(chainId);
  const r = await kvIncr(key);
  if (!r.ok) {
    // 専用 budget のストレージ障害を、正規の小口決済本体へ波及させない (fail-open)。
    logger.warn('relay subfloor budget INCR failed (fail-open)', { chainId });
    return { allowed: true, consumed: false, refundToken: null };
  }
  await kvExpire(key, 2 * 24 * 3600);
  return {
    allowed: r.value <= RELAY_SUBFLOOR_DAILY_TX_CAP,
    consumed: true,
    refundToken: key as SubfloorBudgetRefundToken,
  };
}

export async function refundSubfloorBudget(
  refundToken: SubfloorBudgetRefundToken,
): Promise<void> {
  if (!isKvConfigured()) return;
  const r = await kvDecr(refundToken);
  if (!r.ok) {
    // 専用枠の返却失敗を、共有予算の返却や決済応答へ波及させない (fail-quiet)。
    logger.warn('relay subfloor budget DECR failed (枠が 1 過消費のまま)');
  }
}

// B4: 日次グローバル予算 (Sybil circuit breaker)。INCR relay:budget:{chainId}:{YYYYMMDD} し、
// 初回のみ TTL 2 日。count が cap 以下なら許可。fail-open: KV 未設定/障害は許可 (rate-limit と
// 同方針・alpha は可用性優先)。近似カウンタで足りる (応答喪失の二重カウントは早めに止まる=安全側)。
//
// 返り値 (CDX-5): { allowed, consumed, refundToken }。
//   allowed  = relay を許可するか。
//   consumed = カウンタを実際に INCR したか。KV 未設定 / INCR 失敗の fail-open allow では INCR して
//              いないので consumed=false。consumed=false の枠を後で DECR (refund) すると、INCR して
//              いないカウンタを減らして負に振れ、cap を超える余剰枠を与えてしまう (= refund しない)。
//   refundToken = INCR 対象の UTC 日付込み key。consumed=true のときだけ存在し、返却はこの key に限定。
export async function checkGasBudget(
  chainId: number,
): Promise<BudgetCheckResult<GasBudgetRefundToken>> {
  if (!isKvConfigured()) {
    return { allowed: true, consumed: false, refundToken: null };
  }
  const key = gasBudgetKey(chainId);
  const r = await kvIncr(key);
  if (!r.ok) {
    logger.warn('relay gas budget INCR failed (fail-open)', { chainId });
    return { allowed: true, consumed: false, refundToken: null };
  }
  // EXPIRE は毎回設定する (初回 EXPIRE が応答喪失すると TTL 無しの stale key が永続化するため・
  // Codex P2)。EXPIRE は冪等なので再設定は無害。
  await kvExpire(key, 2 * 24 * 3600);
  return {
    allowed: r.value <= RELAY_DAILY_TX_CAP,
    consumed: true,
    refundToken: key as GasBudgetRefundToken,
  };
}

// checkGasBudget で INCR 消費した日次枠を DECR で 1 戻す。tx が 1 件も broadcast されなかった
// ことが確実な失敗でのみ呼ぶ (jpycRelay の refundGasBudget 契約)。check 時の opaque token を
// そのまま使い、UTC 日跨ぎ後も新しい日の counter を減らさない。
export async function refundGasBudget(
  refundToken: GasBudgetRefundToken,
): Promise<void> {
  if (!isKvConfigured()) return;
  const r = await kvDecr(refundToken);
  if (!r.ok) {
    logger.warn('relay gas budget DECR failed (枠が 1 過消費のまま)');
  }
}

// idempotency の 3 関数 (claim / recordHash / release) を prefix で束ねた束。route は専用 prefix
// (決済=relay:idem: / パス=csvpassrelay:idem:) を与え、jpycRelay の deps へそのまま渡す。
export type IdempotencyHelpers = {
  claimIdempotency: (
    chainId: number,
    from: Address,
    nonce: Hex,
  ) => Promise<{ status: 'first' } | { status: 'duplicate'; txHash: Hex | null }>;
  recordRelayHash: (
    chainId: number,
    from: Address,
    nonce: Hex,
    txHash: Hex,
  ) => Promise<void>;
  releaseIdempotency: (
    chainId: number,
    from: Address,
    nonce: Hex,
  ) => Promise<void>;
};

export type IdempotencyLookup =
  | { state: 'missing' }
  | { state: 'hash'; txHash: Hex }
  | { state: 'indeterminate' };

// status route 専用の read-only lookup。claim/TTL 更新は一切行わない。
// KV 未構成は on-chain 判定へ進めるため missing、構成済み KV の read 障害は、記録済 hash を
// 「無い」と誤認して RPC 側へ倒さないよう indeterminate として区別する。
export async function readIdempotency(
  prefix: string,
  chainId: number,
  from: Address,
  nonce: Hex,
): Promise<IdempotencyLookup> {
  if (!isKvConfigured()) return { state: 'missing' };
  const key = `${prefix}${chainId}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
  const result = await kvGet(key);
  if (!result.ok) return { state: 'indeterminate' };
  const value = result.value;
  if (value === null || value === '1') return { state: 'missing' };
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return { state: 'hash', txHash: value as Hex };
  }
  return { state: 'indeterminate' };
}

// 指定 prefix で idempotency 3 関数を生成する。挙動は抽出元 (relay route) と完全に同一。
// onClaimUnavailable は claim の SET が KV 障害で不確定になり fail-safe で duplicate に
// 倒したときだけ呼ばれる観測 hook (任意・応答には一切影響しない)。正当な重複 POST と
// 「KV が落ちて重複扱いになった」を運用ログで区別するために足した (A7)。
export function makeIdempotency(
  prefix: string,
  onClaimUnavailable?: (info: { chainId: number; nonce: Hex }) => void,
): IdempotencyHelpers {
  const idemKey = (chainId: number, from: Address, nonce: Hex) =>
    `${prefix}${chainId}:${from.toLowerCase()}:${nonce.toLowerCase()}`;

  // 冪等性 claim (fail-SAFE)。SET NX:
  //  - 'OK' (新規) → first (処理続行)。
  //  - null (既存=重複 POST) → duplicate。記録済 txHash があれば返す (response-loss 後の explorer 追跡)。
  //  - KV error/timeout (応答不確定・KV は configured) → SET が通った可能性 → duplicate (二重 submit 回避)。
  //  - KV 未設定 → idempotency 無効 → first (可用性優先。最終防壁は on-chain _authorizationStates)。
  async function claimIdempotency(
    chainId: number,
    from: Address,
    nonce: Hex,
  ): Promise<{ status: 'first' } | { status: 'duplicate'; txHash: Hex | null }> {
    if (!isKvConfigured()) return { status: 'first' };
    const key = idemKey(chainId, from, nonce);
    const r = await kvSet(key, '1', { nx: true, ttlSec: IDEM_TTL_SEC });
    if (r.ok) {
      if (r.value === null) {
        // 既存。記録済 hash を読んで同梱 (なければ null)。
        const g = await kvGet(key);
        const v = g.ok ? g.value : null;
        const txHash =
          v && v.startsWith('0x') && v.length === 66 ? (v as Hex) : null;
        return { status: 'duplicate', txHash };
      }
      return { status: 'first' };
    }
    onClaimUnavailable?.({ chainId, nonce });
    return { status: 'duplicate', txHash: null }; // fail-safe
  }

  // claim 済 authorization に broadcast 済 txHash を上書き記録 (NX なし)。重複 POST が
  // explorer 追跡できるように。TTL は claim と同じ。
  async function recordRelayHash(
    chainId: number,
    from: Address,
    nonce: Hex,
    txHash: Hex,
  ): Promise<void> {
    if (!isKvConfigured()) return;
    await kvSet(idemKey(chainId, from, nonce), txHash, { ttlSec: IDEM_TTL_SEC });
  }

  // claim 解放。broadcast "前" の失敗 (relay_error) でのみ呼ぶ (tx 未送信なので安全)。正当な
  // 再試行を 30 分 (IDEM_TTL) 待たせない (false tombstone 防止)。
  async function releaseIdempotency(
    chainId: number,
    from: Address,
    nonce: Hex,
  ): Promise<void> {
    if (!isKvConfigured()) return;
    await kvDel(idemKey(chainId, from, nonce));
  }

  return { claimIdempotency, recordRelayHash, releaseIdempotency };
}

// A7: recover (forwarder.settle) の **入口非依存**な共有 claim 名前空間。
//
// なぜ要るか: recover の nonce は buildForwarderNonce による決定論的コミットメント
// (COMMIT_VERSION/from/merchant/各額/validity/intentSalt/chainId/forwarder) なので、
// **同じ nonce = 同じ支払い**。ところが冪等 claim は route ごとに別 prefix
// (決済 relay = 'relay:idem:' / x402 facilitator = 'x402fac:idem:') で互いを見ないため、
// 同一の署名済 authorization を両入口へ同時 POST すると 2 本とも claim に成功し 2 本 broadcast
// される。2 本目は on-chain の authorizationState で revert するが、その revert 応答で client の
// 送信ラッチが解け「失敗したので standard で送り直す」導線に入りうる (= 二重支払いの窓)。
// route 別 claim は**そのまま残し** (同一入口の重複 POST 応答を一切変えない)、その直後に
// この共有 claim を重ねて入口跨ぎの並行 broadcast だけを止める。
export const SHARED_RECOVER_IDEM_PREFIX = 'relay:recover:idem:';

/** recover 経路用の冪等ヘルパ。route 別 claim (従来) + 入口跨ぎ共有 claim (A7) の二段。
 * 応答形は従来と同一 ('duplicate' → 呼び元は pending を返す)。新しいエラーコードは足さない。 */
export function makeRecoverIdempotency(routePrefix: string): IdempotencyHelpers {
  const route = makeIdempotency(routePrefix);
  const shared = makeIdempotency(SHARED_RECOVER_IDEM_PREFIX, ({ chainId, nonce }) => {
    // A7 (可用性トレードオフの明示): 共有 claim の SET が KV 障害で不確定になると
    // claimIdempotency は fail-safe で duplicate を返すため、**一過性の KV 障害中は
    // 正当な recover が 1 回だけ 202 pending に落ちる**。それでも fail-safe を選ぶのは、
    // ここで first に倒すと入口跨ぎの二重 broadcast (= 2 本目 revert → client の送信
    // ラッチが解けて standard 再送 → 二重支払い) を素通りさせるため。
    // 正当な重複 POST と KV 障害を運用で切り分けられるよう、専用イベント名で warn する。
    logger.warn('relay.recover.shared_claim_unavailable', { chainId, nonce });
  });
  return {
    async claimIdempotency(chainId, from, nonce) {
      // 従来の route 別 claim を先に評価する (同一入口の重複 POST が受け取る
      // 「記録済 txHash 付き pending」を完全に維持するため)。
      const own = await route.claimIdempotency(chainId, from, nonce);
      if (own.status === 'duplicate') return own;
      const cross = await shared.claimIdempotency(chainId, from, nonce);
      if (cross.status === 'duplicate') {
        // もう一方の入口が同じ nonce を保持している (= 進行中 or broadcast 済)、または
        // 共有 claim の SET が KV 障害で不確定 (上の fail-safe)。どちらも自分は
        // broadcast しないので、いま取った route 別 claim は解放する (未送信なのに
        // 30 分の false tombstone を残さない)。応答は従来の重複と同じ pending。
        await route.releaseIdempotency(chainId, from, nonce);
        return cross;
      }
      return { status: 'first' };
    },
    async recordRelayHash(chainId, from, nonce, txHash) {
      await route.recordRelayHash(chainId, from, nonce, txHash);
      // 共有 claim にも hash を載せ、もう一方の入口への重複 POST でも explorer 追跡できるようにする。
      await shared.recordRelayHash(chainId, from, nonce, txHash);
    },
    async releaseIdempotency(chainId, from, nonce) {
      // broadcast 前の失敗でのみ呼ばれる (jpycRelay/forwarderRecover の契約)。両方解放する。
      await route.releaseIdempotency(chainId, from, nonce);
      await shared.releaseIdempotency(chainId, from, nonce);
    },
  };
}
