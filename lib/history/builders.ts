// 決済結果から保存用の HistoryEntry を組み立てる (自由入力の cap・売上明細の sanitize)。純関数のみ。

import type { GasMode, PayMode } from '../fee';
import type { PaymentFlow, PaymentResult } from '../paymentLog';
import type { TokenSymbol } from '../tokens';
import type { TaxCategory } from '../tax';
import { stripControlChars } from '../sanitize';
import {
  FEE_BREAKDOWN_VERSION,
  HISTORY_ERROR_MESSAGE_MAX_LENGTH,
  HISTORY_LINE_ITEMS_MAX,
  HISTORY_NOTE_MAX_LENGTH,
  HISTORY_PRODUCT_NAME_MAX,
  HISTORY_RECEIPT_NO_MAX,
  HISTORY_UNIT_AMOUNT_MAX,
  LATEST_SCHEMA_VERSION,
  type CircleVerification,
  type HistoryEntry,
  type HistoryLineItem,
  type HistoryProvider,
} from './model';

// 親 component (PaymentForm / CheckoutForm) が決済結果を整形するための builder。
// hook (useBatchPayment / useStandardPayment) は内部で append しない方針:
//   - hook は metadata (storeName / payMode / gasMode / chainSlug) を知らない
//   - hook signature を肥大化させたくない (test の差分が大きくなる)
//   - 同じ result から PaymentForm と CheckoutForm が異なる context を組み立てる余地を残す

export type BuildHistoryBase = {
  flow: PaymentFlow;
  status: PaymentResult;
  chainId: number;
  chainSlug: string;
  asset: TokenSymbol;
  tokenAddress: string;
  payMode: PayMode;
  gasMode: GasMode | null;
  merchant: string;
  merchantAmount: bigint;
  customer: string | null | undefined;
  feeReceiver: string | null;
  feeAmount: bigint | null;
  txHash: string | null;
  userOpHash: string | null;
  blockNumber: bigint | null;
  errorMessage: string | null;
  storeName: string;
  /** 任意メモ (CheckoutForm の params.description / orderId 等)。省略時 ''。 */
  note?: string;
  // --- v2 (省略時はすべて null = legacy/standard 互換) ---
  provider?: HistoryProvider | null;
  circlePaymasterAddress?: string | null;
  circlePaymasterNetUsdc?: string | null;
  circleVerification?: CircleVerification | null;
  // --- v3 (fee/gas 分離。省略時 null = sale を伴わない leg / 互換) ---
  /** 売上総額 (gross・請求額)。sale を伴う entry で設定、手数料徴収 leg 等は null。 */
  saleAmount?: bigint | null;
  /** ネットワーク手数料相当額 (非 circle の gasless 経路)。省略時 null。 */
  networkFeeEquivalent?: bigint | null;
  // --- v4 (異通貨建ての anchor。FX 換算決済の sale leg のみ設定・省略時 null) ---
  /** 元の価格建て金額 (人間可読・raw wei ではない)。例 "1000"。 */
  anchorAmount?: string | null;
  /** 価格を建てたトークン (settled asset の counterpart)。 */
  anchorSymbol?: TokenSymbol | null;
  /** 生成時 usdcJpy (例 "156.32")。 */
  fxRateUsdcJpy?: string | null;
  // --- v5 (記帳補助メタデータ。sale leg のみ設定・省略時 null) ---
  productName?: string | null;
  memo?: string | null;
  taxRate?: number | null;
  taxCategory?: TaxCategory | null;
  receiptNo?: string | null;
  lineItems?: HistoryLineItem[] | null;
};

// 自由入力の length cap (LocalStorage 肥大化 / 悪意 URL 対策)。空文字は null に畳む。
function cappedOrNull(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const stripped = stripControlChars(value);
  if (!stripped) return null;
  const capped = stripped.length > max ? stripped.slice(0, max) : stripped;
  const clean = stripControlChars(capped);
  return clean || null;
}

// 売上明細を sanitize: 件数 cap・各文字列 cap・quantity を正整数へ。空配列は null。
function sanitizeLineItems(
  items: HistoryLineItem[] | null | undefined,
): HistoryLineItem[] | null {
  if (items == null || items.length === 0) return null;
  return items.slice(0, HISTORY_LINE_ITEMS_MAX).map((it) => {
    const out: HistoryLineItem = {
      name: cappedOrNull(it.name, HISTORY_PRODUCT_NAME_MAX) ?? '',
      quantity:
        Number.isFinite(it.quantity) && it.quantity >= 1
          ? Math.floor(it.quantity)
          : 1,
      unitPrice: cappedOrNull(it.unitPrice, HISTORY_UNIT_AMOUNT_MAX) ?? '',
      amount: cappedOrNull(it.amount, HISTORY_UNIT_AMOUNT_MAX) ?? '',
      taxRate: it.taxRate ?? null,
      taxCategory: it.taxCategory ?? null,
      memo: cappedOrNull(it.memo, HISTORY_NOTE_MAX_LENGTH),
    };
    // 任意フィールドは在るときだけ保存 (undefined を JSON に残さない)。
    const id = cappedOrNull(it.id, 64);
    if (id) out.id = id;
    if (it.currency === 'jpyc' || it.currency === 'usdc') out.currency = it.currency;
    const ta = cappedOrNull(it.taxAmount, HISTORY_UNIT_AMOUNT_MAX);
    if (ta) out.taxAmount = ta;
    const presetId = cappedOrNull(it.presetId, 64);
    if (presetId) out.presetId = presetId;
    return out;
  });
}

/**
 * 一意 id の決定規則:
 *   - txHash あり    → `${flow}-${txHash}` (同一 tx の二重 append を防ぐ)
 *   - userOpHash あり → `${flow}-uo-${userOpHash}`
 *   - hash なし (writeContract 同期 throw / wallet rejected sign 等):
 *      `${flow}-err-${seconds}-${errorMessage.slice(0,32)}`
 *      - seconds 解像度なので Next.js dev の React StrictMode 二重発火
 *        (microsecond 差) は同 id で dedupe される。
 *      - 1 秒以上開けたユーザ retry は別 id (= 別 entry) として記録。
 *      - errorMessage が同一でも秒が違えば別 entry。
 *      - errorMessage 不在の極稀 case は 'noerr' を seed に使用。
 *
 * StrictMode 二重 effect / react-query onSuccess 再呼出のいずれでも
 * appendHistory 側 (id 一致) で dedupe される。
 */
export function buildHistoryEntry(
  input: BuildHistoryBase & { ts?: number },
): HistoryEntry {
  const ts = input.ts ?? Date.now();
  const id = input.txHash
    ? `${input.flow}-${input.txHash}`
    : input.userOpHash
      ? `${input.flow}-uo-${input.userOpHash}`
      : `${input.flow}-err-${Math.floor(ts / 1000)}-${(input.errorMessage ?? 'noerr').slice(0, 32)}`;
  return {
    schemaVersion: LATEST_SCHEMA_VERSION,
    id,
    ts,
    flow: input.flow,
    status: input.status,
    chainId: input.chainId,
    chainSlug: input.chainSlug,
    asset: input.asset,
    tokenAddress: input.tokenAddress,
    payMode: input.payMode,
    gasMode: input.gasMode,
    merchant: input.merchant,
    merchantAmount: input.merchantAmount.toString(),
    customer: input.customer ?? null,
    feeReceiver: input.feeReceiver,
    feeAmount: input.feeAmount === null ? null : input.feeAmount.toString(),
    txHash: input.txHash,
    userOpHash: input.userOpHash,
    blockNumber: input.blockNumber === null ? null : input.blockNumber.toString(),
    errorMessage:
      input.errorMessage === null
        ? null
        : input.errorMessage.slice(0, HISTORY_ERROR_MESSAGE_MAX_LENGTH),
    storeName: input.storeName,
    note: (input.note ?? '').slice(0, HISTORY_NOTE_MAX_LENGTH),
    provider: input.provider ?? null,
    circlePaymasterAddress: input.circlePaymasterAddress ?? null,
    circlePaymasterNetUsdc: input.circlePaymasterNetUsdc ?? null,
    circleVerification: input.circleVerification ?? null,
    saleAmount: input.saleAmount == null ? null : input.saleAmount.toString(),
    networkFeeEquivalent:
      input.networkFeeEquivalent == null
        ? null
        : input.networkFeeEquivalent.toString(),
    // native v3 で記録した entry は常に分離済印を持つ (migration 経路のみ UNKNOWN)。
    feeBreakdownVersion: FEE_BREAKDOWN_VERSION,
    anchorAmount: input.anchorAmount ?? null,
    anchorSymbol: input.anchorSymbol ?? null,
    fxRateUsdcJpy: input.fxRateUsdcJpy ?? null,
    productName: cappedOrNull(input.productName, HISTORY_PRODUCT_NAME_MAX),
    memo: cappedOrNull(input.memo, HISTORY_NOTE_MAX_LENGTH),
    taxRate: input.taxRate ?? null,
    taxCategory: input.taxCategory ?? null,
    receiptNo: cappedOrNull(input.receiptNo, HISTORY_RECEIPT_NO_MAX),
    lineItems: sanitizeLineItems(input.lineItems),
  };
}
