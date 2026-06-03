// 会計ソフト取込用 CSV の書き出し (クライアント完結・OAuth/認証/バックエンド不要)。
//
// 形式 (プラグイン):
//   - 'freee' : freee「取引(収入)」インポート形式 (単式・ヘッダ付き・UTF-8 BOM)。
//   - 'yayoi' : 弥生会計「仕訳データ受入形式」(複式・25列 positional・ヘッダ無し)。
//               freee / マネーフォワード が「弥生形式」として取込可の共通インターチェンジ。
//
// 共通コア: 成功売上のみ抽出 (isIncomeSaleEntry) + 円換算 (entryYenValue)。金額は両形式とも
// 整数円。会計に失敗/revert/手数料 leg を入れない (income-success 固定・UI status フィルタとは独立)。
//
// ⚠️ 列順・税区分コード・文字コード (freee/MF は UTF-8 BOM で可・ネイティブ弥生会計は Shift_JIS)
// は実取込で検証すること。勘定科目/税区分は各社の取込ウィザードで再マッピング可。

import { buildCsv } from './csv';
import { pad } from './pad';
import { shortAddress } from './format';
import { isIncomeSaleEntry } from './historyFilters';
import { entryYenValue, type YenValue } from './historyYen';
import { HISTORY_ASSET_DISPLAY, type HistoryEntry } from './history';

export type AccountingFormat = 'freee' | 'yayoi';

// freee / 弥生 とも CSV 取込は概ね 5000 行上限。
export const ACCOUNTING_MAX_ROWS = 5000;

export type AccountingCsvOptions = {
  /** USDC・anchor 無し行の円換算に使う現レート (useMarketRates 由来・未取得は undefined)。 */
  usdcJpy: number | undefined;
  now?: Date;
};

export type AccountingCsvResult =
  | { ok: true; csv: string; rowCount: number; approxCount: number }
  | { ok: false; reason: 'no-rows' }
  | { ok: false; reason: 'too-many-rows'; rowCount: number }
  | { ok: false; reason: 'rate-unavailable'; blockingRowCount: number };

type Valued = { e: HistoryEntry; yv: Exclude<YenValue, { kind: 'unavailable' }> };

function ymd(ts: number, sep: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${sep}${pad(d.getMonth() + 1)}${sep}${pad(d.getDate())}`;
}

// 備考: OpenPay の追跡情報 (token/chain・短縮 tx・元の価格建て anchor・概算フラグ)。
function bikou(e: HistoryEntry, yv: Valued['yv']): string {
  const parts: string[] = [`${HISTORY_ASSET_DISPLAY[e.asset]}/${e.chainSlug}`];
  if (e.txHash) parts.push(`tx:${shortAddress(e.txHash)}`);
  if (e.anchorAmount != null && e.anchorSymbol) {
    parts.push(
      `元:${e.anchorAmount} ${HISTORY_ASSET_DISPLAY[e.anchorSymbol]} @${e.fxRateUsdcJpy ?? '?'}`,
    );
  }
  if (yv.kind === 'approx') parts.push(`概算@${yv.rate}`);
  return parts.join(' / ');
}

function partner(e: HistoryEntry): string {
  const store = e.storeName.trim();
  return store.length > 0 ? store : (e.customer ?? '');
}

// freee 取引(収入) 形式: ヘッダ + 1 行 1 取引。勘定科目/税区分はデフォルト値 (取込時に再マッピング可)。
const FREEE_HEADER = [
  '収支区分',
  '発生日',
  '勘定科目',
  '税区分',
  '金額',
  '取引先',
  '備考',
] as const;

function freeeRows(valued: ReadonlyArray<Valued>): string[][] {
  const rows: string[][] = [[...FREEE_HEADER]];
  for (const { e, yv } of valued) {
    rows.push([
      '収入',
      ymd(e.ts, '-'),
      '売上高',
      '課税売上10%',
      String(yv.yen),
      partner(e),
      bikou(e, yv),
    ]);
  }
  return rows;
}

// 弥生「仕訳データ受入形式」(25列・ヘッダ無し)。収入 1 件 = 借方 売掛金 / 貸方 売上高 の 1 仕訳。
// 税込経理前提 (金額は税込 gross)。税額は 0 とし取込側が税区分から算出。
function yayoiRows(valued: ReadonlyArray<Valued>): string[][] {
  const rows: string[][] = [];
  valued.forEach(({ e, yv }, i) => {
    const yen = String(yv.yen);
    rows.push([
      '2000', // 識別フラグ (仕訳)
      String(i + 1), // 伝票No
      '', // 決算
      ymd(e.ts, '/'), // 取引日付
      '売掛金', // 借方勘定科目
      '', // 借方補助科目
      '', // 借方部門
      '対象外', // 借方税区分
      yen, // 借方金額
      '0', // 借方税金額
      '売上高', // 貸方勘定科目
      '', // 貸方補助科目
      '', // 貸方部門
      '課税売上込10%', // 貸方税区分 (税込)
      yen, // 貸方金額
      '0', // 貸方税金額
      bikou(e, yv), // 摘要
      '', // 番号
      '', // 期日
      '0', // タイプ
      '', // 生成元
      '', // 仕訳メモ
      '0', // 付箋1
      '0', // 付箋2
      'no', // 調整
    ]);
  });
  return rows;
}

export function toAccountingCsv(
  entries: ReadonlyArray<HistoryEntry>,
  opts: AccountingCsvOptions & { format: AccountingFormat },
): AccountingCsvResult {
  const income = entries.filter(isIncomeSaleEntry);
  if (income.length === 0) return { ok: false, reason: 'no-rows' };
  if (income.length > ACCOUNTING_MAX_ROWS) {
    return { ok: false, reason: 'too-many-rows', rowCount: income.length };
  }
  // 円換算。anchor 無し USDC でレート未取得 (unavailable) があれば中断 (空金額を会計に入れない)。
  const valued: Valued[] = [];
  let blocking = 0;
  for (const e of income) {
    const yv = entryYenValue(e, opts.usdcJpy);
    if (yv.kind === 'unavailable') blocking += 1;
    else valued.push({ e, yv });
  }
  if (blocking > 0) {
    return { ok: false, reason: 'rate-unavailable', blockingRowCount: blocking };
  }
  const rows = opts.format === 'freee' ? freeeRows(valued) : yayoiRows(valued);
  const approxCount = valued.filter((v) => v.yv.kind === 'approx').length;
  return { ok: true, csv: buildCsv(rows), rowCount: valued.length, approxCount };
}

export function accountingCsvFilename(
  format: AccountingFormat,
  now: Date = new Date(),
): string {
  return `openpay-${format}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
