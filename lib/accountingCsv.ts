// 会計ソフト取込用 CSV の書き出し (クライアント完結・OAuth/認証/バックエンド不要)。
//
// 形式 (プラグイン):
//   - 'freee'        : freee「取引(収入)」インポート形式 (単式・ヘッダ付き・UTF-8 BOM)。
//   - 'yayoi'        : 弥生「仕訳データ受入形式」汎用 (複式・25列 positional・ヘッダ無し・UTF-8 BOM)。
//                      freee / マネーフォワード / 弥生オンライン が「弥生形式」として取込可の共通インターチェンジ。
//   - 'mf'           : マネーフォワード クラウド会計「仕訳帳」インポート形式 (複式・ヘッダ付き・UTF-8 BOM)。
//   - 'yayoi-native' : 弥生会計 (インストール版) ネイティブ。yayoi と同一 25列だが文字コードが Shift_JIS。
//
// 共通コア: 成功売上のみ抽出 (isIncomeSaleEntry) + 円換算 (entryYenValue)。金額は全形式とも
// 整数円。会計に失敗/revert/手数料 leg を入れない (income-success 固定・UI status フィルタとは独立)。
//
// 文字コード: 'yayoi-native' のみ Shift_JIS (UTF-8 BOM を付けず charset を返す → 書き出し直前に
// 呼出側がバイト変換)。それ以外は UTF-8 BOM。⚠️ 列順・税区分コード・文字コードは実取込で検証すること
// (勘定科目/税区分は各社の取込ウィザードで再マッピング可)。

import { buildCsv } from './csv';
import { pad } from './pad';
import { shortAddress } from './format';
import { isIncomeSaleEntry } from './historyFilters';
import { entryYenValue, type YenValue } from './historyYen';
import { lineItemGrossAmount } from './lineItemsCsv';
import {
  entryLineItems,
  HISTORY_ASSET_DISPLAY,
  type HistoryEntry,
} from './history';
import {
  freeeTaxLabel,
  mfCreditTaxLabel,
  yayoiCreditTaxLabel,
  type TaxCategory,
} from './tax';

export type AccountingFormat = 'freee' | 'yayoi' | 'mf' | 'yayoi-native';

/** 書き出しバイト列の文字コード。Shift_JIS は弥生インストール版ネイティブのみ。 */
export type AccountingCharset = 'utf-8' | 'shift_jis';

// freee / 弥生 とも CSV 取込は概ね 5000 行上限。
export const ACCOUNTING_MAX_ROWS = 5000;

export type AccountingCsvOptions = {
  /** USDC・anchor 無し行の円換算に使う現レート (useMarketRates 由来・未取得は undefined)。 */
  usdcJpy: number | undefined;
  now?: Date;
};

export type AccountingCsvResult =
  | {
      ok: true;
      csv: string;
      charset: AccountingCharset;
      rowCount: number;
      approxCount: number;
    }
  | { ok: false; reason: 'no-rows' }
  | { ok: false; reason: 'too-many-rows'; rowCount: number }
  | { ok: false; reason: 'rate-unavailable'; blockingRowCount: number };

type Valued = { e: HistoryEntry; yv: Exclude<YenValue, { kind: 'unavailable' }> };

function ymd(ts: number, sep: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${sep}${pad(d.getMonth() + 1)}${sep}${pad(d.getDate())}`;
}

// 備考: 売上明細サマリ「商品名 x数量 / …」(記帳補助) + OpenPay の追跡情報 (token/chain・
// 短縮 tx・元の価格建て anchor・概算フラグ) + 管理番号 + メモ。明細が無ければ従来どおり token/chain から。
// split (= 混在税率の税区分別分割) 時は同一 entry の全行に同じ備考を出した上で、末尾に
// `税区分別 n/m` を付けて取込側が同一取引と分かるようにする (1/1 = 非分割は付けない)。
function bikou(
  e: HistoryEntry,
  yv: Valued['yv'],
  split?: { index: number; total: number },
): string {
  const parts: string[] = [];
  const items = entryLineItems(e);
  if (items.length > 0) {
    const summary = items
      .slice(0, 5)
      .map((li) => `${li.name} x${li.quantity}`)
      .join(' / ');
    parts.push(items.length > 5 ? `${summary} ほか` : summary);
  }
  parts.push(`${HISTORY_ASSET_DISPLAY[e.asset]}/${e.chainSlug}`);
  if (e.txHash) parts.push(`tx:${shortAddress(e.txHash)}`);
  if (e.anchorAmount != null && e.anchorSymbol) {
    parts.push(
      `元:${e.anchorAmount} ${HISTORY_ASSET_DISPLAY[e.anchorSymbol]} @${e.fxRateUsdcJpy ?? '?'}`,
    );
  }
  if (yv.kind === 'approx') parts.push(`概算@${yv.rate}`);
  if (e.receiptNo) parts.push(`No:${e.receiptNo}`);
  if (e.memo) parts.push(e.memo);
  if (split && split.total > 1) parts.push(`税区分別 ${split.index}/${split.total}`);
  return parts.join(' / ');
}

// 単一グループ時の代表税区分: 明細の税区分が全行同一なら其れ、明細なし/不明なら entry の
// taxCategory (= 既存デフォルト)。混在カートは taxGroupsForEntry が税区分グループ別に
// 行を分割するため、ここに到達するのは「単一グループ」(全行同一 or 明細なし or 金額情報を
// 欠く fallback) のケースのみ。行別の per-line 税区分は明細CSV (lineItemsCsv) でも出す。
function representativeTaxCategory(e: HistoryEntry): TaxCategory | null {
  const cats = entryLineItems(e)
    .map((li) => li.taxCategory)
    .filter((c): c is TaxCategory => c != null);
  if (cats.length === 0) return e.taxCategory ?? null;
  return cats.every((c) => c === cats[0]) ? cats[0] : (e.taxCategory ?? null);
}

/**
 * 1 entry を「税区分グループ」へ分解する。仕訳CSV (freee/弥生/MF) は混在税率カートを税区分
 * ごとに行分割し、8% 分が 10% として申告される取込事故を防ぐ。
 *
 * グループ合計 (yen の総和) === yv.yen を**厳密保証** (largest-remainder 法で円整数配分)。
 *
 * 単一グループ (= 従来どおり 1 行・挙動完全互換) に倒す条件:
 *   - 明細なし (legacy / 商品情報なし)
 *   - 全行の実効税区分が同一 (= representativeTaxCategory が一意に定まる)
 *   - 明細の金額情報 (li.amount) が数値化できない行が 1 つでもある (按分比率を作れない)
 *
 * 混在時: 行の実効税区分 (li.taxCategory ?? entry default) ごとに per-line 税込額
 * (lineItemGrossAmount = 明細CSV の「明細金額」li.amount と同一) を合計し、その比率で
 * yv.yen を按分する。比率按分なので per-line 額の通貨単位は約分されて消える
 * (USDC+anchor 決済では明細は販売建て通貨だが、同一通貨同士の比のみに使うため問題ない)。
 */
function taxGroupsForEntry(
  e: HistoryEntry,
  yv: Valued['yv'],
): Array<{ taxCategory: TaxCategory | null; yen: number }> {
  const single = (): Array<{ taxCategory: TaxCategory | null; yen: number }> => [
    { taxCategory: representativeTaxCategory(e), yen: yv.yen },
  ];

  const items = entryLineItems(e);
  if (items.length === 0) return single();

  const entryDefault: TaxCategory | null = e.taxCategory ?? null;
  // 実効税区分 (null 明細は entry default へ) と per-line 税込額を集める。
  const lines: Array<{ cat: TaxCategory | null; gross: number }> = [];
  for (const li of items) {
    const gross = lineItemGrossAmount(li);
    if (gross === null) return single(); // 金額情報を欠く行 → 按分不能 → 単一行 fallback
    lines.push({ cat: li.taxCategory ?? entryDefault, gross });
  }

  // 出現順を保ちつつ税区分ごとに集約。
  const order: Array<TaxCategory | null> = [];
  const sums = new Map<TaxCategory | null, number>();
  for (const { cat, gross } of lines) {
    if (!sums.has(cat)) order.push(cat);
    sums.set(cat, (sums.get(cat) ?? 0) + gross);
  }
  if (order.length <= 1) return single(); // 全行同一実効税区分 → 従来どおり 1 行

  const totalGross = order.reduce((acc, cat) => acc + (sums.get(cat) ?? 0), 0);
  // 比率の分母が 0 (全行 amount=0) なら按分不能 → 単一行 fallback。
  if (!(totalGross > 0)) return single();

  return apportionYen(
    order.map((cat) => ({ key: cat, weight: sums.get(cat) ?? 0 })),
    yv.yen,
  ).map(({ key, yen }) => ({ taxCategory: key, yen }));
}

/**
 * weight 比で total (円整数) を配分する largest-remainder (最大剰余) 法。
 * 各要素に floor(total * weight / Σweight) を割り、余り (total − Σfloor) を小数部
 * (剰余) の大きい順に +1 ずつ配る。**配分後の合計 === total を厳密保証**。
 * total が負・Σweight が 0 のケースは呼出側で除外済 (ここでは total>=0・Σweight>0 前提)。
 */
function apportionYen<K>(
  parts: ReadonlyArray<{ key: K; weight: number }>,
  total: number,
): Array<{ key: K; yen: number }> {
  const sumW = parts.reduce((acc, p) => acc + p.weight, 0);
  const exact = parts.map((p) => (total * p.weight) / sumW);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((acc, f) => acc + f, 0);
  // 小数部の大きい順 index。tie は先勝ち (order 安定) で取込側の再現性を担保。
  const byFrac = parts
    .map((_, i) => i)
    .sort((a, b) => exact[b] - floors[b] - (exact[a] - floors[a]));
  const yens = floors.slice();
  for (const i of byFrac) {
    if (remainder <= 0) break;
    yens[i] += 1;
    remainder -= 1;
  }
  return parts.map((p, i) => ({ key: p.key, yen: yens[i] }));
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
    const groups = taxGroupsForEntry(e, yv); // 混在税率は税区分別に分割 (合計 === yv.yen)
    groups.forEach((g, gi) => {
      rows.push([
        '収入',
        ymd(e.ts, '-'),
        '売上高',
        freeeTaxLabel(g.taxCategory), // 税区分: グループ別 (単一グループは代表値)
        String(g.yen),
        partner(e),
        bikou(e, yv, { index: gi + 1, total: groups.length }),
      ]);
    });
  }
  return rows;
}

// 弥生「仕訳データ受入形式」(25列・ヘッダ無し)。収入 1 件 = 借方 売掛金 / 貸方 売上高 の 1 仕訳。
// 税込経理前提 (金額は税込 gross)。税額は 0 とし取込側が税区分から算出。
// 混在税率は税区分別に分割し、分割行も独立仕訳として伝票No を連番採番する。
function yayoiRows(valued: ReadonlyArray<Valued>): string[][] {
  const rows: string[][] = [];
  let voucherNo = 0; // 伝票No (分割行も独立仕訳として連番継続)
  for (const { e, yv } of valued) {
    const groups = taxGroupsForEntry(e, yv);
    groups.forEach((g, gi) => {
      voucherNo += 1;
      const yen = String(g.yen);
      rows.push([
        '2000', // 識別フラグ (仕訳)
        String(voucherNo), // 伝票No
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
        yayoiCreditTaxLabel(g.taxCategory), // 貸方税区分 (税込・グループ別)
        yen, // 貸方金額
        '0', // 貸方税金額
        bikou(e, yv, { index: gi + 1, total: groups.length }), // 摘要
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
  }
  return rows;
}

// マネーフォワード クラウド会計「仕訳帳」インポート形式 (ヘッダ付き・複式)。
// 収入 1 件 = 借方 売掛金 / 貸方 売上高。税区分は取込時に再マッピング可。
const MF_HEADER = [
  '取引No',
  '取引日',
  '借方勘定科目',
  '借方補助科目',
  '借方部門',
  '借方税区分',
  '借方金額(円)',
  '借方税額',
  '貸方勘定科目',
  '貸方補助科目',
  '貸方部門',
  '貸方税区分',
  '貸方金額(円)',
  '貸方税額',
  '摘要',
] as const;

// 混在税率は税区分別に分割し、分割行も独立仕訳として取引No を連番採番する。
function mfRows(valued: ReadonlyArray<Valued>): string[][] {
  const rows: string[][] = [[...MF_HEADER]];
  let txNo = 0; // 取引No (分割行も独立仕訳として連番継続)
  for (const { e, yv } of valued) {
    const groups = taxGroupsForEntry(e, yv);
    groups.forEach((g, gi) => {
      txNo += 1;
      const yen = String(g.yen);
      rows.push([
        String(txNo), // 取引No
        ymd(e.ts, '/'), // 取引日
        '売掛金', // 借方勘定科目
        '', // 借方補助科目
        '', // 借方部門
        '対象外', // 借方税区分
        yen, // 借方金額(円)
        '0', // 借方税額
        '売上高', // 貸方勘定科目
        '', // 貸方補助科目
        '', // 貸方部門
        mfCreditTaxLabel(g.taxCategory), // 貸方税区分 (グループ別)
        yen, // 貸方金額(円)
        '0', // 貸方税額
        bikou(e, yv, { index: gi + 1, total: groups.length }), // 摘要
      ]);
    });
  }
  return rows;
}

// 形式ごとの行生成 + 文字コード。yayoi-native は yayoi と同一列で Shift_JIS のみ違う。
const FORMAT_SPEC: Record<
  AccountingFormat,
  { rows: (valued: ReadonlyArray<Valued>) => string[][]; charset: AccountingCharset }
> = {
  freee: { rows: freeeRows, charset: 'utf-8' },
  yayoi: { rows: yayoiRows, charset: 'utf-8' },
  mf: { rows: mfRows, charset: 'utf-8' },
  'yayoi-native': { rows: yayoiRows, charset: 'shift_jis' },
};

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
  const spec = FORMAT_SPEC[opts.format];
  const rows = spec.rows(valued);
  const approxCount = valued.filter((v) => v.yv.kind === 'approx').length;
  return {
    ok: true,
    csv: buildCsv(rows, { bom: spec.charset === 'utf-8' }),
    charset: spec.charset,
    rowCount: valued.length,
    approxCount,
  };
}

export function accountingCsvFilename(
  format: AccountingFormat,
  now: Date = new Date(),
): string {
  return `openpay-${format}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
