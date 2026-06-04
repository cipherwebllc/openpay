// 会計明細CSV: 1 商品 (lineItem) 1 行のエクスポート (クライアント完結・記帳補助)。
//
// 会計仕訳CSV (accountingCsv) は 1 取引 1 行で税区分を 1 つしか持てないため、混在税率の
// 行別税額は表現できない。こちらは entryLineItems で 1 商品 1 行に展開し、行別の税率/税区分/
// 税額を出す (会計ソフトへの取込補助)。会計ソフトそのものではなく、最終的な会計処理は
// 会計ソフト・税理士側で確認する前提。
//
// 対象: 収入売上 (isIncomeSaleEntry)。明細の無い entry (productName も無い legacy) は
// 取引合計のみの 1 行にフォールバックし、income tx を取りこぼさない。

import { buildCsv } from './csv';
import { pad } from './pad';
import { isIncomeSaleEntry } from './historyFilters';
import { taxCategoryShortLabel } from './tax';
import {
  entryLineItems,
  entryTotals,
  formatHistoryTimestamp,
  HISTORY_ASSET_DISPLAY,
  type HistoryEntry,
} from './history';

const HEADER: readonly string[] = [
  '日時',
  '管理番号',
  '取引Hash',
  'チェーン',
  '通貨',
  '商品名',
  '数量',
  '単価',
  '明細金額',
  '税率(%)',
  '税区分',
  '税額',
  '取引合計',
  'メモ',
];

function rowsForEntry(e: HistoryEntry): string[][] {
  const totals = entryTotals(e);
  const items = entryLineItems(e);
  const ts = formatHistoryTimestamp(e.ts);
  const txHash = e.txHash ?? '';
  const receiptNo = e.receiptNo ?? '';
  // 明細が無い (商品情報なし legacy) → 取引合計のみの 1 行で取りこぼさない。
  if (items.length === 0) {
    return [
      [
        ts,
        receiptNo,
        txHash,
        e.chainSlug,
        HISTORY_ASSET_DISPLAY[e.asset],
        '',
        '',
        '',
        totals.total,
        '',
        '',
        '',
        totals.total,
        e.memo ?? '',
      ],
    ];
  }
  return items.map((li) => [
    ts,
    receiptNo,
    txHash,
    e.chainSlug,
    HISTORY_ASSET_DISPLAY[li.currency ?? e.asset],
    li.name,
    String(li.quantity),
    li.unitPrice,
    li.amount,
    li.taxRate != null ? String(li.taxRate) : '',
    taxCategoryShortLabel(li.taxCategory ?? null),
    li.taxAmount ?? '',
    totals.total,
    li.memo ?? '',
  ]);
}

export type LineItemsCsvResult =
  | { ok: true; csv: string; rowCount: number }
  | { ok: false; reason: 'no-rows' };

export function toLineItemsCsv(
  entries: ReadonlyArray<HistoryEntry>,
): LineItemsCsvResult {
  const income = entries.filter(isIncomeSaleEntry);
  if (income.length === 0) return { ok: false, reason: 'no-rows' };
  const dataRows = income.flatMap(rowsForEntry);
  return {
    ok: true,
    csv: buildCsv([HEADER, ...dataRows]),
    rowCount: dataRows.length,
  };
}

export function lineItemsCsvFilename(now: Date = new Date()): string {
  return `openpay-line-items-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
