'use client';

// /scan に表示する顧客向け「電子レシート / 支払い控え」一覧。最新数件を
// ネイティブ <details> アコーディオンで列挙し、展開すると PayerReceiptDetail を出す。
//
// 控えは支払い側ブラウザの LocalStorage のみ (サーバ送信なし)。端末変更/削除/シークレットで
// 復元できない旨を明記する。

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { usePayerReceipts } from '@/hooks/usePayerReceipts';
import { PayerReceiptDetail } from './PayerReceiptDetail';
import {
  clearPayerReceipts,
  formatReceiptDateTime,
  removePayerReceipt,
  type PayerReceiptStatus,
} from '@/lib/payerReceipt';

const RECENT_LIMIT = 3;

const STATUS_DOT_CLASS = {
  confirmed: 'bg-emerald-500',
  pending: 'bg-sky-500',
  failed: 'bg-red-500',
  unknown: 'bg-slate-400',
} as const satisfies Record<PayerReceiptStatus, string>;

export function PayerReceiptList() {
  const t = useTranslations('PayerReceipt');
  const locale = useLocale();
  const { receipts, hydrated } = usePayerReceipts();

  // SSR / hydrate 前は固定高 placeholder で CLS を抑える (history 同様)。
  if (!hydrated) {
    return <div aria-hidden className="h-4" />;
  }

  const recent = receipts.slice(0, RECENT_LIMIT);

  function handleRemove(receiptId: string) {
    if (window.confirm(t('removeConfirm'))) removePayerReceipt(receiptId);
  }

  function handleClearAll() {
    if (window.confirm(t('clearAllConfirm'))) clearPayerReceipts();
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">
          {t('sectionTitle')}
        </h2>
        {receipts.length > 0 && (
          <button
            type="button"
            onClick={handleClearAll}
            className="text-[11px] text-slate-400 underline underline-offset-2 hover:text-red-600"
          >
            {t('clearAllButton')}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">{t('sectionDescription')}</p>

      {recent.length === 0 ? (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-4 text-center">
          <p className="text-sm text-slate-500">{t('empty')}</p>
          <p className="mt-1 text-xs text-slate-400">{t('emptyHint')}</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {recent.map((r) => (
            <li key={r.receiptId}>
              <details className="group rounded-xl border border-slate-200 bg-white">
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[r.status]}`}
                    />
                    <span className="truncate text-slate-700">
                      {r.merchantName || t('merchantFallback')}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-slate-900">
                      {r.totalAmount ?? r.amount} {r.currency}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {formatReceiptDateTime(r.paidAt ?? r.createdAt, locale)}
                    </span>
                  </span>
                </summary>
                <div className="border-t border-slate-100 p-2">
                  <PayerReceiptDetail receipt={r} onRemove={handleRemove} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}

      {/* 最新数件のみ表示 → 全件は取引履歴 (/history) に集約。 */}
      {receipts.length > 0 && (
        <Link
          href={`/${locale}/history`}
          prefetch={false}
          className="mt-3 inline-block text-xs font-medium text-brand hover:underline"
        >
          {t('historyLink')} →
        </Link>
      )}

      {/* 保存場所の注意 (空でも常時表示)。 */}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        {t('storageNotice')}
      </p>
    </section>
  );
}
