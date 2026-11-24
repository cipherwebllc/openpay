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
/**
 * 控えの書き込みを待つ上限 (ミリ秒)。中継は冪等の記録と並行に控えを書いて両方を待つので、KV の片方だけが遅いときに
 * 中継の応答 (broadcast 済みの支払いの結果) を長く待たせない。時間切れのときは待つのをやめるだけ (書き込みは続く)。
 */
export const RELAY_TX_HINT_WRITE_TIMEOUT_MS = 1_000;

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function relayTxHintKey(chainId: number, from: Address, nonce: Hex): string {
  return `relay:txhint:${chainId}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
}

/**
 * 控えを書く (上書き・置換の tx は最新が勝つ)。reject せず、RELAY_TX_HINT_WRITE_TIMEOUT_MS より長くは待たない。
 * tx hash の形でない値は書かない (先に書いた正しい控えを上書きしない)。
 */
export async function recordRelayTxHint(
  chainId: number,
  from: Address,
  nonce: Hex,
  txHash: Hex,
): Promise<void> {
  if (!TX_HASH_RE.test(txHash)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      kvSet(relayTxHintKey(chainId, from, nonce), txHash, { ttlSec: RELAY_TX_HINT_TTL_SEC }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RELAY_TX_HINT_WRITE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // 控えの書き込みの失敗で、broadcast 済みの中継の応答を失敗にしない (控えが無くても status は今の経路で探す)。
  } finally {
    clearTimeout(timer);
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
