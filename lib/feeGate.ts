// OpenPay 利用料 (a1) の relay 関所ゲート (teeth)。billing 点灯中、利用料が未払いの店主に対しては
// ガスレス中継 (OpenPay がガスを立て替える付加価値) を停止する。顧客の決済自体は standard モード
// (顧客が自分でガスを払う) で無料のまま成立する = コアは無料・ガスレスだけ有料、を体現する。
// 設計: docs/plans/merchant-gasless-fee-a1.md (S5)。
//
// 後払い (arrears) の cadence を尊重する: ある月 M に「課金対象として閉じた過去の期間 (lookback 内)
// のいずれかに請求が生じていて、かつ未払い (fee-current でなく支払い済みマーカーも無い)」ときだけ
// delinquent とみなして遮断する。月初は RELAY_GATE_GRACE_DAYS の支払い猶予を置く (未払い分を清算する
// 時間)。新規店主・閾値未満・アルファ料率 0% の店主は「請求なし」なので遮断されない。KV 障害時は
// 全条件が no-block に倒れ fail-open (インフラ不調で決済を壊さない)。
//
// 旧実装は前月 (M-1) のみを参照したため、遮断された店主が翌月の中継を止めると翌々月には「前月請求
// なし」となり古い未収月の債務が永久にすり抜けた。これを塞ぐため lookback 内の全期間を見る (REM-3)。
// 同時に settle/invoice 側で「古い期間を選んで清算する」手段を入れている (払えないのに遮断、を避ける)。

import { type Address } from 'viem';
import { env } from './env';
import { entitlementBypass } from './alphaBypass';
import { isFeeCurrent, getFeeStatus, getUnpaidPeriods } from './feeCurrent';
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

// 当月の猶予が終わり延滞遮断が始まる瞬間 (ms・UTC)。day=(grace+1) の 00:00 UTC。
// 予告バナー (BillingDueBanner) が「この時刻以降ガスレス/履歴が止まる」と告知するのに使う。
// shouldBlockGaslessRelay の `dayOfMonthUtc <= graceDays` 条件と整合 (day grace+1 から遮断)。
export function graceEndsAt(nowMs: number): number {
  const d = new Date(nowMs);
  return (
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) +
    RELAY_GATE_GRACE_DAYS * DAY_MS
  );
}

// ゲートが遡って未払いを探す期間数 (月)。これより古い債務は **意図的に forgive** する。
// 理由を正直に開示しておく: (1) 1 判定あたり最大 lookback×2 回の KV 読みで止めるコスト上限、
// (2) あまりに古い未収を永久に追い続けるのはプロダクト方針として採らない (12 か月で時効扱い)。
export const OWED_LOOKBACK_MONTHS = 12;

// 'YYYY-MM' (period) の 1 か月前を返す (年跨ぎ桁下げ正しく処理)。
function priorPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)); // m は 1-based・(m-1)-1 = m-2
  const yy = prev.getUTCFullYear();
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

// 延滞判定で清算対象となりうる「閉じた期間」の候補列を新しい順で返す。
// 範囲 = max(startPeriod, lookback か月前) 〜 previousPeriod(nowMs)。当月 (= まだ閉じていない) は
// 含めない。startPeriod が null (= 課金未点灯) のときは空配列 (請求が生じる余地なし)。
// settle の period 範囲検証と invoice の owed 一覧、ゲートの未払い探索が同じ閉区間を共有する単一ソース。
export function owedCandidatePeriods(
  nowMs: number,
  startPeriod: string | null,
  lookbackMonths: number = OWED_LOOKBACK_MONTHS,
): string[] {
  if (!startPeriod) return [];
  const newest = previousPeriod(nowMs); // 直近の閉じた期間 (= 前月)
  // lookback 下限: newest から (lookback-1) か月遡った期間。'YYYY-MM' は辞書順=時系列順。
  let lowerByLookback = newest;
  for (let i = 1; i < lookbackMonths; i++) {
    lowerByLookback = priorPeriod(lowerByLookback);
  }
  const lower = startPeriod > lowerByLookback ? startPeriod : lowerByLookback;
  if (lower > newest) return []; // startPeriod が未来 (まだ閉じた期間が無い) → 空
  const out: string[] = [];
  for (let p = newest; p >= lower; p = priorPeriod(p)) out.push(p);
  return out; // 新しい順
}

// ガスレス中継を遮断すべきか (純関数・判定の単一ソース)。
export function shouldBlockGaslessRelay(input: {
  enabled: boolean; // billing 点灯
  bypass: boolean; // アルファ全開放
  isFeePayment: boolean; // 店主→FEE_RECEIVER の利用料支払い tx (常に通す)
  feeCurrent: boolean; // 店主が支払い済み
  dayOfMonthUtc: number; // 当月の日 (1..31)
  graceDays: number; // 月初猶予
  owedUnpaid: boolean; // lookback 内の閉じた期間のどれかに請求があり未払いか
}): boolean {
  if (!input.enabled || input.bypass) return false; // billing OFF / アルファ → 遮断しない
  if (input.isFeePayment) return false; // 利用料支払い自体は常に中継する
  if (input.feeCurrent) return false; // 支払い済み → 通す
  if (input.dayOfMonthUtc <= input.graceDays) return false; // 月初の清算猶予
  if (!input.owedUnpaid) return false; // lookback 内に未払い請求なし (新規/閾値未満/0%/全清算済) → grace
  return true; // lookback 内に未払い請求あり・猶予超過 → 遮断 (delinquent)
}

// 店主 wallet がガスレス中継を遮断されるか (server orchestrator)。早期に確定する no-block では
// 高コストな KV 読み (メーター/マーカー) を省く。最終判定は shouldBlockGaslessRelay に委ねる。
//
// feeCurrent 短絡・月初 grace 短絡は維持する: fee-current (= 現行カバレッジ中) は通す、はプロダクトの
// 約束。ただしカバレッジ失効後は、lookback 内の **全未払い期間** を清算するまで遮断される (古い未収を
// 翌々月以降にすり抜けさせない)。未払いの探索は delinquent 候補に入った cold path のみで行う。
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

  let owedUnpaid = false;
  if (!feeCurrent && dayOfMonthUtc > RELAY_GATE_GRACE_DAYS) {
    const cfg = usageFeeConfig();
    const candidates = owedCandidatePeriods(nowMs, cfg.startPeriod);
    // 「請求があった」期間 = 料率 > 0 かつ中継件数 > 0。count は O(1) (LLEN)。正確な請求額は
    // settle/invoice の loadUsageInvoice 側。実決済は volume ≥ 1 JPYC ゆえ count>0 ⟺ feeWei>0。
    // 候補は最大 12 件・delinquent 候補のみの cold path なので KV 読みは Promise.all で並列化する。
    const billed = (
      await Promise.all(
        candidates.map(async (p) => {
          const rateBps = resolveUsageFeeBps(p, cfg);
          if (rateBps <= 0) return null;
          return (await getMeteredCount(p, merchant)) > 0 ? p : null;
        }),
      )
    ).filter((p): p is string => p !== null);

    if (billed.length > 0) {
      // 請求のあった期間のうち、支払い済みマーカーが無いものを抽出 (並列読み・fail-open)。
      const unpaid = await getUnpaidPeriods(merchant, billed);
      // マーカー導入前に settle した直近 1 期間は lastPaidPeriod で後方互換的に支払い済みとみなす。
      const lastPaid = (await getFeeStatus(merchant, nowMs)).lastPaidPeriod;
      owedUnpaid = unpaid.some((p) => p !== lastPaid);
    }
  }

  return shouldBlockGaslessRelay({
    enabled,
    bypass,
    isFeePayment,
    feeCurrent,
    dayOfMonthUtc,
    graceDays: RELAY_GATE_GRACE_DAYS,
    owedUnpaid,
  });
}
