// 顧客向け「電子レシート / 支払い控え」を支払い側ブラウザの LocalStorage に保存する。
//
// 店舗側の売上履歴 (lib/history.ts / openpay:history:v1) とは **別ストア**。direction:'paid' /
// kind:'payment_receipt' で区別し、顧客が支払いを完了した控えとして /scan に表示する。
// 正式な領収書・税務証憑ではなく支払い確認の補助 (UI 文言は「電子レシート / 支払い控え」)。
//
// サーバ送信なし・秘密情報なし (txHash・アドレス・金額・商品名のみ)。端末のブラウザ scope のみ。
// 設計は lib/history.ts の load/migrate/append/CustomEvent パターンを踏襲 (壊れたデータは drop)。

import { formatUnits } from 'viem';
import { safeGet, safeSet } from './storage';
import { logger } from './logger';
import { buildCsv } from './csv';
import { randomId } from './id';
import { chainNameForId, txExplorerUrl } from './chains';
import {
  entryLineItems,
  entryTotals,
  HISTORY_ASSET_DECIMALS,
  HISTORY_ASSET_DISPLAY,
  type HistoryEntry,
  type HistoryLineItem,
} from './history';
import { displaySymbolFor, type TokenSymbol } from './tokens';

export const PAYER_RECEIPTS_STORAGE_KEY = 'openpay:payerReceipts:v1';
export const PAYER_RECEIPTS_CHANGED_EVENT = 'openpay:payer-receipts-changed';
export const PAYER_RECEIPTS_MAX = 200;
export const PAYER_RECEIPT_SCHEMA_VERSION = 1 as const;

export type PayerReceiptStatus = 'confirmed' | 'pending' | 'failed' | 'unknown';

export type PayerReceipt = {
  /** 内部 migration 用 (store した entry は常に LATEST)。 */
  schemaVersion: number;
  /** dedupe 鍵。txHash > userOpHash > ランダム。 */
  receiptId: string;
  receiptNo?: string;
  /** ISO 文字列。 */
  createdAt: string;
  paidAt?: string;
  direction: 'paid';
  kind: 'payment_receipt';
  status: PayerReceiptStatus;
  txHash?: string;
  chainId?: number;
  chainName?: string;
  tokenSymbol: string;
  tokenAddress?: string;
  /** 支払総額 (人間可読 decimal・token 単位)。 */
  amount: string;
  currency: string;
  merchantName?: string;
  merchantAddress: string;
  payerAddress?: string;
  paymentMode?: string;
  gasMode?: string;
  /** 共通の売上明細型を再利用 (店舗側 lineItems と同型)。 */
  lineItems?: HistoryLineItem[];
  subtotalAmount?: string;
  totalTaxAmount?: string;
  totalAmount?: string;
  memo?: string;
  explorerUrl?: string;
  /** 異通貨建て (FX 換算 QR) の元価格。顧客が QR で見た請求建ての金額 / 表示シンボル /
   *  適用レート。settled 金額 (amount) は実支払額のまま、こちらは参考表示。通常決済は省略。 */
  anchorAmount?: string;
  anchorSymbol?: string;
  fxRate?: string;
  sourceRoute?: string;
  locale?: string;
};

export type BuildPayerReceiptInput = {
  txHash?: string | null;
  userOpHash?: string | null;
  chainId?: number;
  asset: TokenSymbol;
  tokenAddress?: string | null;
  /** 支払総額 (人間可読 decimal)。 */
  amount: string;
  merchantAddress: string;
  merchantName?: string | null;
  payerAddress?: string | null;
  paymentMode?: string | null;
  gasMode?: string | null;
  lineItems?: HistoryLineItem[] | null;
  subtotalAmount?: string;
  totalTaxAmount?: string;
  totalAmount?: string;
  memo?: string | null;
  receiptNo?: string | null;
  status?: PayerReceiptStatus;
  /** 異通貨建ての元価格 (請求建て金額 / 表示シンボル / レート)。通常決済は省略。 */
  anchorAmount?: string | null;
  anchorSymbol?: string | null;
  fxRate?: string | null;
  sourceRoute?: string;
  locale?: string;
};

const VIRTUAL_FALLBACK_NAME = 'OpenPay payment';

/** lineItems が無い単純送金/旧 QR でも 1 行は出るよう仮想明細を組む。 */
function virtualLineItem(input: BuildPayerReceiptInput): HistoryLineItem {
  return {
    name: input.merchantName?.trim() || VIRTUAL_FALLBACK_NAME,
    quantity: 1,
    unitPrice: input.amount,
    amount: input.amount,
    taxRate: null,
    taxCategory: 'out_of_scope',
    taxAmount: '0',
    memo: null,
  };
}

/** 平坦な input から PayerReceipt を生成 (純関数・now は注入可)。 */
export function buildPayerReceipt(
  input: BuildPayerReceiptInput,
  now: Date = new Date(),
): PayerReceipt {
  const txHash = input.txHash ?? undefined;
  const chainId = input.chainId;
  const lineItems =
    input.lineItems && input.lineItems.length > 0
      ? input.lineItems
      : [virtualLineItem(input)];
  const tokenSymbol = HISTORY_ASSET_DISPLAY[input.asset];
  const iso = now.toISOString();
  return {
    schemaVersion: PAYER_RECEIPT_SCHEMA_VERSION,
    receiptId: txHash || input.userOpHash || randomId(),
    receiptNo: input.receiptNo ?? undefined,
    createdAt: iso,
    paidAt: txHash ? iso : undefined,
    direction: 'paid',
    kind: 'payment_receipt',
    status: input.status ?? 'confirmed',
    txHash,
    chainId,
    chainName: chainId != null ? chainNameForId(chainId) : undefined,
    tokenSymbol,
    tokenAddress: input.tokenAddress ?? undefined,
    amount: input.amount,
    currency: tokenSymbol,
    merchantName: input.merchantName?.trim() || undefined,
    merchantAddress: input.merchantAddress,
    payerAddress: input.payerAddress ?? undefined,
    paymentMode: input.paymentMode ?? undefined,
    gasMode: input.gasMode ?? undefined,
    lineItems,
    subtotalAmount: input.subtotalAmount ?? input.totalAmount ?? input.amount,
    totalTaxAmount: input.totalTaxAmount ?? '0',
    totalAmount: input.totalAmount ?? input.amount,
    memo: input.memo?.trim() || undefined,
    explorerUrl:
      chainId != null && txHash ? txExplorerUrl(chainId, txHash) : undefined,
    anchorAmount: input.anchorAmount ?? undefined,
    anchorSymbol: input.anchorSymbol ?? undefined,
    fxRate: input.fxRate ?? undefined,
    sourceRoute: input.sourceRoute,
    locale: input.locale,
  };
}

/** 店舗側 HistoryEntry (sale 成功 leg) → 顧客向け PayerReceipt 写像。 */
export function payerReceiptFromHistoryEntry(
  entry: HistoryEntry,
  opts: { sourceRoute?: string; locale?: string; now?: Date } = {},
): PayerReceipt {
  const totals = entryTotals(entry);
  // 顧客控えの総額は「商品の請求額 (gross sale)」を使う。店主が gas を吸収する gasMode では
  // merchantAmount は gas 控除後の手取りとなり、顧客が支払った商品代金 (= 明細合計 = saleAmount)
  // と一致しない。saleAmount を優先し、無い leg は merchantAmount にフォールバック (= totals.total)。
  const grossRaw = entry.saleAmount ?? entry.merchantAmount;
  const grossTotal = /^\d+$/.test(grossRaw)
    ? formatUnits(BigInt(grossRaw), HISTORY_ASSET_DECIMALS[entry.asset])
    : totals.total;
  const status: PayerReceiptStatus =
    entry.status === 'success'
      ? 'confirmed'
      : entry.status === 'pending'
        ? 'pending'
        : 'unknown';
  return buildPayerReceipt(
    {
      txHash: entry.txHash,
      userOpHash: entry.userOpHash,
      chainId: entry.chainId,
      asset: entry.asset,
      tokenAddress: entry.tokenAddress,
      amount: grossTotal,
      merchantAddress: entry.merchant,
      merchantName: entry.storeName,
      payerAddress: entry.customer,
      paymentMode: entry.payMode,
      gasMode: entry.gasMode,
      lineItems: entryLineItems(entry),
      subtotalAmount: grossTotal,
      totalTaxAmount: totals.totalTax,
      totalAmount: grossTotal,
      memo: entry.memo,
      receiptNo: entry.receiptNo,
      status,
      // 異通貨建ては元価格 (anchor) を顧客控えにも反映 (HistoryRow と同じ表示資産)。
      anchorAmount: entry.anchorAmount,
      anchorSymbol: entry.anchorSymbol ? displaySymbolFor(entry.anchorSymbol) : null,
      fxRate: entry.fxRateUsdcJpy,
      sourceRoute: opts.sourceRoute,
      locale: opts.locale,
    },
    opts.now,
  );
}

// --- ストア (LocalStorage) ----------------------------------------------------

function isValidLineItems(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  // 描画 / CSV で無ガードに参照する必須フィールドを型まで検証し、破損データ
  // (quantity/unitPrice/amount 欠落) が undefined のまま表示・出力されるのを防ぐ。
  return value.every((li) => {
    if (li === null || typeof li !== 'object') return false;
    const o = li as Record<string, unknown>;
    return (
      typeof o.name === 'string' &&
      typeof o.quantity === 'number' &&
      typeof o.unitPrice === 'string' &&
      typeof o.amount === 'string'
    );
  });
}

function isValidReceipt(value: unknown): value is PayerReceipt {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== PAYER_RECEIPT_SCHEMA_VERSION) return false;
  if (typeof r.receiptId !== 'string' || r.receiptId.length === 0) return false;
  if (r.direction !== 'paid' || r.kind !== 'payment_receipt') return false;
  if (typeof r.createdAt !== 'string') return false;
  if (typeof r.tokenSymbol !== 'string') return false;
  if (typeof r.amount !== 'string') return false;
  if (typeof r.merchantAddress !== 'string') return false;
  if (r.lineItems !== undefined && !isValidLineItems(r.lineItems)) return false;
  return true;
}

// 現状 v1 単独。schemaVersion 欠落は v1 とみなして救済し、LATEST 以外 (未来/未知) は
// 移行手段が無いので drop する。v2 を出す際はここに v1→v2 の変換ステップを追加する。
function migrateToLatest(value: unknown): PayerReceipt | null {
  if (value === null || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const version =
    typeof r.schemaVersion === 'number' ? r.schemaVersion : PAYER_RECEIPT_SCHEMA_VERSION;
  if (version !== PAYER_RECEIPT_SCHEMA_VERSION) return null;
  const normalized = { ...r, schemaVersion: PAYER_RECEIPT_SCHEMA_VERSION };
  return isValidReceipt(normalized) ? normalized : null;
}

export function loadPayerReceipts(): PayerReceipt[] {
  const raw = safeGet<unknown>(PAYER_RECEIPTS_STORAGE_KEY, []);
  if (!Array.isArray(raw)) {
    logger.warn('payerReceipts.load.not-array', { actual: typeof raw });
    return [];
  }
  const valid: PayerReceipt[] = [];
  let invalid = 0;
  for (const item of raw) {
    const migrated = migrateToLatest(item);
    if (migrated === null) invalid += 1;
    else valid.push(migrated);
  }
  if (invalid > 0) {
    logger.warn('payerReceipts.load.invalid-dropped', { invalid, kept: valid.length });
  }
  return valid;
}

function broadcastChange(): void {
  window.dispatchEvent(new Event(PAYER_RECEIPTS_CHANGED_EVENT));
}

export function appendPayerReceipt(receipt: PayerReceipt): void {
  if (typeof window === 'undefined') return;
  const current = loadPayerReceipts();
  // 同一 receiptId (= 同一 tx) は no-op で dedupe (StrictMode 二重発火・再描画吸収)。
  if (current.some((r) => r.receiptId === receipt.receiptId)) return;
  const next = [receipt, ...current];
  const trimmed =
    next.length > PAYER_RECEIPTS_MAX ? next.slice(0, PAYER_RECEIPTS_MAX) : next;
  safeSet(PAYER_RECEIPTS_STORAGE_KEY, trimmed);
  broadcastChange();
}

export function removePayerReceipt(receiptId: string): void {
  if (typeof window === 'undefined') return;
  const current = loadPayerReceipts();
  const next = current.filter((r) => r.receiptId !== receiptId);
  if (next.length === current.length) return;
  safeSet(PAYER_RECEIPTS_STORAGE_KEY, next);
  broadcastChange();
}

export function clearPayerReceipts(): void {
  if (typeof window === 'undefined') return;
  safeSet(PAYER_RECEIPTS_STORAGE_KEY, []);
  broadcastChange();
}

// --- 出力 (コピー / JSON / CSV) ------------------------------------------------

/** ISO 文字列をロケール表示に整形 (copy / CSV / 詳細 / 一覧で共有)。空・不正値は '—'。 */
export function formatReceiptDateTime(
  iso: string | undefined,
  locale?: string,
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale === 'en' ? 'en-US' : 'ja-JP');
}

/** タックスが計上されている (内税 > 0) か。小計/税額行の表示要否に使う。 */
export function payerReceiptHasTax(r: PayerReceipt): boolean {
  return !!r.totalTaxAmount && r.totalTaxAmount !== '0';
}

/** レシート控えのプレーンテキスト (コピー用)。 */
export function payerReceiptCopyText(r: PayerReceipt, locale?: string): string {
  const en = locale === 'en';
  const lines: string[] = [];
  lines.push(en ? 'OpenPay payment receipt' : 'OpenPay 電子レシート');
  lines.push('');
  if (r.receiptNo) lines.push(`${en ? 'Receipt no.' : 'レシート番号'}：${r.receiptNo}`);
  lines.push(`${en ? 'Date' : '日時'}：${formatReceiptDateTime(r.paidAt ?? r.createdAt, locale)}`);
  if (r.merchantName) lines.push(`${en ? 'Merchant' : '店舗'}：${r.merchantName}`);
  lines.push('');
  for (const li of r.lineItems ?? []) {
    lines.push(`${li.name} x ${li.quantity}    ${li.amount} ${r.currency}`);
  }
  lines.push('');
  // 税額が計上されているときだけ小計/消費税を併記 (0 のときは合計のみで十分)。
  if (payerReceiptHasTax(r)) {
    if (r.subtotalAmount) lines.push(`${en ? 'Subtotal' : '小計'}：${r.subtotalAmount} ${r.currency}`);
    lines.push(`${en ? 'Tax' : '消費税'}：${r.totalTaxAmount} ${r.currency}`);
  }
  lines.push(`${en ? 'Total' : '合計'}：${r.totalAmount ?? r.amount} ${r.currency}`);
  // 異通貨建て: 元価格 (請求建て) を併記し、顧客が QR で見た価格を控えに残す。
  if (r.anchorAmount && r.anchorSymbol) {
    lines.push(
      `${en ? 'Original price' : '元の価格'}：${r.anchorAmount} ${r.anchorSymbol} ≈ ${r.totalAmount ?? r.amount} ${r.currency}`,
    );
    if (r.fxRate) lines.push(`${en ? 'Rate' : 'レート'}：1 USDC = ${r.fxRate}`);
  }
  lines.push('');
  lines.push(
    `${en ? 'Payment' : '支払い方法'}：${r.currency}${r.chainName ? ` / ${r.chainName}` : ''}`,
  );
  if (r.txHash) lines.push(`${en ? 'Tx hash' : '取引hash'}：${r.txHash}`);
  lines.push(`${en ? 'Merchant wallet' : '店舗ウォレット'}：${r.merchantAddress}`);
  if (r.payerAddress) lines.push(`${en ? 'Payer wallet' : '顧客ウォレット'}：${r.payerAddress}`);
  return lines.join('\n');
}

/** JSON エクスポート (レシートそのまま・秘密情報なし)。 */
export function payerReceiptToJson(r: PayerReceipt): string {
  return JSON.stringify(r, null, 2);
}

const CSV_HEADER: readonly string[] = [
  '日時',
  'レシート番号',
  '取引Hash',
  'チェーン',
  '通貨',
  '商品名',
  '数量',
  '単価',
  '明細金額',
  '税率(%)',
  '税額',
  '合計',
  'メモ',
];

function receiptRows(r: PayerReceipt): string[][] {
  const base = (li: HistoryLineItem): string[] => [
    formatReceiptDateTime(r.paidAt ?? r.createdAt, r.locale),
    r.receiptNo ?? '',
    r.txHash ?? '',
    r.chainName ?? (r.chainId != null ? String(r.chainId) : ''),
    r.currency,
    li.name,
    String(li.quantity),
    li.unitPrice,
    li.amount,
    li.taxRate != null ? String(li.taxRate) : '',
    li.taxAmount ?? '',
    r.totalAmount ?? r.amount,
    li.memo ?? r.memo ?? '',
  ];
  return (r.lineItems ?? []).map(base);
}

/** 1 レシートの明細 CSV (1 商品 1 行・UTF-8 BOM)。 */
export function payerReceiptCsv(r: PayerReceipt): string {
  return buildCsv([CSV_HEADER, ...receiptRows(r)]);
}

/** ダウンロード用ファイル名の幹: openpay-receipt-<receiptNo|receiptId|日付>。 */
function receiptFileStem(r: PayerReceipt, now: Date): string {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const id = (r.receiptNo ?? r.receiptId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return `openpay-receipt-${id || stamp}`;
}

export function payerReceiptCsvFilename(r: PayerReceipt, now: Date = new Date()): string {
  return `${receiptFileStem(r, now)}.csv`;
}

export function payerReceiptJsonFilename(r: PayerReceipt, now: Date = new Date()): string {
  return `${receiptFileStem(r, now)}.json`;
}
