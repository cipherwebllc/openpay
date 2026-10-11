import 'server-only';

// recover 決済の「1% 回避」の集計 (運営の監視ヒント)。
//
// gasMode は署名対象ではない料金表の選択で、チップの料金表 (customer = ガス相当のフロアだけ) を選べば、
// 決済の料金表 (merchant = max(フロア, 決済額 × bps/10000)) の 1% を払わずに済む。2026-06-12 にこれを受容した
// (チップのリンクやチップ画面で売上を受け取れば店主は 1% を避けられる。お客単独でも成立し、gasMode を署名に
// 入れてもコントラクトを再デプロイしても塞がらない = チップは正当に customer の料金表で、売上と区別できない)。
// 受容の前提 (今の規模では実損が小さい) が崩れたことに気づけるよう、回避が起きた件を受取アドレスごとに数える。
//
// 数える対象: recover の成功のうち gasMode=customer・feeKind なし (モバイル注文の利用料ではない)・
//   決済額 × bps/10000 がフロアを超える件 (= merchant の料金表なら 1% がフロアより高くついた件)。
// 数え方: UTC 月 × chain × 受取アドレスの key に件数 (INCR) と免れた額 (INCRBY・0.01 JPYC 単位) を足す。
//   TTL は 100 日 (当月と前 2 か月を読める)。件数か額が月の閾値に届いたら、両方で共有する月の marker
//   (`…:warned`) を SET NX し、取れた request だけが warn する = 受取アドレス × chain × UTC 月で 1 回だけ。
// KV の増分: 対象 1 件ごとに 4 コマンド (INCR + EXPIRE NX と INCRBY + EXPIRE NX の pipeline 2 本)。閾値に届いた
//   受取アドレスは、その月の以後の件で marker の SET NX が 1 回ずつ増える。対象外の決済は 0。
//
// no-throw: 判定と記録は応答後 (after) に回し、KV・logger の失敗を成功済みの決済応答へ波及させない (掟 13)。
// 決済の可否・金額・応答には一切関与しない (掟 12: 追加のみ)。

import { after } from 'next/server';
import type { GasMode } from '@/lib/fee';
import { kvIncr, kvIncrBy, kvSet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { recoverFeeBps } from '@/lib/relay/recoverFee';

// 0.01 JPYC (18 decimals)。免れた額をこの単位で数える (64bit の INCRBY に wei は収まらない)。
const CENTI_JPYC_WEI = 10n ** 16n;
export const FEE_AVOIDANCE_TTL_SEC = 100 * 24 * 3600;
// 受取アドレス × chain × UTC 月の閾値。どちらかに届いたら 1 回 warn する。
//   件数 30 = 1 日 1 件ほどフロアを超える額 (Polygon・Kaia なら 200 JPYC 超) をチップで受けている。
//   額 1,000 JPYC = チップ経由の受け取りが月 10 万 JPYC 規模 (その 1% から回収済みのフロアを引いた額)。
export const FEE_AVOIDANCE_WARN_COUNT = 30;
export const FEE_AVOIDANCE_WARN_JPYC = 1_000;

type FeeAvoidanceInput = {
  chainId: number;
  // 店主の受取アドレス (forwarder.settle の merchant)。
  receiver: string;
  gasMode: GasMode;
  // モバイル注文の利用料の種別 (server が採用したもの)。付いていれば 1% 回避ではない。
  feeKind: string | undefined;
  merchantValue: bigint;
  // server が強制した手数料 (customer の料金表ではフロア)。
  feeValue: bigint;
};

/** merchant の料金表なら掛かった額から、実際の手数料を引いた額 (wei)。回避が無ければ 0。 */
export function avoidedRecoverFeeWei(
  input: Pick<FeeAvoidanceInput, 'gasMode' | 'feeKind' | 'merchantValue' | 'feeValue'>,
): bigint {
  if (input.gasMode !== 'customer' || input.feeKind !== undefined) return 0n;
  const percent = (input.merchantValue * BigInt(recoverFeeBps())) / 10000n;
  return percent > input.feeValue ? percent - input.feeValue : 0n;
}

export function feeAvoidanceKeys(
  month: string,
  chainId: number,
  receiver: string,
): { count: string; avoided: string; warned: string } {
  const base = `relay:fee-avoid:${month}:${chainId}:${receiver.toLowerCase()}`;
  return {
    count: `${base}:count`,
    avoided: `${base}:avoided_cjpyc`,
    warned: `${base}:warned`,
  };
}

/**
 * recover の成功後に呼ぶ。1% 回避の件なら集計を応答後に予約する。対象外なら何もしない (KV を引かない)。
 * 同期部分も含めて throw しない。
 */
export function recordRecoverFeeAvoidanceAfterResponse(input: FeeAvoidanceInput): void {
  try {
    const avoidedWei = avoidedRecoverFeeWei(input);
    if (avoidedWei <= 0n) return;
    const run = () =>
      recordRecoverFeeAvoidance({
        chainId: input.chainId,
        receiver: input.receiver,
        avoidedWei,
      });
    try {
      after(run);
    } catch {
      // request scope の外 (テスト等) では after() が throw する。集計だけをその場で走らせる (lib/metrics と同じ形)。
      void run();
    }
  } catch {
    // 判定 (料率の読み出し等) の例外を、成功済みの決済応答へ波及させない。
  }
}

/** 1 件を集計し、月の閾値に届いていれば月 1 回だけ warn する。失敗しても throw しない。 */
export async function recordRecoverFeeAvoidance(input: {
  chainId: number;
  receiver: string;
  avoidedWei: bigint;
  nowMs?: number;
}): Promise<void> {
  try {
    const month = new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 7);
    const keys = feeAvoidanceKeys(month, input.chainId, input.receiver);
    const centi = Number(input.avoidedWei / CENTI_JPYC_WEI);
    const opts = { initialTtlSec: FEE_AVOIDANCE_TTL_SEC };
    const count = await kvIncr(keys.count, opts);
    const avoided = await kvIncrBy(keys.avoided, centi, opts);

    // 書き込みの失敗は数え漏れとして見えるようにする (KV 未設定の手元・テストは対象外)。
    for (const result of [count, avoided]) {
      if (!result.ok && result.reason !== 'unconfigured') {
        logger.warn('relay.recover.fee_avoidance_record_failed', {
          chainId: input.chainId,
          reason: result.reason,
        });
        break;
      }
    }

    const countReached = count.ok && count.value >= FEE_AVOIDANCE_WARN_COUNT;
    const amountReached =
      avoided.ok && avoided.value >= FEE_AVOIDANCE_WARN_JPYC * 100;
    if (!countReached && !amountReached) return;
    // 件数と額で共有する月の marker を SET NX し、取れた request だけが warn する。片方の閾値を越えた後に
    // もう片方を越えても、同じ月に 2 回目は出さない。marker が KV 障害で取れなければ warn を省き、
    // 同じ月の次の対象 request が再試行する。
    const marker = await kvSet(keys.warned, '1', {
      nx: true,
      ttlSec: FEE_AVOIDANCE_TTL_SEC,
    });
    if (!marker.ok || marker.value !== 'OK') return;
    logger.warn('relay.recover.fee_avoidance', {
      chainId: input.chainId,
      receiver: input.receiver,
      month,
      count: count.ok ? count.value : null,
      avoidedJpyc: avoided.ok ? avoided.value / 100 : null,
      trigger: countReached && amountReached ? 'count+amount' : countReached ? 'count' : 'amount',
    });
  } catch {
    // 集計 (KV・logger) の例外を、after() の後続処理や決済応答へ波及させない。
  }
}
