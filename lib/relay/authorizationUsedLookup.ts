// EIP-3009 の AuthorizationUsed ログを、署名が使われうる時刻の範囲に絞って小分けに探す (読むだけ)。
//
// relayProvider.findAuthorizationUsedTransactionHash は直近 10,000 ブロックを 1 回で検索する。無料枠の RPC は 1 回の
// 範囲を制限する (実測 2026-10-08: drpc = 100 ブロック・Alchemy = 10 ブロック) ので、その 1 回が拒まれたときだけ、
// ここで範囲を絞って探す。EIP-3009 の署名は validAfter < block.timestamp < validBefore のブロックでしか使えないので、
// 使われた tx はその時刻のブロックにある。下限は「署名が作られうる最も早い時刻」(validBefore - 有効窓の上限) で絞る
// (呼び出し側が受け付けた有効窓の上限。それより前に使われた署名は見つけない = 結論を出さない側に倒れる)。
//
// 時刻の範囲に入るブロックは、ブロックの時刻で探す (補間と二分を交互に・数回で収まる)。検索は新しいブロックから
// 100 ブロックずつ、拒まれたら 10 ブロックずつ。問い合わせの回数に上限を置き、範囲を探しきれなければ throw する
// (呼び出し側は今の RPC 障害と同じく「結論を出さない」に倒す。見つからなかったとは言わない)。

import type { Hex } from 'viem';

/** 署名の有効期限と、呼び出し側が受け付けた有効窓の上限 (秒)。 */
export type AuthorizationWindow = {
  validAfter: bigint;
  validBefore: bigint;
  maxWindowSec: number;
};

export type AuthorizationLogClient = {
  latestBlock: () => Promise<{ number: bigint; timestamp: bigint }>;
  blockTimestamp: (blockNumber: bigint) => Promise<bigint>;
  /** [fromBlock, toBlock] の対象の AuthorizationUsed ログの tx hash (古い順)。範囲が広すぎれば throw。 */
  logs: (fromBlock: bigint, toBlock: bigint) => Promise<readonly (Hex | null)[]>;
};

export type AuthorizationLookupOptions = {
  /** これより古いブロックは探さない (今の 1 回検索と同じ遡り幅)。 */
  lookbackBlocks: bigint;
  /** 1 回の検索のブロック数 (大きい順・拒まれたら次へ)。 */
  chunkSizes?: readonly bigint[];
  /** 問い合わせの回数の上限 (ブロック時刻の読み取りとログ検索の合計)。 */
  maxRequests?: number;
};

const DEFAULT_CHUNK_SIZES: readonly bigint[] = [100n, 10n];
const DEFAULT_MAX_REQUESTS = 60;

export class AuthorizationLookupIncomplete extends Error {
  constructor(reason: string) {
    super(`authorization_lookup_incomplete:${reason}`);
    this.name = 'AuthorizationLookupIncomplete';
  }
}

/**
 * 署名が使われうる時刻の範囲のブロックで AuthorizationUsed を探し、使った tx hash を返す。
 * 範囲を探しきって無ければ null。探しきれない (問い合わせの上限・最小の範囲でも拒まれる) ときは throw。
 */
export async function findAuthorizationUsedInWindow(
  client: AuthorizationLogClient,
  window: AuthorizationWindow,
  options: AuthorizationLookupOptions,
): Promise<Hex | null> {
  const chunkSizes = options.chunkSizes ?? DEFAULT_CHUNK_SIZES;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  let requests = 0;
  const spend = () => {
    requests += 1;
    if (requests > maxRequests) throw new AuthorizationLookupIncomplete('budget');
  };

  // EIP-3009: validAfter < block.timestamp < validBefore。下限は有効窓の上限でも絞る。
  const earliest = window.validBefore - BigInt(window.maxWindowSec);
  const notBefore = window.validAfter + 1n > earliest ? window.validAfter + 1n : earliest;
  const notAfter = window.validBefore - 1n;
  if (notAfter < notBefore) return null;

  spend();
  const latest = await client.latestBlock();
  // まだ範囲の時刻のブロックが無い (これから使われうる) なら、いまは見つからない。
  if (latest.timestamp < notBefore) return null;
  const lowest = latest.number > options.lookbackBlocks ? latest.number - options.lookbackBlocks : 0n;

  const timestamps = new Map<bigint, bigint>([[latest.number, latest.timestamp]]);
  const timestampOf = async (n: bigint): Promise<bigint> => {
    const known = timestamps.get(n);
    if (known !== undefined) return known;
    spend();
    const t = await client.blockTimestamp(n);
    timestamps.set(n, t);
    return t;
  };

  /** [lo, hi] で時刻が t 以上の最初のブロック (無ければ hi + 1)。ブロックの時刻は単調に増える。 */
  const firstAtOrAfter = async (t: bigint, lo: bigint, hi: bigint): Promise<bigint> => {
    let loTs = await timestampOf(lo);
    if (loTs >= t) return lo;
    let hiTs = await timestampOf(hi);
    if (hiTs < t) return hi + 1n;
    // 不変条件: ts(lo) < t <= ts(hi)。補間と二分を交互に (補間が外れても 2 回に 1 回は半分になる)。
    let interpolate = true;
    while (hi - lo > 1n) {
      let mid: bigint;
      if (interpolate && hiTs > loTs) {
        mid = lo + ((t - loTs) * (hi - lo)) / (hiTs - loTs);
        if (mid <= lo) mid = lo + 1n;
        if (mid >= hi) mid = hi - 1n;
      } else {
        mid = (lo + hi) / 2n;
      }
      interpolate = !interpolate;
      const midTs = await timestampOf(mid);
      if (midTs >= t) {
        hi = mid;
        hiTs = midTs;
      } else {
        lo = mid;
        loTs = midTs;
      }
    }
    return hi;
  };

  const start = await firstAtOrAfter(notBefore, lowest, latest.number);
  // notAfter より後のブロックは探さない (署名はそこでは使えない)。
  const afterEnd = await firstAtOrAfter(notAfter + 1n, start, latest.number);
  const end = afterEnd - 1n;
  if (end < start) return null;

  // 新しいブロックから探す (使われた tx は期限の近くにあることが多い)。
  let size = 0;
  let to = end;
  while (to >= start) {
    const chunk = chunkSizes[size];
    if (chunk === undefined) throw new AuthorizationLookupIncomplete('range');
    const from = to - chunk + 1n > start ? to - chunk + 1n : start;
    spend();
    let hashes: readonly (Hex | null)[];
    try {
      hashes = await client.logs(from, to);
    } catch {
      // 範囲が広すぎる (無料枠の制限) など。小さい範囲で同じ所を探し直す。
      size += 1;
      continue;
    }
    const found = hashes.filter((h): h is Hex => h !== null).at(-1);
    if (found) return found;
    to = from - 1n;
  }
  return null;
}
