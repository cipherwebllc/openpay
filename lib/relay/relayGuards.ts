// JPYC relay の共有ガード群 (rate-limit / 日次予算 / idempotency)。決済 relay (/api/relay/jpyc) と
// CSV パス購入 relay (/api/csv-pass/relay) の両方が同一の relayer ウォレット (POL/KAIA) を消費するため、
// 守る資源は共通。とりわけ **rate-limit (relay:rl:) と日次予算 (relay:budget:{chainId}:{YYYYMMDD}) は
// 両 route で同一キーを共有**し、パス購入経由で決済 relay の上限を回避できないようにする (Codex)。
//
// idempotency は route ごとに専用 prefix を持つ (決済=relay:idem: / パス=csvpassrelay:idem:)。これは
// idem が「同一 authorization の重複 POST」を区別するための per-payload キーで、別 route の同 nonce と
// 衝突させない方が安全なため (prefix を引数化し makeIdempotency で束ねる)。
//
// 抽出元は app/api/relay/jpyc/route.ts の同名関数。**挙動は完全に同一** (決済 route の既存テストが
// 無改変で green であることが受け入れ条件)。実依存 (KV) は lib/kv をそのまま使う。

import type { Address, Hex } from 'viem';
import {
  kvLpush,
  kvLrange,
  kvLtrim,
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
// B4: chain 日次の relay 件数上限 (Sybil による POL 枯渇 griefing の circuit breaker)。
export const RELAY_DAILY_TX_CAP = (() => {
  const raw = process.env.RELAY_DAILY_TX_CAP;
  return raw && /^[0-9]+$/.test(raw) ? Number(raw) : 500;
})();
export const IDEM_TTL_SEC = 1800;

// KV sliding-window rate-limit (kv は list ops のみなので timestamp list で近似)。
// KV 未設定時は通す (本番は KV 設定が前提)。**両 route 共有キー** relay:rl: (関所資源が同一 relayer)。
export async function checkRateLimit(keys: string[]): Promise<boolean> {
  if (!isKvConfigured()) return true;
  const now = Date.now();
  for (const key of keys) {
    const k = `relay:rl:${key}`;
    await kvLpush(k, String(now));
    await kvLtrim(k, 0, RL_MAX * 4);
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

// 日次予算カウンタのキー導出 (INCR で消費・DECR で refund する側でキーを完全一致させるため
// 関数に括り出して共有する)。YYYYMMDD は UTC。**両 route 共有キー**。
export const gasBudgetKey = (chainId: number) =>
  `relay:budget:${chainId}:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

// B4: 日次グローバル予算 (Sybil circuit breaker)。INCR relay:budget:{chainId}:{YYYYMMDD} し、
// 初回のみ TTL 2 日。count が cap 以下なら許可。fail-open: KV 未設定/障害は許可 (rate-limit と
// 同方針・alpha は可用性優先)。近似カウンタで足りる (応答喪失の二重カウントは早めに止まる=安全側)。
//
// 返り値 (CDX-5): { allowed, consumed }。
//   allowed  = relay を許可するか。
//   consumed = カウンタを実際に INCR したか。KV 未設定 / INCR 失敗の fail-open allow では INCR して
//              いないので consumed=false。consumed=false の枠を後で DECR (refund) すると、INCR して
//              いないカウンタを減らして負に振れ、cap を超える余剰枠を与えてしまう (= refund しない)。
export async function checkGasBudget(
  chainId: number,
): Promise<{ allowed: boolean; consumed: boolean }> {
  if (!isKvConfigured()) return { allowed: true, consumed: false };
  const key = gasBudgetKey(chainId);
  const r = await kvIncr(key);
  if (!r.ok) {
    logger.warn('relay gas budget INCR failed (fail-open)', { chainId });
    return { allowed: true, consumed: false };
  }
  // EXPIRE は毎回設定する (初回 EXPIRE が応答喪失すると TTL 無しの stale key が永続化するため・
  // Codex P2)。EXPIRE は冪等なので再設定は無害。
  await kvExpire(key, 2 * 24 * 3600);
  return { allowed: r.value <= RELAY_DAILY_TX_CAP, consumed: true };
}

// checkGasBudget で INCR 消費した日次枠を DECR で 1 戻す。tx が 1 件も broadcast されなかった
// ことが確実な失敗でのみ呼ぶ (jpycRelay の refundGasBudget 契約)。日付跨ぎ直後の refund は
// 新しい日の枠を 1 減らすが、減る方向の歪みは安全側 (枠が厳しくなるだけ) で頻度も無視できる。
export async function refundGasBudget(chainId: number): Promise<void> {
  if (!isKvConfigured()) return;
  const r = await kvDecr(gasBudgetKey(chainId));
  if (!r.ok) {
    logger.warn('relay gas budget DECR failed (枠が 1 過消費のまま)', { chainId });
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

// 指定 prefix で idempotency 3 関数を生成する。挙動は抽出元 (relay route) と完全に同一。
export function makeIdempotency(prefix: string): IdempotencyHelpers {
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
