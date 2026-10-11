// 共有日次予算 relay:budget:{chainId}:{YYYYMMDD} (決済 relay・CSV パス・x402 facilitator で共有。
// RELAY_DAILY_TX_CAP・既定 500 件) の残量監視。checkGasBudget が INCR で得た件数から、80% 到達と
// 枯渇 (= cap を超えて daily_budget_exceeded を返し始めた初回) を chain × UTC 日で 1 回ずつ warn する。
// 以前は枯渇しても拒否の応答 (503) が出るだけでログが無く、ガスレス中継と x402 の settle が
// その UTC 日の残りずっと止まっていても運営が気づけなかった。
//
// - 1 回だけ: marker を SET NX し、取れた request だけが warn する (payment-log の日次枠と同じ形)。
//   instance をまたいでも重複しない。marker の書き込みに失敗したら warn を省き、次の対象 request で再試行する。
// - 応答後: marker の SET と warn は after() で応答後に回す。relay の可否・応答・遅延には関与しない (掟 12)。
// - KV の増分: 件数が 80% 未満の日は 0。80% 以上の request ごとに SET NX が 1 回 (cap 500 なら 400〜500 件目の
//   最大 101 回と、枯渇後の拒否 1 件ごとに 1 回)。拒否される request は rate-limit・idempotency・INCR で
//   既に 10 前後のコマンドを使っているので、増分はその 1 割程度。

import { after } from 'next/server';
import { kvSet } from '@/lib/kv';
import { logger } from '@/lib/logger';

export type GasBudgetAlertLevel = 'near_exhausted' | 'exhausted';

// marker の TTL は予算カウンタと同じ 2 日。key に UTC 日付が入るので、翌日の判定とは独立。
const MARKER_TTL_SEC = 2 * 24 * 3600;

/** cap の 80% (切り上げ)。cap 500 なら 400 件目で到達。 */
export function gasBudgetNearThreshold(cap: number): number {
  return Math.ceil((cap * 4) / 5);
}

/** INCR 後の件数がどの警告の対象か。cap 超過 = 拒否された request (= 枯渇)。 */
export function gasBudgetAlertLevel(
  count: number,
  cap: number,
): GasBudgetAlertLevel | null {
  if (count > cap) return 'exhausted';
  if (cap > 0 && count >= gasBudgetNearThreshold(cap)) return 'near_exhausted';
  return null;
}

/** chain × UTC 日 × 警告の種類ごとの marker。日付は INCR した予算 key から取る (日跨ぎで別の日にずれない)。 */
export function gasBudgetAlertMarkerKey(
  chainId: number,
  budgetKey: string,
  level: GasBudgetAlertLevel,
): string {
  const day = budgetKey.slice(budgetKey.lastIndexOf(':') + 1);
  return `relay:budget-alert:${chainId}:${day}:${level}`;
}

type GasBudgetAlertInput = {
  chainId: number;
  // checkGasBudget が INCR した UTC 日付入りの key (relay:budget:{chainId}:{YYYYMMDD})。
  budgetKey: string;
  // INCR 後の件数。
  count: number;
  cap: number;
};

/**
 * 80% 到達・枯渇の対象なら、1 回だけの warn を応答後に予約する。対象外なら何もしない (KV を引かない)。
 * 同期部分も含めて throw しない: relay の予算判定 (checkGasBudget) の中から呼ばれるため。
 */
export function scheduleGasBudgetAlert(input: GasBudgetAlertInput): void {
  const level = gasBudgetAlertLevel(input.count, input.cap);
  if (level === null) return;
  const run = () => warnGasBudgetOnce(input, level);
  try {
    after(run);
  } catch {
    // request scope の外 (テスト・script) では after() が throw する。監視だけをその場で走らせ、
    // 予算判定の戻り値には関与させない (lib/metrics と同じ形)。
    void run();
  }
}

async function warnGasBudgetOnce(
  input: GasBudgetAlertInput,
  level: GasBudgetAlertLevel,
): Promise<void> {
  try {
    const marker = await kvSet(
      gasBudgetAlertMarkerKey(input.chainId, input.budgetKey, level),
      '1',
      { nx: true, ttlSec: MARKER_TTL_SEC },
    );
    // 取れなかった (別の request が先に warn 済み) / KV 障害は warn しない。障害時は次の対象 request が再試行する。
    if (!marker.ok || marker.value !== 'OK') return;
    const fields = {
      chainId: input.chainId,
      day: input.budgetKey.slice(input.budgetKey.lastIndexOf(':') + 1),
      count: input.count,
      cap: input.cap,
    };
    if (level === 'exhausted') {
      logger.warn('relay.budget.exhausted', fields);
    } else {
      logger.warn('relay.budget.near_exhausted', fields);
    }
  } catch {
    // 監視 (KV・logger) の例外を、after() の後続処理や relay の応答へ波及させない (掟 13)。
  }
}
