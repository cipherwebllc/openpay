// 中継が broadcast した tx の控え (7 日)。応答を失った支払いを、冪等の記録 (relay:idem:・30 分) が消えた後にも
// 照会 (app/api/relay/jpyc/status) で確かめられるようにする。
//
// なぜ要るか (2026-11-24 Sentry): 冪等の記録が消えると、status は直近 10,000 ブロックの eth_getLogs で tx を探す。本番の
// Polygon は無料枠の RPC (100 ブロックまで) なので拒まれ、決済済みでも「確認中」(indeterminate) のままになっていた。
// tx hash が分かれば receipt を直接読める (範囲の制限がない)。
//
// 控えは「tx を探す手がかり」で、成立の根拠ではない。status は used を確かめた後にだけ読み、receipt が意図と一致した
// ときだけ settled にする (unused の判定には使わない: 送った tx が落ちて未使用のままの支払いは、冪等の記録が消えた後に
// unused に戻って払い直せる)。冪等の記録 (claim・重複 POST・注文の予約) とは別の鍵にし、その意味を変えない。

import type { Address, Hex } from 'viem';
import { after } from 'next/server';
import { isKvConfigured, kvGet, kvSet } from '@/lib/kv';

/** 控えを書く冪等の名前空間。status (app/api/relay/jpyc/status) が読む決済 relay のものだけ。 */
export const RELAY_TX_HINT_IDEM_PREFIX = 'relay:idem:';
/** 控えの保持 (秒)。タブを開いたままの翌日・週末明けの開き直しまで覆う。 */
export const RELAY_TX_HINT_TTL_SEC = 7 * 24 * 60 * 60;
/**
 * 控えを読むのを待つ上限 (ミリ秒)。KV は 1 往復 5 秒まで待つ (lib/kv.ts) ので、遅いときに端末の照会の期限 (10 秒) を
 * 使い切らせず、今の経路 (getLogs) に落とす。
 */
export const RELAY_TX_HINT_READ_TIMEOUT_MS = 1_200;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function relayTxHintKey(chainId: number, from: Address, nonce: Hex): string {
  return `relay:txhint:${chainId}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
}

// 同じ鍵への書き込みを、このプロセスの中で送った順に 1 つずつ送る (broadcast 直後の hash の SET が遅れて、置換後の
// hash の SET より後に届いて上書きするのを防ぐ・中継は 1 件の支払いを 1 つの関数の中で記録する)。
const writeChains = new Map<string, Promise<void>>();

/**
 * 控えを書く (上書き・置換の tx は最新が勝つ)。reject しない。同じ鍵への前の書き込みが終わってから送る。
 * tx hash の形でない値は書かない (先に書いた正しい控えを上書きしない)。
 */
export function recordRelayTxHint(chainId: number, from: Address, nonce: Hex, txHash: Hex): Promise<void> {
  if (!TX_HASH_RE.test(txHash)) return Promise.resolve();
  const key = relayTxHintKey(chainId, from, nonce);
  const previous = writeChains.get(key) ?? Promise.resolve();
  const write = previous.then(async () => {
    try {
      await kvSet(key, txHash, { ttlSec: RELAY_TX_HINT_TTL_SEC });
    } catch {
      // 控えの書き込みの失敗で、broadcast 済みの中継を失敗にしない (控えが無くても status は今の経路で探す)。
    }
  });
  writeChains.set(key, write);
  void write.then(() => {
    if (writeChains.get(key) === write) writeChains.delete(key);
  });
  return write;
}

/**
 * 控えを書き始め、待たずに戻る (中継の冪等の記録・共有 claim の記録・poll・応答を控えの書き込みで遅らせない)。
 * 応答の後も書き終えるまで関数を止めないよう after() に渡す (掟 12)。リクエストの外 (テスト等) では after() が投げるので、
 * 書き込みはそのまま進める。
 */
export function scheduleRelayTxHint(chainId: number, from: Address, nonce: Hex, txHash: Hex): void {
  const write = recordRelayTxHint(chainId, from, nonce, txHash);
  try {
    // 書き込みはもう始まっている。after() には待つための関数を渡す (応答の後に、終わるまで関数を止めない)。
    after(() => write);
  } catch {
    void write;
  }
}

/**
 * 控えを読む。無い・KV が未設定・失敗・形が違う・時間切れはすべて null (reject しない)。
 * null は「控えが無い」の意味で、呼び出し側は今の経路 (getLogs) に進む。
 */
export async function readRelayTxHint(chainId: number, from: Address, nonce: Hex): Promise<Hex | null> {
  if (!isKvConfigured()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      kvGet(relayTxHintKey(chainId, from, nonce)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RELAY_TX_HINT_READ_TIMEOUT_MS);
      }),
    ]);
    if (!result || !result.ok) return null;
    const value = result.value;
    return typeof value === 'string' && TX_HASH_RE.test(value) ? (value as Hex) : null;
  } catch {
    // 控えの読み取りの失敗を照会の失敗 (外側の catch = indeterminate) にしない。今の経路 (getLogs) で探せる。
    return null;
  } finally {
    clearTimeout(timer);
  }
}
