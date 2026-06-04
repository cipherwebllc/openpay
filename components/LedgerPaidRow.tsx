'use client';

// /history の「支払い (out)」行。受取行 (HistoryRow) と型が違うため、支払い控え
// (PayerReceipt) は専用行で描画する。/scan と同じく <details> アコーディオンで
// PayerReceiptDetail を展開し、受取/支払いは direction バッジで視覚的に区別する。
// 削除は per-item (removePayerReceipt) — /scan が最新 3 件に縮小されたため /history から
// 古い控えを消せるようにする。

import { useLocale, useTranslations } from 'next-intl';
import { PayerReceiptDetail } from './PayerReceiptDetail';
import {
  formatReceiptDateTime,
  removePayerReceipt,
  type PayerReceipt,
  type PayerReceiptStatus,
} from '@/lib/payerReceipt';

const STATUS_DOT_CLASS = {
  confirmed: 'bg-emerald-500',
  pending: 'bg-sky-500',
  failed: 'bg-red-500',
  unknown: 'bg-slate-400',
} as const satisfies Record<PayerReceiptStatus, string>;

export function LedgerPaidRow({ receipt }: { receipt: PayerReceipt }) {
  const t = useTranslations('History');
  const tp = useTranslations('PayerReceipt');
  const locale = useLocale();

  function handleRemove(receiptId: string) {
    if (window.confirm(tp('removeConfirm'))) removePayerReceipt(receiptId);
  }

  return (
    <li className="list-none">
    <details className="group rounded-xl border border-slate-200 bg-white">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          {/* 支払い (out) バッジ — 受取と一目で区別。 */}
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
            {t('directionOutBadge')}
          </span>
          <span
            aria-hidden
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[receipt.status]}`}
          />
          <span className="truncate text-slate-700">
            {receipt.merchantName || tp('merchantFallback')}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-slate-900">
            {receipt.totalAmount ?? receipt.amount} {receipt.currency}
          </span>
          <span className="text-[11px] text-slate-400">
            {formatReceiptDateTime(receipt.paidAt ?? receipt.createdAt, locale)}
          </span>
        </span>
      </summary>
      <div className="border-t border-slate-100 p-2">
        <PayerReceiptDetail receipt={receipt} onRemove={handleRemove} />
      </div>
    </details>
    </li>
  );
}
