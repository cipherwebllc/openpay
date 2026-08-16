'use client';

// 決済状態と access 状態を別々に見せる表示専用 component。hook が返す二軸の状態を受け、
// own/content API の read-back が成功する前には「購入完了」とライブラリ導線を絶対に出さない。

import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { formatUnits } from 'viem';
import type { HostedUsdcPaymentSnapshot } from '@/lib/x402/hostedUsdcPurchaseWire';

export type CreatorStorePaymentStatus =
  | 'not-started'
  | 'not-executed'
  | 'unknown'
  | 'confirmed';

export type CreatorStoreAccessStatus =
  | 'none'
  | 'provisioning'
  | 'ready'
  | 'needs-support';

export type CreatorStorePurchaseStateProps = {
  paymentStatus: CreatorStorePaymentStatus;
  accessStatus: CreatorStoreAccessStatus;
  /** content API 200 により ownership と購入 revision を read-back 済みのときだけ true。 */
  ownershipReadBack: boolean;
  libraryHref: string;
  supportHref: string;
  /** USDC 成立時は P1 grant と同じ versioned payment snapshot を描画する。 */
  payment?: HostedUsdcPaymentSnapshot;
};

export function CreatorStorePurchaseState({
  paymentStatus,
  accessStatus,
  ownershipReadBack,
  libraryHref,
  supportHref,
  payment,
}: CreatorStorePurchaseStateProps) {
  const t = useTranslations('CreatorStorePurchase');
  const locale = useLocale();
  const paymentDate = payment
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      })
    : null;
  if (paymentStatus === 'not-started' && accessStatus === 'none') return null;

  const ready =
    paymentStatus === 'confirmed' &&
    accessStatus === 'ready' &&
    ownershipReadBack;
  const failedPrebroadcast = paymentStatus === 'not-executed';
  const needsSupport = accessStatus === 'needs-support';
  const confirmedProvisioning =
    paymentStatus === 'confirmed' && !ready && !needsSupport;
  // hook の遷移競合や描画順で access=ready が先に見えても、authoritative read-back が
  // 完了するまでは ready 表示へ波及させず provisioning に留める。
  const displayedAccessStatus =
    accessStatus === 'ready' && !ownershipReadBack
      ? 'provisioning'
      : accessStatus;

  let tone =
    'border-amber-200 bg-amber-50 text-amber-950';
  let icon = <Loader2 className="h-5 w-5 animate-spin" aria-hidden />;
  let title = t('pendingTitle');
  let body = t('pendingBody');

  if (ready) {
    tone = 'border-emerald-200 bg-emerald-50 text-emerald-950';
    icon = <CheckCircle2 className="h-5 w-5" aria-hidden />;
    title = t('completeTitle');
    body = t('completeBody');
  } else if (failedPrebroadcast) {
    tone = 'border-slate-200 bg-slate-50 text-slate-900';
    icon = <AlertTriangle className="h-5 w-5 text-slate-500" aria-hidden />;
    title = t('notExecutedTitle');
    body = t('notExecutedBody');
  } else if (needsSupport) {
    tone = 'border-red-200 bg-red-50 text-red-950';
    icon = <AlertTriangle className="h-5 w-5 text-red-600" aria-hidden />;
    title = t('needsSupportTitle');
    body =
      paymentStatus === 'confirmed'
        ? t('needsSupportConfirmedBody')
        : t('needsSupportUnknownBody');
  } else if (confirmedProvisioning) {
    title = t('provisioningTitle');
    body = t('provisioningBody');
  }

  return (
    <section
      role="status"
      aria-live="polite"
      className={`rounded-2xl border p-5 ${tone}`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed">{body}</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="opacity-70">{t('paymentStateLabel')}</dt>
            <dd className="font-semibold">{t(`paymentStates.${paymentStatus}`)}</dd>
            <dt className="opacity-70">{t('accessStateLabel')}</dt>
            <dd className="font-semibold">
              {t(
                `accessStates.${
                  ready
                    ? 'ready'
                    : confirmedProvisioning
                      ? 'provisioning'
                      : displayedAccessStatus
                }`,
              )}
            </dd>
          </dl>
          {payment ? (
            <div className="mt-4 rounded-xl bg-white/70 p-3 ring-1 ring-current/10">
              <p className="text-xs font-bold uppercase tracking-wide opacity-70">
                {t('paymentSnapshotHeading')}
              </p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="opacity-70">{t('paidAmountLabel')}</dt>
                <dd className="text-right font-semibold tabular-nums">
                  {formatUnits(BigInt(payment.paidAtomic), 6)} USDC
                </dd>
                <dt className="opacity-70">{t('productPriceLabel')}</dt>
                <dd className="text-right font-semibold tabular-nums">
                  {payment.priceJpyc} JPYC
                </dd>
                <dt className="opacity-70">{t('paymentRailLabel')}</dt>
                <dd className="text-right font-semibold">
                  USDC · Base (8453)
                </dd>
                <dt className="opacity-70">{t('quoteRateLabel')}</dt>
                <dd className="text-right font-semibold tabular-nums">
                  {t('quoteRateValue', {
                    rate: formatUnits(BigInt(payment.quote.rateScaled), 6),
                  })}
                </dd>
                <dt className="opacity-70">{t('quoteFetchedLabel')}</dt>
                <dd className="text-right font-semibold">
                  {paymentDate?.format(payment.quote.rateFetchedAt)}
                </dd>
                <dt className="opacity-70">{t('quoteExpiryLabel')}</dt>
                <dd className="text-right font-semibold">
                  {paymentDate?.format(payment.quote.fxQuoteExpiresAt)}
                </dd>
                <dt className="opacity-70">{t('quoteRoundingLabel')}</dt>
                <dd className="text-right font-semibold">
                  {t('quoteRoundingCeil')}
                </dd>
              </dl>
            </div>
          ) : null}
          {ready ? (
            <a
              href={libraryHref}
              className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-800"
            >
              {t('openLibrary')}
            </a>
          ) : needsSupport ? (
            <a
              href={supportHref}
              className="mt-4 inline-flex min-h-10 items-center rounded-lg border border-current px-4 py-2 text-sm font-bold"
            >
              {t('contactSupport')}
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
