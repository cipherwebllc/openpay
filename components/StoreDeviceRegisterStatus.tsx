'use client';

// 「お店の端末で送る」のレジ端末側の状態表示 (QR のモーダルの中と、閉じた後の会計ボタンの下)。
// 品物を渡す合図は「入金を確認しました」(送った tx の receipt にこの支払いの Settled がある) だけ。
// 送らなかった・取り消されたときは「お支払いは行われていません」と、お客様の画面を待ってから次に進む案内を出す。

import { useTranslations } from 'next-intl';
import { txExplorerUrl } from '@/lib/chains';
import type { StoreDeviceRegisterState } from '@/hooks/useStoreDeviceRegister';

const BTN =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark';

export function StoreDeviceRegisterStatus({
  state,
  chainId,
  formatAmount,
  onCheckNow,
  onRetry,
  onReissue,
  onShowNormal,
  onDismiss,
}: {
  state: StoreDeviceRegisterState;
  chainId: number;
  /** 請求額 (wei の 10 進文字列) を表示用に整える。 */
  formatAmount: (wei: string) => string;
  onCheckNow: () => void;
  /** 「もう一度送る」(無ければ出さない・レジの外では出さない)。 */
  onRetry?: () => void;
  onReissue?: () => void;
  onShowNormal?: () => void;
  onDismiss?: () => void;
}) {
  const t = useTranslations('RegisterMode.storeDevice');
  if (state.phase === 'idle') return null;

  const txLink = (hash: `0x${string}`) => {
    const href = txExplorerUrl(chainId, hash);
    return href ? (
      <a href={href} target="_blank" rel="noreferrer noopener" className="text-xs underline underline-offset-2">
        {t('viewTx')}
      </a>
    ) : null;
  };
  const previous = 'previous' in state && state.previous ? (
    <span className="mr-1 text-xs font-semibold">{t('previousLabel')}:</span>
  ) : null;
  const dismiss = onDismiss ? (
    <button type="button" className={BTN} onClick={onDismiss}>
      {t('dismiss')}
    </button>
  ) : null;

  switch (state.phase) {
    case 'creating':
      return (
        <p role="status" className="text-sm text-slate-600">
          {t('creating')}
        </p>
      );
    case 'create_failed':
      return (
        <div role="alert" className="space-y-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>{t(`createFailed.${state.reason}`)}</p>
          <div className="flex flex-wrap gap-2">
            {onShowNormal && (
              <button type="button" className={BTN} onClick={onShowNormal}>
                {t('showNormalQr')}
              </button>
            )}
            {dismiss}
          </div>
        </div>
      );
    case 'waiting':
      return (
        <div className="space-y-2 text-sm text-slate-700">
          <p role="status" className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2 w-2 flex-none animate-pulse rounded-full bg-slate-400" />
            {t('waiting')}
          </p>
          {state.stale && <p className="text-xs text-amber-800">{t('stale')}</p>}
          {state.degraded && <p className="text-xs text-amber-800">{t('degraded')}</p>}
          <div className="flex flex-wrap justify-center gap-2">
            {state.stale && onReissue && (
              <button type="button" className={BTN} onClick={onReissue}>
                {t('reissue')}
              </button>
            )}
            {state.degraded && onShowNormal && (
              <button type="button" className={BTN} onClick={onShowNormal}>
                {t('showNormalQr')}
              </button>
            )}
          </div>
        </div>
      );
    case 'expired':
      return (
        <div role="status" className="space-y-2 text-sm text-slate-700">
          <p>{t('expired')}</p>
          <div className="flex flex-wrap gap-2">
            {onReissue && (
              <button type="button" className={BTN} onClick={onReissue}>
                {t('reissue')}
              </button>
            )}
            {dismiss}
          </div>
        </div>
      );
    case 'processing':
      return (
        <p role="status" className="text-sm text-slate-700">
          {t('processing')}
        </p>
      );
    case 'rejected':
    case 'not_sent':
      return (
        <div role="alert" className="space-y-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>{state.phase === 'rejected' ? t('rejected') : t(`notSent.${state.reason}`)}</p>
          {!(state.phase === 'not_sent' && state.reason === 'used') && <p className="text-xs">{t('notPaidGuide')}</p>}
          <div className="flex flex-wrap gap-2">
            {state.phase === 'not_sent' && state.canRetry && onRetry && (
              <button type="button" className={BTN} onClick={onRetry}>
                {t('retry')}
              </button>
            )}
            {dismiss}
          </div>
        </div>
      );
    case 'sent':
      return (
        <div role="status" className="space-y-1 text-sm text-slate-700">
          <p>
            {previous}
            {t('sent')}
          </p>
          {txLink(state.mark.hash)}
        </div>
      );
    case 'received':
      return (
        <div role="status" className="space-y-1 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p className="font-semibold">
            {previous}
            {/* 前回の送信 (再読み込み後) には「品物をお渡しください」を付けない (渡し済みの会計への二重の合図にしない)。 */}
            {t(state.previous ? 'receivedPrevious' : 'received', { amount: formatAmount(state.mark.amount) })}
          </p>
          {state.finalized && <p className="text-xs">{t('finalized')}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {txLink(state.mark.hash)}
            {dismiss}
          </div>
        </div>
      );
    case 'reverted':
      return (
        <div role="alert" className="space-y-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            {previous}
            {t('reverted')}
          </p>
          <p className="text-xs">{t('notPaidGuide')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {txLink(state.mark.hash)}
            {dismiss}
          </div>
        </div>
      );
    case 'unknown':
      return (
        <div role="status" className="space-y-2 text-sm text-slate-700">
          <p>
            {previous}
            {/* 「前回の送信」(再読み込みの後) も、確かめられるまで次の QR は出せない (同じ案内)。 */}
            {t('unknown')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BTN} onClick={onCheckNow}>
              {t('checkNow')}
            </button>
            {txLink(state.mark.hash)}
            {onDismiss && (
              <button type="button" className={BTN} onClick={onDismiss}>
                {t('unknownAck')}
              </button>
            )}
          </div>
        </div>
      );
    case 'failed':
      return (
        <div role="alert" className="space-y-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            {previous}
            {t('failed')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {txLink(state.mark.hash)}
            {dismiss}
          </div>
        </div>
      );
  }
}
