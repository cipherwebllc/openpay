// 表示 / CSV / 集計向けの派生値 (手数料内訳・明細の補完・合計・日付キー・当日 summary)。純関数のみ。
// localStorage の読み書きは storage.ts 側。LP の TodayCard の bundle に載るため重い依存を足さない
// (isIncomeSaleEntry の注記を参照)。

import { formatUnits } from 'viem';
import { pad } from '../pad';
import { lineItemsTax, taxDisplayDecimals } from '../tax';
import {
  FEE_BREAKDOWN_VERSION,
  HISTORY_ASSET_DECIMALS,
  type HistoryEntry,
  type HistoryLineItem,
} from './model';

/** 表示 / 集計用にネットワーク手数料相当額を解決する (provider 横断で coalesce)。
 * 非 circle 経路は networkFeeEquivalent、circle 経路は circlePaymasterNetUsdc
 * (検証ステータスは circleVerification 側に保持)。どちらも無ければ null。 */
export function networkFeeEquivalentOf(entry: HistoryEntry): string | null {
  return entry.networkFeeEquivalent ?? entry.circlePaymasterNetUsdc;
}

/** fee/gas 内訳が分離記録済 (native v3) か。legacy / migrated は false
 * (利用手数料 / 網手数料の集計から除外する判定に使う)。 */
export function hasSeparatedBreakdown(entry: HistoryEntry): boolean {
  return entry.feeBreakdownVersion >= FEE_BREAKDOWN_VERSION;
}

// raw wei → 人間可読 decimal 文字列 (非数値は "0")。lineItem 補完・集計で使う。
function rawToDecimalStr(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return '0';
  return formatUnits(BigInt(raw), decimals);
}

/**
 * 表示 / CSV / freee 用に正規化済みの売上明細を返す (記帳補助)。currency←asset / id←合成 /
 * taxAmount←税率ごとに 1 回の端数処理 (lineItemsTax) で補完する。
 *   - lineItems があれば各行を補完して返す。
 *   - 無くても productName があれば「仮想 1 行」を合成 (req: 既存単品を lineItems へ変換)。
 *   - 商品情報の無い legacy (productName なし) は []。
 */
export function entryLineItems(entry: HistoryEntry): HistoryLineItem[] {
  const lines = rawEntryLineItems(entry);
  const { lineTax } = entryLineItemsTax(lines, entry);
  return lines.map((li, i) => ({
    ...li,
    id: li.id ?? `${entry.id}-${i}`,
    currency: li.currency ?? entry.asset,
    taxAmount: lineTax[i],
  }));
}

// 保存された明細 (無ければ productName の仮想 1 行・どちらも無ければ [])。
function rawEntryLineItems(entry: HistoryEntry): HistoryLineItem[] {
  if (entry.lineItems && entry.lineItems.length > 0) return entry.lineItems;
  if (entry.productName) {
    const amount = rawToDecimalStr(
      entry.merchantAmount,
      HISTORY_ASSET_DECIMALS[entry.asset],
    );
    return [
      {
        name: entry.productName,
        quantity: 1,
        unitPrice: amount,
        amount,
        taxRate: entry.taxRate,
        taxCategory: entry.taxCategory,
        memo: entry.memo,
      },
    ];
  }
  return [];
}

/**
 * 派生集計 (token 単位)。税込前提なので subtotal === total (= 着金額)、totalTax は税率ごとに 1 回の端数処理
 * (lineItemsTax・インボイスと同じ)。保存はせず明細 / merchantAmount から都度算出 (drift 回避)。
 */
export function entryTotals(entry: HistoryEntry): {
  subtotal: string;
  totalTax: string;
  total: string;
} {
  const total = rawToDecimalStr(
    entry.merchantAmount,
    HISTORY_ASSET_DECIMALS[entry.asset],
  );
  const items = rawEntryLineItems(entry);
  // 明細は無いが entry に税率がある (商品名なしで税だけ指定した単品 QR 等) → 合計の 1 行から算出。
  const taxLines = items.length > 0
    ? items
    : entry.taxRate != null
      ? [{ amount: total, taxRate: entry.taxRate }]
      : [];
  return { subtotal: total, totalTax: entryLineItemsTax(taxLines, entry).totalTax, total };
}

// 明細の消費税額 (税率ごとに 1 回の端数処理・lib/tax.ts の lineItemsTax) を entry の通貨の桁で。
function entryLineItemsTax(
  items: Parameters<typeof lineItemsTax>[0],
  entry: HistoryEntry,
): ReturnType<typeof lineItemsTax> {
  return lineItemsTax(items, HISTORY_ASSET_DECIMALS[entry.asset], taxDisplayDecimals(entry.asset));
}

/** 数値 timestamp を yyyy-MM-dd HH:mm:ss (locale 形式) に整形。CSV にも UI にも使う。 */
export function formatHistoryTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ============================================================================
// 「今日のお店」ダッシュボード用 summary (LP を毎朝開く理由)。
//
// LP は Server Component のまま、Hero 直下の小さな client カードがこの派生 summary
// だけを読む (履歴本体 1000 件を parse しない)。履歴変更時に当日分だけを再構築する。
// 金額は raw atomic (wei) を BigInt で厳密
// 加算する (float 厳禁・端数誤差ゼロ)。真実点は履歴本体で、これはあくまでキャッシュ。
// ============================================================================

/** merchant (受取ウォレット) 単位の当日集計。金額は raw atomic (bigint 文字列)。 */
export type TodayMerchantSummary = {
  /** 当日の成約件数 (success の売上 leg のみ)。 */
  count: number;
  /** JPYC 着金合計 (raw atomic・18 decimals)。 */
  jpycAtomic: string;
  /** USDC 着金合計 (raw atomic・6 decimals)。 */
  usdcAtomic: string;
  /** 最終着金の timestamp (Date.now())。 */
  lastTs: number;
};

/** 当日の売上 summary。date はローカル TZ の YYYY-MM-DD。 */
export type TodaySummary = {
  date: string;
  byMerchant: Record<string, TodayMerchantSummary>;
};

/** ローカル TZ の YYYY-MM-DD キー (UTC ではなく端末ローカル日付で 1 日を区切る)。 */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 当日 summary の raw atomic → 表示用の数値 (表示の丸めだけに使い、累積はしない)。summary は localStorage の値なので、
// 数字以外 (壊れた値) は 0 にする (BigInt の例外で LP / 販売画面の描画を止めない)。
export function todayAtomicToNumber(atomic: string, decimals: number): number {
  if (!/^\d+$/.test(atomic)) return 0;
  return Number(formatUnits(BigInt(atomic), decimals));
}

// raw atomic (10進整数文字列) を BigInt で安全に加算。非数値は 0 とみなす (float 不使用)。
function addAtomic(a: string, b: string): string {
  const av = /^\d+$/.test(a) ? BigInt(a) : 0n;
  const bv = /^\d+$/.test(b) ? BigInt(b) : 0n;
  return (av + bv).toString();
}

/** 保存済 summary の shape を軽く検証 (corrupt / 旧版データで card を壊さない)。 */
export function isValidTodaySummary(value: unknown): value is TodaySummary {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.date !== 'string') return false;
  if (v.byMerchant === null || typeof v.byMerchant !== 'object') return false;
  return true;
}

// 収入(売上)行の判定。**historyFilters.isIncomeSaleEntry と同一条件**の純 predicate をここに複製する。
// 理由: historyFilters は entryYenValue(重い換算チェーン: historyYen→tokens/fx) を import するため、
// 当日 summary (LP の TodayCard が history.ts を読む) から historyFilters を引くと LP バンドルが肥大する
// (/[locale] が予算 320kB を超過)。条件は status/flow のみで pure ゆえ複製が安全。
// ⚠️ historyFilters.isIncomeSaleEntry と flow allowlist を必ず揃えること。
function isIncomeSaleEntry(entry: HistoryEntry): boolean {
  return (
    entry.status === 'success' &&
    (entry.flow === 'batch' ||
      entry.flow === 'direct' ||
      entry.flow === 'standard-merchant')
  );
}

/**
 * 純関数: 直前の summary に 1 entry を合算した新しい summary を返す (副作用なし)。
 *   - entry のローカル日付が prev.date と異なる (or prev=null) → その日付で新規作成 (rollover)。
 *   - 売上 leg でない entry (非 success / standard-fee) は件数・金額に加算しない
 *     (rollover だけは反映するため base を返す)。
 *   - merchant キーは小文字化して他端末/大文字揺れを吸収。
 */
export function addEntryToTodaySummary(
  prev: TodaySummary | null,
  entry: HistoryEntry,
): TodaySummary {
  const date = localDateKey(entry.ts);
  const base: TodaySummary =
    prev && prev.date === date
      ? { date, byMerchant: { ...prev.byMerchant } }
      : { date, byMerchant: {} };
  if (!isIncomeSaleEntry(entry)) return base;
  const key = entry.merchant.toLowerCase();
  const cur = base.byMerchant[key] ?? {
    count: 0,
    jpycAtomic: '0',
    usdcAtomic: '0',
    lastTs: 0,
  };
  const isJpyc = entry.asset === 'jpyc';
  base.byMerchant[key] = {
    count: cur.count + 1,
    jpycAtomic: isJpyc
      ? addAtomic(cur.jpycAtomic, entry.merchantAmount)
      : cur.jpycAtomic,
    usdcAtomic: isJpyc
      ? cur.usdcAtomic
      : addAtomic(cur.usdcAtomic, entry.merchantAmount),
    lastTs: Math.max(cur.lastTs, entry.ts),
  };
  return base;
}

/**
 * 純関数: nowMs のローカル日付と同日の収入売上だけから summary を再構築する。
 * 履歴配列の順序には依存せず、対象が 0 件ならキャッシュ削除を表す null を返す。
 */
export function buildTodaySummary(
  entries: ReadonlyArray<HistoryEntry>,
  nowMs: number,
): TodaySummary | null {
  const targetDate = localDateKey(nowMs);
  let summary: TodaySummary | null = null;
  for (const entry of entries) {
    if (localDateKey(entry.ts) !== targetDate || !isIncomeSaleEntry(entry)) continue;
    summary = addEntryToTodaySummary(summary, entry);
  }
  return summary;
}
