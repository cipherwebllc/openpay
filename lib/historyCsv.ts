// HistoryEntry[] を CSV にエクスポートする。
//
// 仕様:
// - RFC-4180 準拠: `,` / `"` / `\n` / `\r` を含む値は `"..."` で囲み、内部の
//   `"` は `""` にエスケープ。改行コードは CRLF (LF だけだと Excel が 1 行扱い)。
// - UTF-8 BOM (`﻿`) を先頭に付ける → Excel が UTF-8 として自動認識
//   (BOM 無いと CP932 解釈で日本語が文字化けする)。
// - CSV Injection 防御: 値が `=` `+` `-` `@` で始まる場合は先頭に single quote
//   を入れて defang (OWASP 推奨)。store name の自由入力 + メモ欄が攻撃面。
// - 列順は固定 (ja header)。会計ソフトへ貼り付けてもズレないよう先頭から固定。

import { formatUnits } from 'viem';
import { pad } from './pad';
import type { HistoryEntry } from './history';
import {
  formatHistoryTimestamp,
  hasSeparatedBreakdown,
  HISTORY_ASSET_DECIMALS,
  HISTORY_ASSET_DISPLAY,
  networkFeeEquivalentOf,
} from './history';

export const CSV_BOM = '﻿';
export const CSV_NEWLINE = '\r\n';

const HEADER: readonly string[] = [
  '日時',
  'ステータス',
  '種別',
  '店舗名',
  '通貨',
  '金額(decimal)',
  '金額(raw)',
  'OpenPay利用手数料(decimal)',
  'OpenPay利用手数料(raw)',
  'ネットワーク',
  'Chain ID',
  '決済モード',
  'ガス負担',
  '店舗アドレス',
  '顧客アドレス',
  '手数料受取アドレス',
  'TxHash',
  'UserOpHash',
  'ブロック',
  'メモ',
  'エラー',
  // v2 追加 (Circle Paymaster 監査)。既存列順を崩さないよう末尾に追加する。
  'Paymaster種別',
  'Circleガス代USDC(decimal)',
  'Circleガス代検証',
  // v3 追加 (fee/gas 分離・会計精度)。末尾に追加し既存列順を保つ。「金額」列は着金額
  // (settlement)、「売上総額」が gross。空セルが 0 と誤読されないよう内訳バージョン列で
  // 旧データ (内訳不明) を明示する。raw は token 単位 (JPYC=18dp / USDC=6dp)。
  '売上総額(decimal)',
  '売上総額(raw)',
  'ネットワーク手数料相当額(decimal)',
  'ネットワーク手数料相当額(raw)',
  '内訳バージョン',
  // v4 追加 (異通貨建て決済の anchor)。末尾に追加し既存列順を保つ。FX 換算で生成した
  // QR の決済のみ値が入り、通常決済は空。「¥1000 建ての品を N USDC で決済」を freee 等で照合。
  '請求建て金額',
  '請求建て通貨',
  'FXレート(USDC/JPY)',
];

const INJECTION_PREFIX = /^[=+\-@]/;

function escapeCsvCell(value: string): string {
  // Excel formula injection 防御: `=cmd|...` 等の formula evaluator 起動を抑止
  // (single quote prefix で「文字列」として扱われる)。
  const defanged = INJECTION_PREFIX.test(value) ? `'${value}` : value;
  const needsQuoting = /[",\r\n]/.test(defanged);
  if (!needsQuoting) return defanged;
  return `"${defanged.replace(/"/g, '""')}"`;
}

function rawToDecimal(raw: string | null, asset: HistoryEntry['asset']): string {
  if (raw === null) return '';
  // 無効な文字列が来た場合は formatUnits が throw するため、digit 以外を含むと
  // raw を空にする (loadHistory 側で schema 検証済なので通常通過しない経路)。
  if (!/^\d+$/.test(raw)) return '';
  return formatUnits(BigInt(raw), HISTORY_ASSET_DECIMALS[asset]);
}

function flowToKind(flow: HistoryEntry['flow']): string {
  switch (flow) {
    case 'batch':
      return 'バッチ送金 (ガスレス)';
    case 'direct':
      return '単一送金 (旧 direct)';
    case 'standard-merchant':
      return '店舗送金 (通常決済)';
    case 'standard-fee':
      return '手数料 (通常決済)';
  }
}

function statusToLabel(status: HistoryEntry['status']): string {
  switch (status) {
    case 'success':
      return '成功';
    case 'reverted':
      return 'revert';
    case 'error':
      return 'エラー';
    case 'pending':
      return '確認待ち';
  }
}

function gasModeLabel(gasMode: HistoryEntry['gasMode']): string {
  if (gasMode === null) return '対象外 (通常決済)';
  return gasMode === 'customer' ? '顧客負担' : '店主負担';
}

function payModeLabel(payMode: HistoryEntry['payMode']): string {
  return payMode === 'gasless' ? 'ガスレス決済' : '通常決済 (ガスあり)';
}

function providerLabel(provider: HistoryEntry['provider']): string {
  if (provider === 'circle') return 'Circle';
  if (provider === 'pimlico') return 'Pimlico';
  return ''; // standard / legacy は空
}

function circleVerificationLabel(
  v: HistoryEntry['circleVerification'],
): string {
  switch (v) {
    case 'verified':
      return '検証済 (on-chain)';
    case 'client-reported':
      return 'client 申告 (未検証)';
    case 'unreconciled':
      return '未照合';
    default:
      return '';
  }
}

// 空セル (売上総額 / 網手数料相当額) が 0 と誤読されないよう、内訳が分離記録済か
// (native v3) / 旧データで不明かを明示する。
function breakdownVersionLabel(e: HistoryEntry): string {
  return hasSeparatedBreakdown(e) ? '分離済' : '内訳不明 (旧データ)';
}

function entryToRow(e: HistoryEntry): string[] {
  return [
    formatHistoryTimestamp(e.ts),
    statusToLabel(e.status),
    flowToKind(e.flow),
    e.storeName,
    HISTORY_ASSET_DISPLAY[e.asset],
    rawToDecimal(e.merchantAmount, e.asset),
    e.merchantAmount,
    rawToDecimal(e.feeAmount, e.asset),
    e.feeAmount ?? '',
    e.chainSlug,
    String(e.chainId),
    payModeLabel(e.payMode),
    gasModeLabel(e.gasMode),
    e.merchant,
    e.customer ?? '',
    e.feeReceiver ?? '',
    e.txHash ?? '',
    e.userOpHash ?? '',
    e.blockNumber ?? '',
    e.note,
    e.errorMessage ?? '',
    providerLabel(e.provider),
    // Circle ガス代 (net USDC, 6dp)。circle 経路で算出済のみ、他は空。
    e.circlePaymasterNetUsdc ? rawToDecimal(e.circlePaymasterNetUsdc, 'usdc') : '',
    circleVerificationLabel(e.circleVerification),
    // v3: 売上総額 (gross) + 全経路横断のネットワーク手数料相当額 (circle は
    // circlePaymasterNetUsdc を coalesce) + 内訳バージョン。
    rawToDecimal(e.saleAmount, e.asset),
    e.saleAmount ?? '',
    rawToDecimal(networkFeeEquivalentOf(e), e.asset),
    networkFeeEquivalentOf(e) ?? '',
    breakdownVersionLabel(e),
    // v4: 異通貨建ての anchor。anchorAmount は人間可読 (raw 変換しない)。
    e.anchorAmount ?? '',
    e.anchorSymbol ? HISTORY_ASSET_DISPLAY[e.anchorSymbol] : '',
    e.fxRateUsdcJpy ?? '',
  ];
}

export function toCsv(entries: ReadonlyArray<HistoryEntry>): string {
  const rows = [HEADER, ...entries.map(entryToRow)];
  const body = rows
    .map((row) => row.map(escapeCsvCell).join(','))
    .join(CSV_NEWLINE);
  return CSV_BOM + body + CSV_NEWLINE;
}

export function historyCsvFilename(now: Date = new Date()): string {
  return `openpay-history-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
