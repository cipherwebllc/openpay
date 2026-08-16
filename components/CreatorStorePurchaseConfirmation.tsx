'use client';

// Hosted デジタル商品の「署名直前」の最終確認画面。決済 hook から検証済みの金額・
// 署名 preview と callback だけを受け取り、402 の取得や署名自体は行わない。
// 特商法 12 条の 6 に必要な表示をこの 1 component に集約し、購入導線ごとの文言欠落を防ぐ。

import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, ExternalLink, ReceiptText } from 'lucide-react';
import { SignReassurance } from '@/components/SignReassurance';
import type { JpycRecoverSignPreview } from '@/lib/signPreview';

type CreatorStorePurchaseConfirmationCommonProps = {
  product: {
    title: string;
    description?: string;
  };
  sellerDisclosureHref: string;
  supportHref: string;
  isSubmitting: boolean;
  onBack: () => void;
  onConfirm: () => void;
};

export type CreatorStorePurchaseConfirmationProps =
  CreatorStorePurchaseConfirmationCommonProps &
    (
      | {
          rail?: 'jpyc';
          /** 402 の merchantValue と一致する、人間可読の JPYC 額。 */
          priceJpyc: string;
          /** 402 の feeValue と一致する、買い手負担 x402 手数料の JPYC 額。 */
          feeJpyc: string;
          /** priceJpyc + feeJpyc。検証済み値をそのまま表示する。 */
          totalJpyc: string;
          /** Hosted JPYC は買い手上乗せ。wallet wire と同じ値から作った preview。 */
          signPreview: JpycRecoverSignPreview & { gasMode: 'customer' };
        }
      | {
          rail: 'usdc';
          priceJpyc: string;
          paidUsdc: string;
          merchant: string;
          quoteRate: string;
          quoteFetchedAt: number;
          quoteExpiresAt: number;
        }
    );

export function CreatorStorePurchaseConfirmation(
  props: CreatorStorePurchaseConfirmationProps,
) {
  const t = useTranslations('CreatorStorePurchase');
  const locale = useLocale();
  const {
    product,
    priceJpyc,
    sellerDisclosureHref,
    supportHref,
    isSubmitting,
    onBack,
    onConfirm,
  } = props;
  const isUsdc = props.rail === 'usdc';
  const quoteDate = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });

  return (
    <section
      aria-labelledby="creator-store-purchase-confirmation-heading"
      className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-card"
    >
      <div className="border-b border-slate-100 bg-gradient-to-br from-blue-50 via-white to-amber-50 px-5 py-6 sm:px-7">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-brand">
          <ReceiptText className="h-4 w-4" aria-hidden />
          {t('eyebrow')}
        </p>
        <h2
          id="creator-store-purchase-confirmation-heading"
          className="mt-2 text-xl font-bold text-slate-900"
        >
          {t('heading')}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {t('intro')}
        </p>
      </div>

      <div className="space-y-6 px-5 py-6 sm:px-7">
        <section aria-labelledby="creator-store-purchase-product-heading">
          <h3
            id="creator-store-purchase-product-heading"
            className="text-sm font-bold text-slate-900"
          >
            {t('productHeading')}
          </h3>
          <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="font-bold text-slate-900">{product.title}</p>
            {product.description ? (
              <p className="mt-1 text-sm leading-relaxed text-slate-600">
                {product.description}
              </p>
            ) : null}
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              {t('quantity', { title: product.title })}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {t('redownload')}
            </p>
          </div>
        </section>

        <section aria-labelledby="creator-store-purchase-price-heading">
          <div className="flex items-center justify-between gap-2">
            <h3
              id="creator-store-purchase-price-heading"
              className="text-sm font-bold text-slate-900"
            >
              {t('priceHeading')}
            </h3>
            {/* 支払いチェーンの明示 (2026-07-30 user 要望)。a11y 名は可視テキストから (掟 8)。 */}
            <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
              {/* public の固定 SVG は寸法を CSS で固定した装飾アイコン。画像最適化対象外。 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={isUsdc ? '/chains/base.svg' : '/chains/polygon.svg'}
                alt=""
                aria-hidden
                className="h-3.5 w-3.5"
              />
              {isUsdc ? t('usdcChainBadge') : 'JPYC · Polygon'}
            </span>
          </div>
          <dl className="mt-2 overflow-hidden rounded-2xl border border-slate-200">
            <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <dt className="text-slate-600">{t('priceLabel')}</dt>
              <dd className="font-semibold tabular-nums text-slate-900">
                {priceJpyc} JPYC
              </dd>
            </div>
            {isUsdc ? (
              <div className="flex items-start justify-between gap-4 border-t border-slate-100 px-4 py-3 text-sm">
                <dt className="text-slate-600">
                  {t('feeLabel')}
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {t('usdcFeeRule')}
                  </span>
                </dt>
                <dd className="shrink-0 font-semibold tabular-nums text-slate-900">
                  0 USDC
                </dd>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-4 border-t border-slate-100 px-4 py-3 text-sm">
                <dt className="text-slate-600">
                  {t('feeLabel')}
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {t('feeRule')}
                  </span>
                </dt>
                <dd className="shrink-0 font-semibold tabular-nums text-slate-900">
                  {props.feeJpyc} JPYC
                </dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-4 border-t border-slate-200 bg-blue-50 px-4 py-3">
              <dt className="font-bold text-slate-900">
                {isUsdc ? t('usdcTotalLabel') : t('totalLabel')}
              </dt>
              <dd className="text-lg font-black tabular-nums text-brand-dark">
                {isUsdc ? `${props.paidUsdc} USDC` : `${props.totalJpyc} JPYC`}
              </dd>
            </div>
          </dl>
          {isUsdc ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600 ring-1 ring-slate-200/70">
              <dt>{t('quoteRateLabel')}</dt>
              <dd className="text-right font-semibold tabular-nums text-slate-800">
                {t('quoteRateValue', { rate: props.quoteRate })}
              </dd>
              <dt>{t('quoteFetchedLabel')}</dt>
              <dd className="text-right font-semibold text-slate-800">
                {quoteDate.format(props.quoteFetchedAt)}
              </dd>
              <dt>{t('quoteExpiryLabel')}</dt>
              <dd className="text-right font-semibold text-slate-800">
                {quoteDate.format(props.quoteExpiresAt)}
              </dd>
              <dt>{t('quoteRoundingLabel')}</dt>
              <dd className="text-right font-semibold text-slate-800">
                {t('quoteRoundingCeil')}
              </dd>
            </dl>
          ) : null}
        </section>

        <section aria-labelledby="creator-store-purchase-terms-heading">
          <h3
            id="creator-store-purchase-terms-heading"
            className="text-sm font-bold text-slate-900"
          >
            {t('termsHeading')}
          </h3>
          <dl className="mt-2 divide-y divide-slate-100 rounded-2xl border border-slate-200 px-4">
            <div className="py-3">
              <dt className="text-xs font-bold text-slate-500">
                {t('paymentTimingLabel')}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">
                {isUsdc
                  ? t('usdcPaymentTimingValue')
                  : t('paymentTimingValue')}
              </dd>
            </div>
            <div className="py-3">
              <dt className="text-xs font-bold text-slate-500">
                {t('deliveryTimingLabel')}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">
                {t('deliveryTimingValue')}
              </dd>
            </div>
            <div className="py-3">
              <dt className="text-xs font-bold text-slate-500">
                {t('cancellationLabel')}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">
                {t('cancellationValue')}
              </dd>
            </div>
            <div className="py-3">
              <dt className="text-xs font-bold text-slate-500">
                {t('licenseLabel')}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">
                {t('licenseValue')}
              </dd>
            </div>
            <div className="py-3">
              <dt className="text-xs font-bold text-slate-500">
                {t('availabilityLabel')}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">
                {t('availabilityValue')}
              </dd>
            </div>
          </dl>
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          <a
            href={sellerDisclosureHref}
            className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-brand/40 hover:text-brand"
          >
            <span>
              <span className="block text-xs font-medium text-slate-500">
                {t('sellerInfoLabel')}
              </span>
              {t('sellerInfoLink')}
            </span>
            <ExternalLink className="h-4 w-4 shrink-0" aria-hidden />
          </a>
          <a
            href={supportHref}
            className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-brand/40 hover:text-brand"
          >
            <span>
              <span className="block text-xs font-medium text-slate-500">
                {t('supportLabel')}
              </span>
              {t('supportLink')}
            </span>
            <ExternalLink className="h-4 w-4 shrink-0" aria-hidden />
          </a>
        </div>
        <p className="-mt-3 text-xs leading-relaxed text-slate-500">
          {t('supportNote')}
        </p>

        {isUsdc ? (
          <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
            <h3 className="font-bold">{t('usdcSignatureHeading')}</h3>
            <p className="mt-1 leading-relaxed">
              {t('usdcSignatureBody', { amount: props.paidUsdc })}
            </p>
            <p className="mt-2 break-all text-xs text-blue-800">
              {t('usdcRecipient', { merchant: props.merchant })}
            </p>
          </section>
        ) : (
          <SignReassurance
            kind="jpyc-relay-recover"
            preview={props.signPreview}
            awaiting={isSubmitting}
          />
        )}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={onBack}
            disabled={isSubmitting}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {t('back')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            className="min-h-11 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white shadow-sm transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? t('confirming') : t('confirm')}
          </button>
        </div>
      </div>
    </section>
  );
}
