// 取引履歴の「受取 (HistoryEntry) + 支払い (PayerReceipt)」統合ビューモデル (純関数)。
// 保存スキーマは変えず、表示時に正規化する read-time アダプタ。
//
// 方向 (direction) は **保存元で確定**する: history ストア = 受取 (in)、payerReceipts
// ストア = 支払い (out)。2 つのストアが元々方向を持つので接続アドレス比較は不要で堅牢
// (接続中ウォレットと別アドレスで受け取った場合の誤判定も無い)。
//
// 集計 (GMV/会計) は受取のみ基準を維持する。そちらは applyHistoryFilters(history) を
// 直接使い、ここで支払いを混ぜない (HistoryView 参照)。

import type { HistoryEntry } from './history';
import type { PayerReceipt, PayerReceiptStatus } from './payerReceipt';
import type { PaymentResult } from './paymentLog';
import type { TokenSymbol } from './tokens';
import { historyEntrySearchText, type HistoryFilters } from './historyFilters';

export type LedgerDirection = 'in' | 'out';

export type LedgerItem = {
  /** direction を含む一意 id (received/paid で衝突しないよう prefix)。 */
  id: string;
  ts: number;
  direction: LedgerDirection;
  asset: TokenSymbol | null;
  /** 共通 status フィルタ用に PaymentResult 空間へ正規化済み。 */
  status: PaymentResult;
  /** フィルタ検索用に正規化済みの lowercase テキスト。 */
  search: string;
  kind: 'received' | 'paid';
  /** direction==='in' のとき原本 HistoryEntry。 */
  received?: HistoryEntry;
  /** direction==='out' のとき原本 PayerReceipt。 */
  paid?: PayerReceipt;
};

// payerReceipt の status を履歴の PaymentResult 空間へ写像 (共通 status フィルタ用)。
// unknown は error でなく pending に倒す (受取の error フィルタに紛れ込ませない)。
function payerStatusToPaymentResult(s: PayerReceiptStatus): PaymentResult {
  switch (s) {
    case 'confirmed':
      return 'success';
    case 'failed':
      return 'reverted';
    case 'pending':
    case 'unknown':
      return 'pending';
  }
}

// tokenSymbol (display: 'JPYC'/'USDC' 等) を小文字 asset へ。jpyc/usdc 以外は null。
function normalizeAsset(tokenSymbol: string): TokenSymbol | null {
  const s = tokenSymbol.trim().toLowerCase();
  return s === 'jpyc' || s === 'usdc' ? s : null;
}

// ISO 文字列を ms に。不正/欠落は 0 (period フィルタ/sort へ NaN を漏らさない)。
function safeParseDate(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function buildLedger(
  history: ReadonlyArray<HistoryEntry>,
  receipts: ReadonlyArray<PayerReceipt>,
): LedgerItem[] {
  const items: LedgerItem[] = [];
  for (const e of history) {
    items.push({
      id: `in:${e.id}`,
      ts: e.ts,
      direction: 'in',
      asset: e.asset,
      status: e.status,
      search: historyEntrySearchText(e),
      kind: 'received',
      received: e,
    });
  }
  for (const r of receipts) {
    const lineNames = (r.lineItems ?? []).map((li) => li.name).join(' ');
    items.push({
      id: `out:${r.receiptId}`,
      ts: safeParseDate(r.paidAt ?? r.createdAt),
      direction: 'out',
      asset: normalizeAsset(r.tokenSymbol),
      status: payerStatusToPaymentResult(r.status),
      search:
        `${r.merchantAddress} ${r.merchantName ?? ''} ${r.tokenSymbol} ${r.txHash ?? ''} ${r.receiptNo ?? ''} ${r.memo ?? ''} ${lineNames}`.toLowerCase(),
      kind: 'paid',
      paid: r,
    });
  }
  // 時系列降順 (新しい順)。
  items.sort((a, b) => b.ts - a.ts);
  return items;
}

export function applyLedgerFilters(
  items: ReadonlyArray<LedgerItem>,
  filters: HistoryFilters,
): LedgerItem[] {
  const q = filters.search.trim().toLowerCase();
  return items.filter((it) => {
    if (filters.direction !== 'all' && it.direction !== filters.direction)
      return false;
    if (filters.asset !== 'all' && it.asset !== filters.asset) return false;
    if (filters.status !== 'all' && it.status !== filters.status) return false;
    if (filters.fromTs != null && it.ts < filters.fromTs) return false;
    if (filters.toTs != null && it.ts > filters.toTs) return false;
    if (q.length > 0 && !it.search.includes(q)) return false;
    return true;
  });
}

// 受取/支払いの件数 (全 ledger 基準・他フィルタ非依存)。種別タブの件数バッジ用。
export function ledgerDirectionCounts(items: ReadonlyArray<LedgerItem>): {
  all: number;
  in: number;
  out: number;
} {
  let inn = 0;
  let out = 0;
  for (const it of items) {
    if (it.direction === 'in') inn += 1;
    else out += 1;
  }
  return { all: items.length, in: inn, out };
}

// 通貨件数 (全 ledger 基準)。通貨ボタンの件数バッジ用 (受取+支払い両方を数える)。
export function ledgerAssetCounts(items: ReadonlyArray<LedgerItem>): {
  all: number;
  jpyc: number;
  usdc: number;
} {
  let jpyc = 0;
  let usdc = 0;
  for (const it of items) {
    if (it.asset === 'jpyc') jpyc += 1;
    else if (it.asset === 'usdc') usdc += 1;
  }
  return { all: items.length, jpyc, usdc };
}
