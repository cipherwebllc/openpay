// OpenPay 利用料 (a1) の relay 関所ゲート (teeth)。billing 点灯中、利用料が未払いの店主に対しては
// ガスレス中継 (OpenPay がガスを立て替える付加価値) を停止する。顧客の決済自体は standard モード
// (顧客が自分でガスを払う) で無料のまま成立する = コアは無料・ガスレスだけ有料、を体現する。
// 設計: docs/plans/merchant-gasless-fee-a1.md (S5)。
//
// 後払い (arrears) の cadence を尊重する: ある月 M に「課金対象として閉じた前月 (M-1) に請求が
// 生じていて、かつ未払い (fee-current でない)」ときだけ delinquent とみなして遮断する。月初は
// RELAY_GATE_GRACE_DAYS の支払い猶予を置く (前月分を清算する時間)。新規店主・閾値未満・アルファ
// 料率 0% の店主は「前月請求なし」なので遮断されない。KV 障害時は全条件が no-block に倒れ fail-open
// (インフラ不調で決済を壊さない)。

import { type Address } from 'viem';
import { env } from './env';
import { entitlementBypass } from './entitlement';
import { isFeeCurrent } from './feeCurrent';
import { getMeteredCount } from './billingMeter';
import { resolveUsageFeeBps, usageFeeConfig } from './usageFee';

// 月初の支払い猶予日数 (前月分を清算する窓)。例: 7 なら毎月 8 日目から未払い店主を遮断。
export const RELAY_GATE_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

// nowMs の前月を 'YYYY-MM' (UTC) で返す。当月 1 日の前日 = 前月、で年跨ぎも正しく処理する。
export function previousPeriod(nowMs: number): string {
  const d = new Date(nowMs);
  const firstOfThisMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const prev = new Date(firstOfThisMonth - 1);
  const y = prev.getUTCFullYear();
  const m = String(prev.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// 期間 P (支払い対象 = 通常 previousPeriod) の利用料を払うと fee-current とする満了時刻 (ms・UTC)。
// P の 2 か月後の月初 + 猶予。P を払えば gate が P を参照する翌月いっぱい current で、翌々月の
// 月初猶予で次の支払いを促す。**P のみに依存する決定的な値**ゆえ、同一支払いの再付与でも expiry が
// 動かず二重延長を防ぐ (settle の promote 失敗 → replay 対策)。
export function feeCoverageThrough(paidPeriod: string): number {
  const [y, m] = paidPeriod.split('-').map(Number);
  // m は 1-based。(m-1)+2 で「2 か月後の月初」。月 index 12+ は翌年へ正しく桁上がりする。
  return Date.UTC(y, m + 1, 1) + RELAY_GATE_GRACE_DAYS * DAY_MS;
}

// ガスレス中継を遮断すべきか (純関数・判定の単一ソース)。
export function shouldBlockGaslessRelay(input: {
  enabled: boolean; // billing 点灯
  bypass: boolean; // アルファ全開放
  isFeePayment: boolean; // 店主→FEE_RECEIVER の利用料支払い tx (常に通す)
  feeCurrent: boolean; // 店主が支払い済み
  dayOfMonthUtc: number; // 当月の日 (1..31)
  graceDays: number; // 月初猶予
  prevPeriodOwed: boolean; // 前月 (閉じた課金対象期) に請求が生じていたか
}): boolean {
  if (!input.enabled || input.bypass) return false; // billing OFF / アルファ → 遮断しない
  if (input.isFeePayment) return false; // 利用料支払い自体は常に中継する
  if (input.feeCurrent) return false; // 支払い済み → 通す
  if (input.dayOfMonthUtc <= input.graceDays) return false; // 月初の清算猶予
  if (!input.prevPeriodOwed) return false; // 前月に請求なし (新規/閾値未満/0%) → grace
  return true; // 前月に請求あり・未payかつ猶予超過 → 遮断 (delinquent)
}

// 店主 wallet がガスレス中継を遮断されるか (server orchestrator)。早期に確定する no-block では
// 高コストな KV 読み (前月メーター) を省く。最終判定は shouldBlockGaslessRelay に委ねる。
export async function isGaslessRelayBlocked(
  merchant: Address,
  isFeePayment: boolean,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const enabled = env.enableUsageFee;
  const bypass = entitlementBypass();
  if (!enabled || bypass || isFeePayment) return false;

  const feeCurrent = await isFeeCurrent(merchant, nowMs);
  const dayOfMonthUtc = new Date(nowMs).getUTCDate();

  let prevPeriodOwed = false;
  if (!feeCurrent && dayOfMonthUtc > RELAY_GATE_GRACE_DAYS) {
    const prev = previousPeriod(nowMs);
    const rateBps = resolveUsageFeeBps(prev, usageFeeConfig());
    // hot path: O(1) の件数 (LLEN) で「前月に中継があったか」を見る (全イベント LRANGE を回避)。
    // 正確な請求額は settle/invoice の loadUsageInvoice 側。実決済は volume ≥ 1 JPYC ゆえ
    // count>0 ⟺ feeWei>0 (sub-wei 総額は到達不能)。
    prevPeriodOwed = rateBps > 0 && (await getMeteredCount(prev, merchant)) > 0;
  }

  return shouldBlockGaslessRelay({
    enabled,
    bypass,
    isFeePayment,
    feeCurrent,
    dayOfMonthUtc,
    graceDays: RELAY_GATE_GRACE_DAYS,
    prevPeriodOwed,
  });
}
