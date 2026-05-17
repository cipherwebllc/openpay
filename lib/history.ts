'use client';

// 「決済の控え」をブラウザ LocalStorage に保存する。
//
// OpenPay はノンカストディ設計のため、売上の真正性はチェーン上の tx にあり、
// この履歴はあくまで「同じブラウザで処理した決済の閲覧/CSV エクスポート用補助」。
// 端末が変われば履歴も消えるし、端末紛失で第三者が読めば内容は閲覧可能 (rotate
// なし)。NonCustodialNotice (full) でユーザに毎回その性質を明示する。
//
// 設計判断:
// - LocalStorage は origin scope。XSS が無ければ他オリジンから読めない。
//   ~500B/entry × 1000 = 500KB ≪ 5MB 上限。
// - bigint は JSON シリアライズできないため string 化して保存。
// - `id` で dedupe — React StrictMode の二重 effect / mutation onSuccess 再呼出を吸収。
// - FIFO 1000 件 cap — 古いものから削除。
// - cross-tab 同期:
//     LocalStorage の `storage` event は他タブのみ発火する仕様。自タブの再描画は
//     CustomEvent (`openpay:history-changed`) で別経路で通知する。
// - corrupt JSON / schema mismatch:
//     load 時に valid entries のみ復元、不正値は静かに脱落 (UI 全滅より部分復元)。

import { safeGet, safeSet } from './storage';
import { logger } from './logger';

export const HISTORY_STORAGE_KEY = 'openpay:history:v1';
export const HISTORY_CHANGED_EVENT = 'openpay:history-changed';
export const HISTORY_MAX_ENTRIES = 1000;

export type HistoryFlow =
  | 'batch'
  | 'direct'
  | 'standard-merchant'
  | 'standard-fee';

export type HistoryStatus = 'success' | 'reverted' | 'error';

export type HistoryAsset = 'jpyc' | 'usdc';

export type HistoryPayMode = 'gasless' | 'standard';

export type HistoryGasMode = 'customer' | 'merchant';

export type HistoryEntry = {
  /** dedupe 用一意キー。tx hash があれば `${flow}-${hash}`、無ければ uuid。 */
  id: string;
  /** 取込時刻 (Date.now())。チェーン上 block time とは別物 (UI 表示用)。 */
  ts: number;
  flow: HistoryFlow;
  status: HistoryStatus;
  chainId: number;
  /** "base" | "arbitrum" | "optimism" | "polygon"。URL 復元等で使う。 */
  chainSlug: string;
  asset: HistoryAsset;
  tokenAddress: string;
  /** 「JPYC ガスレス決済 (customer 負担)」等の表示識別子に。 */
  payMode: HistoryPayMode;
  /** standard モードでは概念がないため null。gasless のみ意味あり。 */
  gasMode: HistoryGasMode | null;
  merchant: string;
  /** bigint 文字列化 (raw wei)。decimal 化は表示時に formatTokenAmount。 */
  merchantAmount: string;
  customer: string | null;
  feeReceiver: string | null;
  feeAmount: string | null;
  txHash: string | null;
  userOpHash: string | null;
  /** receipt の blockNumber を文字列化したもの (UI 表示 + Explorer リンク用)。 */
  blockNumber: string | null;
  errorMessage: string | null;
  /** QR 設定の店舗名 (merchant が自分のブラウザで決済した場合のみ有意義)。 */
  storeName: string;
  /** 任意メモ (将来の inline edit 用、Phase 2 投入時は空)。 */
  note: string;
};

// schema 検証: load 時に corrupt / 旧 schema entry を静かに脱落させる。
// 必須 field の typeof / 列挙チェックのみ。bigint string や address 形式の
// 厳密検証は表示時 (formatTokenAmount / Explorer) の責務に委譲する。
function isValidEntry(value: unknown): value is HistoryEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return false;
  if (
    e.flow !== 'batch' &&
    e.flow !== 'direct' &&
    e.flow !== 'standard-merchant' &&
    e.flow !== 'standard-fee'
  )
    return false;
  if (e.status !== 'success' && e.status !== 'reverted' && e.status !== 'error')
    return false;
  if (typeof e.chainId !== 'number') return false;
  if (typeof e.chainSlug !== 'string') return false;
  if (e.asset !== 'jpyc' && e.asset !== 'usdc') return false;
  if (typeof e.tokenAddress !== 'string') return false;
  if (e.payMode !== 'gasless' && e.payMode !== 'standard') return false;
  if (e.gasMode !== null && e.gasMode !== 'customer' && e.gasMode !== 'merchant')
    return false;
  if (typeof e.merchant !== 'string') return false;
  if (typeof e.merchantAmount !== 'string') return false;
  if (e.customer !== null && typeof e.customer !== 'string') return false;
  if (e.feeReceiver !== null && typeof e.feeReceiver !== 'string') return false;
  if (e.feeAmount !== null && typeof e.feeAmount !== 'string') return false;
  if (e.txHash !== null && typeof e.txHash !== 'string') return false;
  if (e.userOpHash !== null && typeof e.userOpHash !== 'string') return false;
  if (e.blockNumber !== null && typeof e.blockNumber !== 'string') return false;
  if (e.errorMessage !== null && typeof e.errorMessage !== 'string') return false;
  if (typeof e.storeName !== 'string') return false;
  if (typeof e.note !== 'string') return false;
  return true;
}

export function loadHistory(): HistoryEntry[] {
  const raw = safeGet<unknown>(HISTORY_STORAGE_KEY, []);
  if (!Array.isArray(raw)) {
    logger.warn('history.load.not-array', { actual: typeof raw });
    return [];
  }
  const valid: HistoryEntry[] = [];
  let invalid = 0;
  for (const item of raw) {
    if (isValidEntry(item)) {
      valid.push(item);
    } else {
      invalid += 1;
    }
  }
  if (invalid > 0) {
    logger.warn('history.load.invalid-entries-dropped', {
      invalid,
      kept: valid.length,
    });
  }
  return valid;
}

function broadcastChange(): void {
  if (typeof window === 'undefined') return;
  // 自タブ向け CustomEvent。useHistory hook が拾って state を再 load する。
  window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
}

export function appendHistory(entry: HistoryEntry): void {
  if (typeof window === 'undefined') return;
  const current = loadHistory();
  // 同一 id (= 同一 tx hash 等) は no-op で dedupe。
  if (current.some((e) => e.id === entry.id)) return;
  const next = [entry, ...current];
  const trimmed =
    next.length > HISTORY_MAX_ENTRIES
      ? next.slice(0, HISTORY_MAX_ENTRIES)
      : next;
  safeSet(HISTORY_STORAGE_KEY, trimmed);
  broadcastChange();
}

export function removeHistoryEntry(id: string): void {
  if (typeof window === 'undefined') return;
  const current = loadHistory();
  const next = current.filter((e) => e.id !== id);
  if (next.length === current.length) return;
  safeSet(HISTORY_STORAGE_KEY, next);
  broadcastChange();
}

export function clearHistory(): void {
  if (typeof window === 'undefined') return;
  safeSet(HISTORY_STORAGE_KEY, []);
  broadcastChange();
}

// 親 component (PaymentForm / CheckoutForm) が決済結果を整形するための builder。
// hook (useBatchPayment / useStandardPayment) は内部で append しない方針:
//   - hook は metadata (storeName / payMode / gasMode / chainSlug) を知らない
//   - hook signature を肥大化させたくない (test の差分が大きくなる)
//   - 同じ result から PaymentForm と CheckoutForm が異なる context を組み立てる余地を残す

export type BuildHistoryBase = {
  flow: HistoryFlow;
  status: HistoryStatus;
  chainId: number;
  chainSlug: string;
  asset: HistoryAsset;
  tokenAddress: string;
  payMode: HistoryPayMode;
  gasMode: HistoryGasMode | null;
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
};

/**
 * 一意 id の決定規則:
 *   - txHash あり → `${flow}-${txHash}` (同一 tx の二重 append を防ぐ)
 *   - userOpHash あり (tx 前段)  → `${flow}-uo-${userOpHash}`
 *   - hash なし (writeContract 同期 throw 等の極稀エラー) → `${flow}-err-${ts}`
 *
 * StrictMode 二重 effect / react-query onSuccess 再呼出のいずれでも
 * appendHistory 側で dedupe される。
 */
export function buildHistoryEntry(
  input: BuildHistoryBase & { ts?: number },
): HistoryEntry {
  const ts = input.ts ?? Date.now();
  const id = input.txHash
    ? `${input.flow}-${input.txHash}`
    : input.userOpHash
      ? `${input.flow}-uo-${input.userOpHash}`
      : `${input.flow}-err-${ts}`;
  return {
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
    errorMessage: input.errorMessage,
    storeName: input.storeName,
    note: input.note ?? '',
  };
}

/** 数値 timestamp を yyyy-MM-dd HH:mm:ss (locale 形式) に整形。CSV にも UI にも使う。 */
export function formatHistoryTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
