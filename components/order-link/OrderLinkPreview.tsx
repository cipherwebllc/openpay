'use client';

// お客様の画面の見本と、リンクの操作。PC は入力の右に sticky で置く。
// 上はお客様に見える部分 (明細と合計)、色を変えた下はお店だけの部分 (操作・入金の確かめ方・利用料)。
// いくら届いたら発送するかはリンクが出ている間いつも見せ、残りは「詳しい注意」の開閉に畳む。

import Link from 'next/link';
import { AlertTriangle, Check, ChevronDown, Copy, ExternalLink, Send } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits, parseUnits } from 'viem';
import { groupAmountDigits } from '@/lib/amount';
import { chainForSlug } from '@/lib/chains';
import type { OrderLinkPreviewLine, OrderLinkResult } from '@/lib/orderLink';

const TEXT_ACTION = 'h-11 items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-dark';
const PRIMARY_ACTION =
  'hidden h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand text-base font-bold text-white hover:bg-brand-dark lg:inline-flex';

export function OrderLinkPreview({
  result,
  orderId,
  reusable,
  chainNames,
  storeName,
  description,
  lines,
  discount,
  tax,
  message,
  messageIsError,
  sentLabel,
  standardPayment,
  canCopy,
  showUrl,
  canShare,
  onCopy,
  onShare,
  onManualCopy,
  onNextOrder,
  onSwitchToStandard,
}: {
  result: OrderLinkResult;
  orderId: string;
  /** 番号なしで何度でも使えるリンク (お客様は払った後に注文を送る)。 */
  reusable: boolean;
  /** お客様が選べるチェーンの名前 (2 つ以上のときだけ・「Polygon / Kaia」)。 */
  chainNames: string | null;
  /** お客様の画面の頭に出る店名 (空なら出さない・/checkout と同じ)。 */
  storeName: string;
  description: string;
  lines: readonly OrderLinkPreviewLine[];
  /** 値引き (JPYC の 10 進・使える値引きがあるときだけ)。お客様の画面と同じく 小計 / 値引き / 合計 の順に出す。 */
  discount: string | null;
  /** うち消費税 (JPYC の 10 進・消費税を入れるリンクだけ)。合計の下に出す (レジと同じ・内税の目安)。 */
  tax: string | null;
  /** リンクができていないときの 1 文。 */
  message: string | null;
  /** 入力を直さないと進めない理由か (入力の途中なら false)。 */
  messageIsError: boolean;
  /** 表示中のリンクをコピーか共有した直後の状態の文字。書き換えると消える。 */
  sentLabel: string | null;
  /** この注文を通常決済で作っている (お客様にガス代が要る)。 */
  standardPayment: boolean;
  canCopy: boolean;
  /** コピーできない環境やコピーに失敗したときは、リンクを文字で見せる。 */
  showUrl: boolean;
  canShare: boolean;
  onCopy: () => void;
  onShare: () => void;
  /** リンクの欄から手でコピーした。 */
  onManualCopy: () => void;
  onNextOrder: () => void;
  /** 通常決済に切り替えれば作れるときだけ渡す。 */
  onSwitchToStandard: (() => void) | null;
}) {
  const t = useTranslations('OrderLinkBuilder');
  const locale = useLocale();
  const justSent = sentLabel !== null;
  const status = sentLabel ?? (result.ok ? t('ready') : null);
  return (
    <section
      aria-labelledby="order-link-preview-heading"
      className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <h2 id="order-link-preview-heading" className="text-sm font-semibold text-slate-800">
          {t('previewTitle')}
        </h2>
        {status && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {status}
          </span>
        )}
      </div>

      <div className="px-5 py-4">
        {storeName.trim() && <p className="break-words text-base font-bold text-slate-900">{storeName.trim()}</p>}
        {reusable ? (
          <p className="text-xs text-slate-500">{t('previewReusable')}</p>
        ) : (
          orderId && <p className="text-xs tabular-nums text-slate-500">{t('previewOrder', { id: orderId })}</p>
        )}
        {description.trim() && <p className="mt-1 break-words text-sm text-slate-600">{description.trim()}</p>}

        {lines.length > 0 ? (
          <ul className="mt-3 space-y-1.5 text-sm">
            {lines.map((line, index) => (
              <li key={index} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 break-words text-slate-700">
                  {line.name}
                  {line.qty > 1 && <span className="ml-1 tabular-nums text-slate-500">×{line.qty}</span>}
                </span>
                <span className="shrink-0 tabular-nums text-slate-900">{groupAmountDigits(line.amount)} JPYC</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-500">{message}</p>
        )}

        {/* 値引きがあれば、合計 (= お客様が払う額・値引き後) の上に小計と値引きを出す (/checkout の明細と同じ並び)。 */}
        {result.total !== undefined && discount !== null && (
          <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-slate-500">{t('previewSubtotal')}</dt>
              <dd className="tabular-nums text-slate-900">
                {groupAmountDigits(formatUnits(parseUnits(result.total, 18) + parseUnits(discount, 18), 18))} JPYC
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-slate-500">{t('previewDiscount')}</dt>
              <dd className="tabular-nums text-rose-700">−{groupAmountDigits(discount)} JPYC</dd>
            </div>
          </dl>
        )}

        {/* 止まっている間も合計は見せる (いくら超えたかが分かるように)。 */}
        {result.total !== undefined && (
          <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-slate-100 pt-3">
            <span className="text-sm font-semibold text-slate-800">{t('total')}</span>
            <span className="text-xl font-bold tabular-nums text-slate-900">
              {groupAmountDigits(result.total)} JPYC
            </span>
          </div>
        )}
        {tax !== null && (
          <p className="mt-1 text-right text-xs tabular-nums text-slate-600">
            {t('previewTax', { amount: groupAmountDigits(tax) })}
          </p>
        )}

        {chainNames && lines.length > 0 && (
          <p className="mt-3 text-xs text-slate-600">{t('previewChains', { chains: chainNames })}</p>
        )}

        {reusable && lines.length > 0 && (
          <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-900">{t('previewAfterPay')}</p>
        )}

        {lines.length > 0 && !result.ok && message && (
          <p className={`mt-3 text-sm ${messageIsError ? 'text-rose-700' : 'text-slate-600'}`}>
            {message}
          </p>
        )}
        {onSwitchToStandard && (
          <button type="button" onClick={onSwitchToStandard} className={`inline-flex ${TEXT_ACTION}`}>
            {t('switchToStandard')}
          </button>
        )}
      </div>

      {result.ok && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50 px-5 py-4">
          <p className="text-xs font-semibold text-slate-500">{t('storeOnly')}</p>
          {/* スマホの主ボタンは下部の固定バー。ここに同じボタンを重ねない。 */}
          {justSent ? (
            <button type="button" onClick={onNextOrder} className={PRIMARY_ACTION}>
              {t('nextOrder')}
            </button>
          ) : (
            canCopy && (
              <button type="button" onClick={onCopy} className={PRIMARY_ACTION}>
                <Copy className="h-5 w-5" aria-hidden />
                {t('copy')}
              </button>
            )
          )}
          {showUrl && (
            <div>
              <label htmlFor="order-link-url" className="mb-1 block text-xs font-medium text-slate-600">
                {t('linkLabel')}
              </label>
              {/* 固定バーの下に隠れないよう、focus で動くときの余白を取る。 */}
              <input
                id="order-link-url"
                readOnly
                value={result.url}
                onFocus={(event) => event.target.select()}
                onCopy={onManualCopy}
                className="h-11 w-full scroll-mb-44 rounded-xl bg-white px-3 font-mono text-xs text-slate-700 ring-1 ring-slate-200"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
            {canCopy && (justSent || canShare) && (
              <button
                type="button"
                onClick={onCopy}
                className={`inline-flex ${TEXT_ACTION} ${justSent ? '' : 'lg:hidden'}`}
              >
                <Copy className="h-4 w-4" aria-hidden />
                {t('copy')}
              </button>
            )}
            {canShare && (
              <button
                type="button"
                onClick={onShare}
                className={`${TEXT_ACTION} ${justSent ? 'inline-flex' : 'hidden lg:inline-flex'}`}
              >
                <Send className="h-4 w-4" aria-hidden />
                {t('share')}
              </button>
            )}
            <a href={result.url} target="_blank" rel="noopener noreferrer" className={`inline-flex ${TEXT_ACTION}`}>
              <ExternalLink className="h-4 w-4" aria-hidden />
              {t('open')}
            </a>
          </div>
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-600" aria-hidden />
            <div className="min-w-0">
              {/* 届く額はチェーンで違うことがある (利用料の最低額)。違えばチェーンごとに出す。 */}
              {result.byChain.every((entry) => entry.receive === result.receive) ? (
                <p className="text-sm font-semibold text-slate-800">
                  {t('cautionTitle', { amount: groupAmountDigits(result.receive) })}
                </p>
              ) : (
                <>
                  <p className="text-sm font-semibold text-slate-800">{t('cautionTitleVaries')}</p>
                  <ul className="mt-0.5 text-sm font-semibold text-slate-800">
                    {result.byChain.map((entry) => (
                      <li key={entry.chain}>
                        {t('cautionChainAmount', {
                          chain: chainForSlug(entry.chain).name,
                          amount: groupAmountDigits(entry.receive),
                        })}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-slate-600">
                {result.fee !== '0' && result.byChain.every((entry) => entry.fee === result.fee) && (
                  <li>
                    {t('cautionFee', { fee: groupAmountDigits(result.fee), total: groupAmountDigits(result.total) })}
                  </li>
                )}
                {standardPayment && <li>{t('cautionStandard')}</li>}
                <li>{t('cautionEditable')}</li>
                <li>{t('cautionHistory')}</li>
                <li>{t('cautionTxHash')}</li>
                <li>{t('cautionSignature')}</li>
              </ul>
            </div>
          </div>
          <details className="group">
            <summary className="flex h-11 cursor-pointer list-none items-center justify-between text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
              {t('checksTitle')}
              <ChevronDown
                className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden
              />
            </summary>
            <ul className="list-disc space-y-1.5 pb-1 pl-4 text-xs leading-relaxed text-slate-600">
              {!reusable && <li>{t('checkNumber')}</li>}
              <li>{t('checkExpiry')}</li>
              <li>{t('checkPrivacy')}</li>
              <li>{t('sellerDuty')}</li>
            </ul>
            <Link
              href={`/${locale}/pricing`}
              prefetch={false}
              className="inline-flex h-11 items-center text-xs font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
            >
              {t('pricingLink')}
            </Link>
          </details>
        </div>
      )}
    </section>
  );
}
