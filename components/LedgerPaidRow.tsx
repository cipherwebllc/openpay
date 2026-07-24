'use client';

// /history の「支払い (out)」行。受取行 (HistoryRow) と型が違うため、支払い控え
// (PayerReceipt) は専用行で描画する。/scan と同じく <details> アコーディオンで
// PayerReceiptDetail を展開し、受取行と同じカード様式 (rounded-2xl + shadow-card +
// chevron) に揃えて一覧のリズムを統一する。受取/支払いは direction バッジで区別。
// 削除は per-item (removePayerReceipt) — /scan が最新 3 件に縮小されたため /history から
// 古い控えを消せるようにする。

import { useLocale, useTranslations } from 'next-intl';
import { ArrowUp, ChevronDown } from 'lucide-react';
import { PayerReceiptDetail } from './PayerReceiptDetail';
import { TokenLogo } from './AssetLogo';
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

  // tokenSymbol は表示文字列 ('JPYC'/'USDC' 等)。jpyc/usdc のときだけ公式ロゴを出す。
  const sym = receipt.tokenSymbol?.toLowerCase();
  const tokenSlug = sym === 'jpyc' || sym === 'usdc' ? sym : null;

  return (
    <li className="list-none">
      <details className="group overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-card transition-shadow open:shadow-card-hover">
        <summary className="flex cursor-pointer list-none items-center gap-3 p-4 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0 flex-1">
            {/* メタ行: 支払いバッジ + 状態ドット / 右に日時 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                {t('directionOutBadge')}
              </span>
              <span
                aria-hidden
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[receipt.status]}`}
              />
              <time className="ml-auto shrink-0 font-mono text-[11px] text-slate-500">
                {formatReceiptDateTime(receipt.paidAt ?? receipt.createdAt, locale)}
              </time>
            </div>

            {/* 金額行: 方向矢印 + token + 大きな金額。矢印は装飾 (方向は上の
                支払いバッジが伝達済み)・支払い=↑ を badge と同じ amber で。 */}
            <div className="mt-2 flex items-center gap-2">
              <ArrowUp
                className="h-5 w-5 shrink-0 text-amber-600"
                strokeWidth={2.5}
                aria-hidden
              />
              {tokenSlug && (
                <TokenLogo
                  symbol={tokenSlug}
                  size={22}
                  className="h-[22px] w-[22px] shrink-0"
                />
              )}
              <span className="text-2xl font-bold text-slate-900">
                {receipt.totalAmount ?? receipt.amount} {receipt.currency}
              </span>
            </div>

            {/* 店舗名 */}
            <p className="mt-1 truncate text-sm font-medium text-slate-600">
              {receipt.merchantName || tp('merchantFallback')}
            </p>
          </div>
          <ChevronDown
            className="h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <div className="border-t border-slate-100 px-4 pb-4 pt-3">
          <PayerReceiptDetail receipt={receipt} onRemove={handleRemove} />
        </div>
      </details>
    </li>
  );
}
