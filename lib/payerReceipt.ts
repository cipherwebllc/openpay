// 顧客向け「電子レシート / 支払い控え」を支払い側ブラウザの LocalStorage に保存する。
//
// 店舗側の売上履歴 (lib/history.ts / openpay:history:v1) とは **別ストア**。direction:'paid' /
// kind:'payment_receipt' で区別し、顧客が支払いを完了した控えとして /scan に表示する。
// 正式な領収書・税務証憑ではなく支払い確認の補助 (UI 文言は「電子レシート / 支払い控え」)。
//
// サーバ送信なし・秘密情報なし (txHash・アドレス・金額・商品名のみ)。端末のブラウザ scope のみ。
// 設計は lib/history.ts の load/migrate/append/CustomEvent パターンを踏襲 (壊れたデータは drop)。

import { formatUnits, parseUnits } from 'viem';
import { lineItemsDiscountWei } from './discount';
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
import { taxAmountDecimal, taxDisplayDecimals } from './tax';
import {
  invoiceLookupUrl,
  invoiceReceiptView,
  normalizeInvoiceRegistrationNumber,
} from './invoice';

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
  /** モバイル注文の StoredOrder 束縛キー。receiptNo とは別物。 */
  orderId?: string;
  /** ISO 文字列。 */
  createdAt: string;
  paidAt?: string;
  direction: 'paid';
  kind: 'payment_receipt';
  status: PayerReceiptStatus;
  gatewayTransferSpecHash?: string;
  txHash?: string;
  chainId?: number;
  chainName?: string;
  tokenSymbol: string;
  tokenAddress?: string;
  /** 支払総額 (人間可読 decimal・token 単位)。 */
  amount: string;
  currency: string;
  merchantName?: string;
  /** 店舗が設定したインボイス登録番号 (T + 13 桁・正規化済み)。OpenPay は登録状況を確かめない。 */
  merchantInvoiceNo?: string;
  merchantAddress: string;
  payerAddress?: string;
  paymentMode?: string;
  gasMode?: string;
  /** 共通の売上明細型を再利用 (店舗側 lineItems と同型)。 */
  lineItems?: HistoryLineItem[];
  /** 値引き前の小計 (値引きがあるときは 合計 + 値引き)。 */
  subtotalAmount?: string;
  /** レジの値引きの合計 (token 単位・明細の discount の合計)。値引きの無い控えは省略。 */
  discountAmount?: string;
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
  gatewayTransferSpecHash?: string;
  txHash?: string | null;
  userOpHash?: string | null;
  chainId?: number;
  asset: TokenSymbol;
  tokenAddress?: string | null;
  /** 支払総額 (人間可読 decimal)。 */
  amount: string;
  merchantAddress: string;
  merchantName?: string | null;
  merchantInvoiceNo?: string | null;
  payerAddress?: string | null;
  paymentMode?: string | null;
  gasMode?: string | null;
  lineItems?: HistoryLineItem[] | null;
  subtotalAmount?: string;
  discountAmount?: string | null;
  totalTaxAmount?: string;
  totalAmount?: string;
  memo?: string | null;
  receiptNo?: string | null;
  orderId?: string | null;
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
    receiptId: input.gatewayTransferSpecHash ? `gateway:${chainId}:${input.gatewayTransferSpecHash.toLowerCase()}` : txHash || input.userOpHash || randomId(),
    gatewayTransferSpecHash: input.gatewayTransferSpecHash,
    receiptNo: input.receiptNo ?? undefined,
    orderId: input.orderId ?? undefined,
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
    merchantInvoiceNo: normalizeInvoiceRegistrationNumber(input.merchantInvoiceNo) ?? undefined,
    merchantAddress: input.merchantAddress,
    payerAddress: input.payerAddress ?? undefined,
    paymentMode: input.paymentMode ?? undefined,
    gasMode: input.gasMode ?? undefined,
    lineItems,
    subtotalAmount: input.subtotalAmount ?? input.totalAmount ?? input.amount,
    ...(input.discountAmount ? { discountAmount: input.discountAmount } : {}),
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

// 明細 (lineItems) の無い単品 QR の 1 行。金額は顧客が払った総額 (gross) で組み、entry の税率を
// 引き継ぐ (店舗側の entryLineItems は手取り額で組むため、店主がガス代を負担すると総額とずれる)。
// 商品名も税率も無ければ [] を返し、buildPayerReceipt の仮想行 (対象外) に任せる。
function singleReceiptLine(
  entry: HistoryEntry,
  grossTotal: string,
  merchantName?: string | null,
): HistoryLineItem[] {
  if (!entry.productName && entry.taxRate == null) return [];
  const taxAmount = taxAmountDecimal(
    Number(grossTotal),
    entry.taxRate,
    taxDisplayDecimals(entry.asset),
  );
  return [
    {
      id: `${entry.id}-0`,
      name:
        entry.productName ||
        entry.storeName?.trim() ||
        merchantName?.trim() ||
        VIRTUAL_FALLBACK_NAME,
      quantity: 1,
      unitPrice: grossTotal,
      amount: grossTotal,
      currency: entry.asset,
      taxRate: entry.taxRate,
      taxCategory: entry.taxCategory,
      taxAmount: taxAmount == null ? '0' : String(taxAmount),
      memo: entry.memo,
    },
  ];
}

/** 店舗側 HistoryEntry (sale 成功 leg) → 顧客向け PayerReceipt 写像。 */
export function payerReceiptFromHistoryEntry(
  entry: HistoryEntry,
  opts: {
    sourceRoute?: string;
    locale?: string;
    orderId?: string;
    /** 控えに出す店名 (店舗側履歴の storeName が空の経路用。履歴・会計 CSV の取引先は変えない)。 */
    merchantName?: string | null;
    invoiceNo?: string | null;
    now?: Date;
  } = {},
): PayerReceipt {
  const totals = entryTotals(entry);
  // 顧客控えの総額は「商品の請求額 (gross sale)」を使う。店主が gas を吸収する gasMode では
  // merchantAmount は gas 控除後の手取りとなり、顧客が支払った商品代金 (= 明細合計 = saleAmount)
  // と一致しない。saleAmount を優先し、無い leg は merchantAmount にフォールバック (= totals.total)。
  const grossRaw = entry.saleAmount ?? entry.merchantAmount;
  const grossTotal = /^\d+$/.test(grossRaw)
    ? formatUnits(BigInt(grossRaw), HISTORY_ASSET_DECIMALS[entry.asset])
    : totals.total;
  // 明細の無い単品は総額 (gross) の 1 行で組み、税額もその行から取る (手取り由来の entryTotals と
  // 混ぜると、同じ控えの中で行の税額と合計の税額が食い違う)。
  const single = entry.lineItems && entry.lineItems.length > 0 ? null : singleReceiptLine(entry, grossTotal, opts.merchantName);
  const lineItems = single ?? entryLineItems(entry);
  const totalTaxAmount = single && single.length > 0 ? (single[0].taxAmount ?? '0') : totals.totalTax;
  // レジの値引き: 明細に配った額の合計。小計は値引き前 (= 合計 + 値引き)。壊れた値引きは出さない。
  const decimals = HISTORY_ASSET_DECIMALS[entry.asset];
  const discountWei = single ? 0n : (lineItemsDiscountWei(entry.lineItems, decimals) ?? 0n);
  const discountAmount = discountWei > 0n ? formatUnits(discountWei, decimals) : null;
  const subtotalAmount = discountWei > 0n
    ? formatUnits(parseUnits(grossTotal, decimals) + discountWei, decimals)
    : grossTotal;
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
      merchantName: entry.storeName.trim() || opts.merchantName,
      merchantInvoiceNo: opts.invoiceNo,
      payerAddress: entry.customer,
      paymentMode: entry.payMode,
      gasMode: entry.gasMode,
      lineItems,
      subtotalAmount,
      discountAmount,
      totalTaxAmount,
      totalAmount: grossTotal,
      memo: entry.memo,
      receiptNo: entry.receiptNo,
      orderId: opts.orderId,
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

// status の許容値 (PayerReceiptStatus と同期 — satisfies が乖離をコンパイルエラー化する)。
// 許容外 status は描画側の STATUS_BADGE_CLASS / STATUS_I18N_KEY 引きが undefined になり
// className 崩れ・t(undefined) throw を起こすため、validator で drop する
// (direction/kind と同じ厳格度)。
const VALID_RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  'confirmed',
  'pending',
  'failed',
  'unknown',
] satisfies PayerReceiptStatus[]);

function isValidReceipt(value: unknown): value is PayerReceipt {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== PAYER_RECEIPT_SCHEMA_VERSION) return false;
  if (typeof r.receiptId !== 'string' || r.receiptId.length === 0) return false;
  if (r.direction !== 'paid' || r.kind !== 'payment_receipt') return false;
  if (typeof r.status !== 'string' || !VALID_RECEIPT_STATUSES.has(r.status)) return false;
  if (typeof r.createdAt !== 'string') return false;
  if (typeof r.tokenSymbol !== 'string') return false;
  if (typeof r.amount !== 'string') return false;
  if (typeof r.merchantAddress !== 'string') return false;
  if (r.orderId !== undefined && typeof r.orderId !== 'string') return false;
  if (r.lineItems !== undefined && !isValidLineItems(r.lineItems)) return false;
  if (r.discountAmount !== undefined && typeof r.discountAmount !== 'string') return false;
  return true;
}

// 現状 v1 単独。schemaVersion 欠落は v1 とみなして救済し、LATEST 以外 (未来/未知) は
// 移行手段が無いので読込結果から除外 (保存時は保持)。v2 時は v1→v2 の変換ステップを追加する。
function migrateToLatest(value: unknown): PayerReceipt | null {
  if (value === null || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const version =
    typeof r.schemaVersion === 'number' ? r.schemaVersion : PAYER_RECEIPT_SCHEMA_VERSION;
  if (version !== PAYER_RECEIPT_SCHEMA_VERSION) return null;
  const normalized = { ...r, schemaVersion: PAYER_RECEIPT_SCHEMA_VERSION };
  return isValidReceipt(normalized) ? normalized : null;
}

type StoredReceiptItem = { raw: unknown; receipt: PayerReceipt | null };

// 保持した未知項目の再読込が Sentry の警告・quota 消費へ繰り返し波及しないよう、ページ内で一度だけ通知。
let hasWarnedUnreadableEntries = false;

function loadPayerReceiptItems(): StoredReceiptItem[] {
  const raw = safeGet<unknown>(PAYER_RECEIPTS_STORAGE_KEY, []);
  if (!Array.isArray(raw)) {
    logger.warn('payerReceipts.load.not-array', { actual: typeof raw });
    return [];
  }
  const items: StoredReceiptItem[] = [];
  let invalid = 0;
  for (const item of raw) {
    const migrated = migrateToLatest(item);
    if (migrated === null) invalid += 1;
    // 読込除外が無関係な控えの書込で永久削除へ波及しないよう、不明項目も元の位置で保持。
    items.push({ raw: item, receipt: migrated });
  }
  if (invalid > 0 && !hasWarnedUnreadableEntries) {
    hasWarnedUnreadableEntries = true;
    logger.warn('payerReceipts.load.unreadable-entries-preserved', { invalid, kept: items.length - invalid });
  }
  return items;
}

export function loadPayerReceipts(): PayerReceipt[] {
  return loadPayerReceiptItems().flatMap(({ receipt }) => receipt === null ? [] : [receipt]);
}

function savePayerReceiptItems(items: StoredReceiptItem[]): void {
  safeSet(PAYER_RECEIPTS_STORAGE_KEY, items.map(({ raw, receipt }) => receipt ?? raw));
}

function broadcastChange(): void {
  window.dispatchEvent(new Event(PAYER_RECEIPTS_CHANGED_EVENT));
}

export function appendPayerReceipt(receipt: PayerReceipt): void {
  if (typeof window === 'undefined') return;
  const current = loadPayerReceiptItems();
  // 同一 receiptId (= 同一 tx) は基本 no-op で dedupe する。ただし relay/gasless が
  // pending (txHash あり) で先に保存した控えに対し、後続で同一 tx の confirmed/failed
  // が来た場合のみ **既存 entry を昇格** (pending → confirmed/failed) して保存・broadcast
  // する。StrictMode 二重発火・再描画は同一 status なので引き続き no-op (昇格しない)。
  // downgrade 方向 (例: confirmed → pending) や既存が non-pending の再 append も no-op。
  // 未知 schema の receiptId は解釈せず保持する。rollback 中に同じ支払いを再記帳すると、
  // roll-forward 後に重複表示されうる既知の制約がある (未知データを推測で削除しない)。
  const idx = current.findIndex((item) => item.receipt?.receiptId === receipt.receiptId);
  const existing = current[idx]?.receipt;
  if (existing) {
    const isPromotion =
      existing.status === 'pending' &&
      (receipt.status === 'confirmed' || receipt.status === 'failed');
    const gatewayDetails = existing.gatewayTransferSpecHash && !existing.txHash && receipt.txHash &&
      receipt.gatewayTransferSpecHash === existing.gatewayTransferSpecHash;
    if (!isPromotion && !gatewayDetails) return;
    const next = [...current];
    next[idx] = {
      ...current[idx],
      receipt: {
        ...existing,
        ...(gatewayDetails ? { txHash: receipt.txHash, explorerUrl: receipt.explorerUrl } : {}),
        status: receipt.status,
        paidAt: receipt.paidAt ?? existing.paidAt,
      },
    };
    savePayerReceiptItems(next);
    broadcastChange();
    return;
  }
  const next = [{ raw: receipt, receipt }, ...current];
  const trimmed =
    next.length > PAYER_RECEIPTS_MAX ? next.slice(0, PAYER_RECEIPTS_MAX) : next;
  savePayerReceiptItems(trimmed);
  broadcastChange();
}

/** Enrich only an existing receipt; background recovery must not create a new payment success. */
export function backfillGatewayPayerReceipt(chainId: number, transferSpecHash: string, txHash: string): void {
  if (typeof window === 'undefined') return;
  const items = loadPayerReceiptItems();
  const item = items.find((r) => r.receipt?.receiptId === `gateway:${chainId}:${transferSpecHash.toLowerCase()}`);
  if (!item?.receipt || item.receipt.txHash === txHash) return;
  // Finalized backfill may replace a pre-finality receipt hash after a reorg; never append a second receipt.
  item.receipt = { ...item.receipt, txHash, explorerUrl: txExplorerUrl(chainId, txHash) };
  savePayerReceiptItems(items);
  broadcastChange();
}

/**
 * pending 控えの status を on-chain 確定結果で昇格する。対象 receipt が存在し
 * status==='pending' のときのみ status を更新して保存・broadcast し true を返す。
 * 不在 / 既に non-pending の場合は false (no-op)。reconcile (lib/payerReceiptReconcile.ts)
 * が on-chain receipt と突き合わせて呼ぶ。
 */
export function promotePayerReceiptStatus(
  receiptId: string,
  status: 'confirmed' | 'failed',
): boolean {
  if (typeof window === 'undefined') return false;
  const current = loadPayerReceiptItems();
  const idx = current.findIndex((item) => item.receipt?.receiptId === receiptId);
  const existing = current[idx]?.receipt;
  if (existing?.status !== 'pending') return false;
  const next = [...current];
  next[idx] = { ...current[idx], receipt: { ...existing, status } };
  savePayerReceiptItems(next);
  broadcastChange();
  return true;
}

export function removePayerReceipt(receiptId: string): void {
  if (typeof window === 'undefined') return;
  const current = loadPayerReceiptItems();
  const next = current.filter((item) => item.receipt?.receiptId !== receiptId);
  if (next.length === current.length) return;
  savePayerReceiptItems(next);
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
  const invoice = invoiceReceiptView(r);
  if (invoice) {
    lines.push(`${en ? 'Registration no.' : '登録番号'}：${invoice.registrationNumber}`);
  }
  lines.push('');
  for (const li of r.lineItems ?? []) {
    const reduced = invoice && li.taxRate === 8 ? ' ※' : '';
    lines.push(`${li.name} x ${li.quantity}${reduced}    ${li.amount} ${r.currency}`);
  }
  lines.push('');
  // レジの値引き: 小計 (値引き前) → 値引き。以下の税率ごとの額・合計は値引き後。
  if (r.discountAmount) {
    if (r.subtotalAmount) lines.push(`${en ? 'Subtotal' : '小計'}：${r.subtotalAmount} ${r.currency}`);
    lines.push(`${en ? 'Discount' : '値引き'}：−${r.discountAmount} ${r.currency}`);
  }
  if (invoice) {
    // インボイス欄: 税率ごとの税込合計と消費税額 (円・税率ごとに 1 回の端数処理)。
    // 行ごとに丸めた税額の合計 (totalTaxAmount) は並べない (同じ控えで数字が食い違うため)。
    for (const g of invoice.groups) {
      lines.push(invoiceGroupCopyLine(g.rate, g.total, g.tax, r.currency, en));
    }
  } else if (payerReceiptHasTax(r)) {
    // 税額が計上されているときだけ小計/消費税を併記 (0 のときは合計のみで十分)。
    if (r.subtotalAmount && !r.discountAmount) lines.push(`${en ? 'Subtotal' : '小計'}：${r.subtotalAmount} ${r.currency}`);
    lines.push(`${en ? 'Tax' : '消費税'}：${r.totalTaxAmount} ${r.currency}`);
  }
  lines.push(`${en ? 'Total' : '合計'}：${r.totalAmount ?? r.amount} ${r.currency}`);
  if (invoice?.hasReducedRate) {
    lines.push(en ? '※ Reduced tax rate (8%) item' : '※ は軽減税率 (8%) の対象です');
  }
  // 異通貨建て: 元価格 (請求建て) を併記し、顧客が QR で見た価格を控えに残す。
  if (r.anchorAmount && r.anchorSymbol) {
    lines.push(
      `${en ? 'Original price' : '元の価格'}：${r.anchorAmount} ${r.anchorSymbol} ≈ ${r.totalAmount ?? r.amount} ${r.currency}`,
    );
    // 通貨単位は詳細表示の i18n fxRateLine (ja「{rate} 円」/ en「¥{rate}」) と揃える
    // (単位を欠くと第三者に渡した控えでレートの分母通貨が曖昧になる)。
    if (r.fxRate) {
      lines.push(en ? `Rate：1 USDC = ¥${r.fxRate}` : `レート：1 USDC = ${r.fxRate} 円`);
    }
  }
  lines.push('');
  lines.push(
    `${en ? 'Payment' : '支払い方法'}：${r.currency}${r.chainName ? ` / ${r.chainName}` : ''}`,
  );
  if (r.txHash) lines.push(`${en ? 'Tx hash' : '取引hash'}：${r.txHash}`);
  lines.push(`${en ? 'Merchant wallet' : '店舗ウォレット'}：${r.merchantAddress}`);
  if (r.payerAddress) lines.push(`${en ? 'Payer wallet' : '顧客ウォレット'}：${r.payerAddress}`);
  if (invoice) {
    // 画面の免責と同じ前提を、コピーして共有した先にも残す (未確認の番号を確認済みに見せない)。
    lines.push('');
    lines.push(
      en
        ? 'The registration number is set by the shop; OpenPay does not check the registration. The date and time come from the device used to pay.'
        : '登録番号は店舗が設定した値で、OpenPay は登録状況を確かめていません。日時はお支払いに使った端末の時刻です。',
    );
    lines.push(`${en ? 'Check' : '確認'}：${invoiceLookupUrl(invoice.registrationNumber)}`);
  }
  return lines.join('\n');
}

function invoiceGroupCopyLine(
  rate: number,
  total: string,
  tax: string,
  currency: string,
  en: boolean,
): string {
  if (rate === 0) {
    return `${en ? 'Tax-exempt / out of scope' : '非課税・対象外'}：${total} ${currency}`;
  }
  return en
    ? `${rate}% items：${total} ${currency} (incl. consumption tax ¥${tax})`
    : `${rate}% 対象：${total} ${currency}（うち消費税 ${tax} 円）`;
}

/** JSON エクスポート (レシートそのまま・秘密情報なし)。インボイス欄を出せる控えは税率別の集計も添える
 *  (行ごとの taxAmount を第三者が足すと税率ごとの 1 回の端数処理とずれるため)。 */
export function payerReceiptToJson(r: PayerReceipt): string {
  const invoice = invoiceReceiptView(r);
  return JSON.stringify(invoice ? { ...r, invoice } : r, null, 2);
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
  // レジの値引き (この行に配った額)。値引きの無い控えは空欄。
  '値引き',
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
    li.discount ?? '',
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
