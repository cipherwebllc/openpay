// CSV 生成の共通コア (履歴 CSV と会計 CSV が共有)。
//
// 仕様:
// - RFC-4180: `,` / `"` / `\n` / `\r` を含む値は `"..."` で囲み内部 `"` を `""` にエスケープ。
// - UTF-8 BOM を先頭に付与 (Excel / freee / MF の UTF-8 自動認識)。改行は CRLF。
// - CSV Injection 防御: 値が `=` `+` `-` `@` で始まれば先頭に single quote (OWASP)。
//   store name / メモ / 備考 の自由入力が攻撃面なので、生成系は必ずこのエスケープを通すこと。
//   security load-bearing のため重複実装せず本モジュールに一本化する。

export const CSV_BOM = '﻿';
export const CSV_NEWLINE = '\r\n';

// freee / 弥生 とも CSV 取込は概ね 5000 行上限。会計仕訳CSV (accountingCsv) と
// 会計明細CSV (lineItemsCsv) が同じ上限を共有する。定義をここに置くのは、
// accountingCsv → lineItemsCsv の import があるため逆向き import が循環になるため。
export const ACCOUNTING_MAX_ROWS = 5000;

const INJECTION_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: string): string {
  const defanged = INJECTION_PREFIX.test(value) ? `'${value}` : value;
  const needsQuoting = /[",\r\n]/.test(defanged);
  if (!needsQuoting) return defanged;
  return `"${defanged.replace(/"/g, '""')}"`;
}

// 行配列 → CSV 文字列 (各セル escape + CRLF 区切り + 末尾 CRLF)。既定で UTF-8 BOM を付与。
// bom:false は Shift_JIS 出力 (弥生ネイティブ) 用 — Shift_JIS には BOM の概念が無く、
// UTF-8 BOM (﻿) を残すと変換先で文字化け/不正バイトになるため呼出側が外す。
export function buildCsv(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  opts: { bom?: boolean } = {},
): string {
  const body = rows
    .map((row) => row.map(escapeCsvCell).join(','))
    .join(CSV_NEWLINE);
  const csv = body + CSV_NEWLINE;
  return opts.bom === false ? csv : CSV_BOM + csv;
}
