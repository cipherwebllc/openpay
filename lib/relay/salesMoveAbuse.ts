import 'server-only';

// 売上の移動 (/api/relay/jpyc/move) の「送り先ごとの送り元の数」の集計 (運営の監視ヒント・plans/store-sales-move.md §2.2)。
//
// 何を見るか: この route は、署名した人の JPYC を利用料 2 JPYC で指定の送り先へ移す。お店が自分の別のウォレットへ移す
// ための機能だが、送り先が本人のものかを server は確かめられない (§2.5)。決済の代わりに使われる (多くのお客様が 1 つの
// 送り先へ移す = 決済の 1% を払わずに 2 JPYC で受け取る) と、1 つの送り先に向かう「異なる送り元」が増える。これを
// UTC 月 × chain × 送り先で数え、閾値に届いたら月 1 回 warn する。チップで受容済みの穴 (recoverFeeAvoidance) と同じで、
// この route は穴を広げない (§5)。見える化だけをする。
//
// 数え方: `relay:move:{月}:{chain}:{送り先}:{送り元}` を SET NX (TTL 100 日)。OK (= その月で初めての組) のときだけ
//   `relay:move:{月}:{chain}:{送り先}:senders` を INCR (+ EXPIRE NX)。値が閾値以上なら `…:{送り先}:warned` を SET NX し、
//   取れた request だけが warn する = 送り先 × chain × UTC 月で 1 回。key の末尾はアドレス (0x…) か語 (senders・warned)
//   なので衝突しない。アドレスは小文字に揃える。
// KV の増分: 成功 1 件ごとに SET NX 1 コマンド。その月で初めての組なら INCR + EXPIRE NX の pipeline 1 本 (2 コマンド)。
//   閾値に届いた送り先は、その月の以後の新しい送り元ごとに marker の SET NX が 1 回増える。
// 数え漏れ: 組の SET NX が通った後に INCR が失敗すると、その送り元はその月はもう数えない (監視のヒントなので受容)。
//
// no-throw: 記録は応答後 (after) に回し、KV・logger の失敗を成功済みの移動の応答へ波及させない (掟 13)。
// 移動の可否・金額・応答には一切関与しない。

import { after } from 'next/server';
import { kvIncr, kvSet } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const SALES_MOVE_SENDERS_TTL_SEC = 100 * 24 * 3600;
// 送り先 × chain × UTC 月の異なる送り元の閾値 (Q5・user 確定 2026-11-07)。お店が自分の端末や家族の
// ウォレットからまとめる程度なら届かず、お客様の支払いの受け口として使われていれば届く数。
export const SALES_MOVE_SENDERS_WARN = 5;

type SalesMoveSenderInput = {
  chainId: number;
  // forwarder.settle の merchant (= 移した先)。
  destination: string;
  // 署名した払い元 (= 移した人)。
  sender: string;
};

export function salesMoveSenderKeys(
  month: string,
  chainId: number,
  destination: string,
  sender: string,
): { pair: string; senders: string; warned: string } {
  const base = `relay:move:${month}:${chainId}:${destination.toLowerCase()}`;
  return {
    pair: `${base}:${sender.toLowerCase()}`,
    senders: `${base}:senders`,
    warned: `${base}:warned`,
  };
}

/** 移動の成功後に呼ぶ。集計を応答後に予約する。同期部分も含めて throw しない。 */
export function recordSalesMoveSenderAfterResponse(input: SalesMoveSenderInput): void {
  const run = () => recordSalesMoveSender(input);
  try {
    after(run);
  } catch {
    // request scope の外 (テスト等) では after() が throw する。集計だけをその場で走らせる (lib/metrics と同じ形)。
    void run();
  }
}

/** 1 件を集計し、閾値に届いていれば送り先 × chain × UTC 月で 1 回だけ warn する。失敗しても throw しない。 */
export async function recordSalesMoveSender(
  input: SalesMoveSenderInput & { nowMs?: number },
): Promise<void> {
  try {
    const month = new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 7);
    const keys = salesMoveSenderKeys(month, input.chainId, input.destination, input.sender);
    const pair = await kvSet(keys.pair, '1', { nx: true, ttlSec: SALES_MOVE_SENDERS_TTL_SEC });
    if (!pair.ok) {
      // 書き込みの失敗は数え漏れとして見えるようにする (KV 未設定の手元・テストは対象外)。
      if (pair.reason !== 'unconfigured') {
        logger.warn('relay.move.sender_record_failed', { chainId: input.chainId, reason: pair.reason });
      }
      return;
    }
    // 既に数えた組 (同じ月に同じ送り元から同じ送り先へ 2 回目以降)。
    if (pair.value !== 'OK') return;

    const senders = await kvIncr(keys.senders, { initialTtlSec: SALES_MOVE_SENDERS_TTL_SEC });
    if (!senders.ok) {
      if (senders.reason !== 'unconfigured') {
        logger.warn('relay.move.sender_record_failed', { chainId: input.chainId, reason: senders.reason });
      }
      return;
    }
    if (senders.value < SALES_MOVE_SENDERS_WARN) return;
    // 月の marker を SET NX し、取れた request だけが warn する。KV 障害で取れなければ warn を省き、同じ月の次の
    // 新しい送り元の request が再試行する。
    const marker = await kvSet(keys.warned, '1', { nx: true, ttlSec: SALES_MOVE_SENDERS_TTL_SEC });
    if (!marker.ok || marker.value !== 'OK') return;
    logger.warn('relay.move.many_senders', {
      chainId: input.chainId,
      destination: input.destination,
      month,
      senders: senders.value,
    });
  } catch {
    // 集計 (KV・logger) の例外を、after() の後続処理や移動の応答へ波及させない。
  }
}
