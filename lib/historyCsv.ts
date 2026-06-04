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
import { buildCsv } from './csv';
// 後方互換: 既存 import (CSV_BOM/CSV_NEWLINE を @/lib/historyCsv から取得) を維持。
export { CSV_BOM, CSV_NEWLINE } from './csv';
import type { HistoryEntry } from './history';
import {
  formatHistoryTimestamp,
  hasSeparatedBreakdown,
  HISTORY_ASSET_DECIMALS,
  HISTORY_ASSET_DISPLAY,
  networkFeeEquivalentOf,
} from './history';
import { entryYenValue } from './historyYen';
import { taxAmountYen, taxCategoryShortLabel } from './tax';

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
  // v5 追加 (記帳補助メタ: 商品/税/明細)。末尾に追加し既存列順を保つ (旧データは空セル)。
  // 税額(円) は円換算可能な行のみ算出 (JPYC=exact / USDC は anchor or rate がある時)、
  // それ以外は空。会計ソフトではなく「記帳補助 / CSV 取込用」の参考値。
  '商品名',
  '会計メモ',
  '税率(%)',
  '税区分',
  '税額(円)',
  '管理番号',
  '数量',
  '単価',
  '明細',
];

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

// v5 税額(円): 内税を円換算値 (entryYenValue) と taxRate から算出。円換算不能 (USDC レート無) /
// 税率未指定は空 (USDC を無理に税JPY変換しない方針)。
function taxAmountCell(e: HistoryEntry, usdcJpy: number | undefined): string {
  if (e.taxRate == null) return '';
  const yv = entryYenValue(e, usdcJpy);
  if (yv.kind === 'unavailable') return '';
  const amt = taxAmountYen(yv.yen, e.taxRate);
  return amt == null ? '' : String(amt);
}

// 単一明細の数量/単価のみセル化 (複数明細は「明細」列に要約)。
function singleQtyCell(e: HistoryEntry): string {
  return e.lineItems && e.lineItems.length === 1
    ? String(e.lineItems[0].quantity)
    : '';
}
function singleUnitCell(e: HistoryEntry): string {
  return e.lineItems && e.lineItems.length === 1 ? e.lineItems[0].unitPrice : '';
}

// 明細要約 ("商品名×数量@単価; ...")。明細なしは空。
function lineItemsCell(e: HistoryEntry): string {
  if (!e.lineItems || e.lineItems.length === 0) return '';
  return e.lineItems
    .map((li) => `${li.name}×${li.quantity}@${li.unitPrice}`)
    .join('; ');
}

function entryToRow(e: HistoryEntry, usdcJpy: number | undefined): string[] {
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
    // v5: 記帳補助メタ。
    e.productName ?? '',
    e.memo ?? '',
    e.taxRate != null ? String(e.taxRate) : '',
    taxCategoryShortLabel(e.taxCategory),
    taxAmountCell(e, usdcJpy),
    e.receiptNo ?? '',
    singleQtyCell(e),
    singleUnitCell(e),
    lineItemsCell(e),
  ];
}

// usdcJpy は v5 税額(円) の USDC 円換算に使う (anchor の無い USDC 行のみ必要)。未指定なら
// USDC 行の税額は空になる (JPYC / anchor 付き USDC は rate 非依存で算出される)。
export function toCsv(
  entries: ReadonlyArray<HistoryEntry>,
  opts: { usdcJpy?: number } = {},
): string {
  return buildCsv([HEADER, ...entries.map((e) => entryToRow(e, opts.usdcJpy))]);
}

export function historyCsvFilename(now: Date = new Date()): string {
  return `openpay-history-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
