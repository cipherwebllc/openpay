'use client';

// 顧客向け「電子レシート / 支払い控え」1 枚の詳細表示 + アクション
// (コピー / 印刷 / JSON 保存 / CSV 保存)。/scan の一覧と各決済フォームの完了画面で共用。
//
// 正式な領収書・税務証憑ではない (末尾に免責)。サーバ送信なし・LocalStorage の控えを描画するだけ。

import { useRef } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { addressExplorerUrl } from '@/lib/chains';
import { downloadBlob } from '@/lib/download';
import { shortAddress } from '@/lib/format';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import {
  formatReceiptDateTime,
  payerReceiptCopyText,
  payerReceiptCsv,
  payerReceiptCsvFilename,
  payerReceiptHasTax,
  payerReceiptJsonFilename,
  payerReceiptToJson,
  type PayerReceipt,
  type PayerReceiptStatus,
} from '@/lib/payerReceipt';

const STATUS_BADGE_CLASS = {
  confirmed: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  pending: 'bg-sky-100 text-sky-800 ring-sky-200',
  failed: 'bg-red-100 text-red-800 ring-red-200',
  unknown: 'bg-slate-100 text-slate-600 ring-slate-200',
} as const satisfies Record<PayerReceiptStatus, string>;

const STATUS_I18N_KEY = {
  confirmed: 'statusConfirmed',
  pending: 'statusPending',
  failed: 'statusFailed',
  unknown: 'statusUnknown',
} as const satisfies Record<PayerReceiptStatus, string>;

const ACTION_BTN_CLASS =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark';

export function PayerReceiptDetail({
  receipt,
  onRemove,
}: {
  receipt: PayerReceipt;
  /** 指定時は「削除」アクションを描画 (/scan の管理用)。完了画面では渡さない。 */
  onRemove?: (receiptId: string) => void;
}) {
  const t = useTranslations('PayerReceipt');
  // 異通貨建ての元価格行は PaymentForm の fxAnchorLine/fxRateLine を再利用 (文言を一元化・HistoryRow と同様)。
  const tp = useTranslations('PaymentForm');
  const locale = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const { copy, copied, available: copyAvailable } = useCopyToClipboard();

  const items = receipt.lineItems ?? [];
  const currency = receipt.currency;
  const hasTax = payerReceiptHasTax(receipt);
  const payerExplorerUrl =
    receipt.payerAddress != null && receipt.chainId != null
      ? addressExplorerUrl(receipt.chainId, receipt.payerAddress)
      : undefined;

  function handlePrint() {
    const el = rootRef.current;
    if (!el) return;
    // 前回 afterprint が発火しなかった場合 (一部ブラウザ) に備え、残留マーカーを掃除して
    // から対象を 1 件だけに設定する。残ると次回印刷で複数レシートが紙面に出てしまう。
    document
      .querySelectorAll('[data-receipt-printing]')
      .forEach((n) => n.removeAttribute('data-receipt-printing'));
    el.setAttribute('data-receipt-printing', '');
    document.body.classList.add('openpay-printing-receipt');
    const cleanup = () => {
      el.removeAttribute('data-receipt-printing');
      document.body.classList.remove('openpay-printing-receipt');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  }

  function handleSaveJson() {
    downloadBlob(
      new Blob([payerReceiptToJson(receipt)], { type: 'application/json;charset=utf-8' }),
      payerReceiptJsonFilename(receipt),
    );
  }

  function handleSaveCsv() {
    downloadBlob(
      new Blob([payerReceiptCsv(receipt)], { type: 'text/csv;charset=utf-8' }),
      payerReceiptCsvFilename(receipt),
    );
  }

  return (
    <div
      ref={rootRef}
      className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          {t('detailTitle')}
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${STATUS_BADGE_CLASS[receipt.status]}`}
        >
          {t(STATUS_I18N_KEY[receipt.status])}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
        {receipt.receiptNo && (
          <div>
            <dt className="text-slate-400">{t('receiptNoLabel')}</dt>
            <dd className="font-mono break-all">{receipt.receiptNo}</dd>
          </div>
        )}
        <div>
          <dt className="text-slate-400">{t('paidAtLabel')}</dt>
          <dd>{formatReceiptDateTime(receipt.paidAt ?? receipt.createdAt, locale)}</dd>
        </div>
        {receipt.merchantName && (
          <div>
            <dt className="text-slate-400">{t('merchantLabel')}</dt>
            <dd className="break-words">{receipt.merchantName}</dd>
          </div>
        )}
        <div>
          <dt className="text-slate-400">{t('merchantWalletLabel')}</dt>
          <dd className="font-mono">{shortAddress(receipt.merchantAddress)}</dd>
        </div>
        {receipt.payerAddress && (
          <div>
            <dt className="text-slate-400">{t('payerWalletLabel')}</dt>
            <dd className="font-mono">
              {payerExplorerUrl ? (
                <a
                  href={payerExplorerUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2 hover:text-slate-900"
                >
                  {shortAddress(receipt.payerAddress)}
                </a>
              ) : (
                shortAddress(receipt.payerAddress)
              )}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-slate-400">{t('currencyLabel')}</dt>
          <dd>
            {currency}
            {receipt.chainName ? ` / ${receipt.chainName}` : ''}
          </dd>
        </div>
      </dl>

      {/* 商品明細 (lineItems)。builder の仮想 1 行で常に 1 行以上は出る。 */}
      {items.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-slate-400">{t('lineItemsLabel')}</p>
          <ul className="mt-1 space-y-1">
            {items.map((li, i) => (
              <li
                key={li.id ?? `${li.name}-${i}`}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-1 last:border-b-0"
              >
                <span className="break-words">
                  {li.name}{' '}
                  <span className="text-slate-400">×{li.quantity}</span>
                  {li.taxRate != null && li.taxRate > 0 && (
                    <span className="ml-1 text-slate-400">{li.taxRate}%</span>
                  )}
                </span>
                <span className="font-mono text-slate-700">
                  @{li.unitPrice} = {li.amount} {currency}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 合計欄。税額が計上されているときだけ小計/消費税を併記 (0 のときは合計のみ)。 */}
      <dl className="mt-3 space-y-0.5 text-xs">
        {hasTax && (
          <>
            {receipt.subtotalAmount && (
              <div className="flex justify-between">
                <dt className="text-slate-400">{t('subtotalLabel')}</dt>
                <dd className="font-mono">
                  {receipt.subtotalAmount} {currency}
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate-400">{t('taxLabel')}</dt>
              <dd className="font-mono">
                {receipt.totalTaxAmount} {currency}
              </dd>
            </div>
          </>
        )}
        <div className="flex justify-between text-sm font-semibold text-slate-900">
          <dt>{t('totalLabel')}</dt>
          <dd className="font-mono">
            {receipt.totalAmount ?? receipt.amount} {currency}
          </dd>
        </div>
      </dl>

      {/* 異通貨建て: 顧客が QR で見た元価格 (請求建て) を併記。settled 金額が実支払額。 */}
      {receipt.anchorAmount && receipt.anchorSymbol && (
        <div className="mt-2 text-xs">
          <p className="text-slate-400">{t('anchorLabel')}</p>
          <p className="break-words text-slate-600">
            {tp('fxAnchorLine', {
              refAmt: receipt.anchorAmount,
              anchorSymbol: receipt.anchorSymbol,
              amount: receipt.totalAmount ?? receipt.amount,
              symbol: currency,
            })}
            {receipt.fxRate && ` ・ ${tp('fxRateLine', { rate: receipt.fxRate })}`}
          </p>
        </div>
      )}

      {receipt.txHash && (
        <div className="mt-3 text-xs">
          <p className="text-slate-400">{t('txHashLabel')}</p>
          <p className="break-all font-mono text-slate-600">{receipt.txHash}</p>
        </div>
      )}
      {receipt.memo && (
        <div className="mt-2 text-xs">
          <p className="text-slate-400">{t('memoLabel')}</p>
          <p className="break-words text-slate-600">{receipt.memo}</p>
        </div>
      )}

      {receipt.explorerUrl && (
        <a
          href={receipt.explorerUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-block text-xs text-brand underline underline-offset-2 hover:opacity-80"
        >
          {t('explorerLink')}
        </a>
      )}

      {/* アクション (印刷時は隠す)。 */}
      <div className="mt-4 flex flex-wrap gap-2 print:hidden">
        {copyAvailable && (
          <button
            type="button"
            onClick={() => copy(payerReceiptCopyText(receipt, locale))}
            className={ACTION_BTN_CLASS}
          >
            {copied ? t('copiedButton') : t('copyButton')}
          </button>
        )}
        <button type="button" onClick={handlePrint} className={ACTION_BTN_CLASS}>
          {t('printButton')}
        </button>
        <button type="button" onClick={handleSaveJson} className={ACTION_BTN_CLASS}>
          {t('saveJsonButton')}
        </button>
        <button type="button" onClick={handleSaveCsv} className={ACTION_BTN_CLASS}>
          {t('saveCsvButton')}
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(receipt.receiptId)}
            className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
          >
            {t('removeButton')}
          </button>
        )}
      </div>

      {/* 免責: 正式な領収書/税務証憑ではない。 */}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        {t('disclaimer')}
      </p>

      {/* 成長ループ CTA: 支払った顧客 = 将来の店主候補への控えめな導線。
          印刷時は広告を紙に載せないため print:hidden。
          onRemove あり (= /scan 管理一覧) では各カードに繰り返し出るため非表示にし、
          完了画面 (onRemove なし) でのみ表示してノイズを最小化する。 */}
      {!onRemove && (
        <div className="mt-3 border-t border-slate-100 pt-3 print:hidden">
          <p className="text-xs text-slate-400">{t('ctaText')}</p>
          <Link
            href={`/${locale}`}
            className="text-xs text-brand underline underline-offset-2 hover:opacity-80"
          >
            {t('ctaLink')}
          </Link>
        </div>
      )}
    </div>
  );
}
