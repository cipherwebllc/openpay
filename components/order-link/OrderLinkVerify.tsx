'use client';

// 入金を確かめる: お客様から届いた Tx Hash (届いた文ごと貼ってよい) で、受取ウォレットに届いた額をチェーンから読む。
// 注文の画面を閉じた後の注文も確かめられるよう、いつも出す。OpenPay のサーバーには送らない (lib/orderLinkVerify.ts)。

import { useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react';
import type { Address } from 'viem';
import { groupAmountDigits } from '@/lib/amount';
import { chainForSlug, txExplorerUrl, type ChainSlug } from '@/lib/chains';
import { shortAddress } from '@/lib/format';
import { checkOrderLinkPayment, extractTxHash, type OrderLinkPaymentCheck } from '@/lib/orderLinkVerify';
import { ORDER_LINK_INPUT_CLASS } from './OrderLinkAmountField';

type Done = { result: OrderLinkPaymentCheck; hash: string | null; chain: ChainSlug; receiver: Address };

export function OrderLinkVerify({ chain, receiver }: { chain: ChainSlug; receiver: Address | null }) {
  const t = useTranslations('OrderLinkBuilder');
  const locale = useLocale();
  const inputId = useId();
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const check = async () => {
    if (!receiver || checking) return;
    setChecking(true);
    const result = await checkOrderLinkPayment({ chain, receiver, text });
    setDone({ result, hash: extractTxHash(text), chain, receiver });
    setChecking(false);
  };

  const explorerUrl = done?.hash ? txExplorerUrl(chainForSlug(done.chain).id, done.hash) : undefined;

  return (
    <section
      aria-labelledby="order-link-verify-heading"
      className="min-w-0 rounded-2xl bg-white px-5 py-4 shadow-card ring-1 ring-slate-200/70 lg:col-start-1"
    >
      <h2 id="order-link-verify-heading" className="text-sm font-semibold text-slate-800">
        {t('verifyTitle')}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('verifyLead')}</p>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void check();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {t('verifyLabel')}
        </label>
        <input
          id={inputId}
          type="text"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setDone(null);
          }}
          placeholder={t('verifyPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          className={`${ORDER_LINK_INPUT_CLASS} min-w-0 font-mono sm:flex-1`}
        />
        <button
          type="submit"
          disabled={!receiver || text.trim() === '' || checking}
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-brand px-5 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? t('verifyChecking') : t('verifyButton')}
        </button>
      </form>

      {/* 結果は読み上げる (注文リンクの画面の role="status" は送ったかどうかの 1 つに残す)。 */}
      <div aria-live="polite" className="mt-3 empty:hidden">
        {done && <VerifyResult done={done} locale={locale} />}
      </div>
      {done && explorerUrl && (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-dark"
        >
          <ExternalLink className="h-4 w-4" aria-hidden />
          {t('verifyExplorer')}
        </a>
      )}
    </section>
  );
}

function VerifyResult({ done, locale }: { done: Done; locale: string }) {
  const t = useTranslations('OrderLinkBuilder');
  const { result } = done;
  if (result.status === 'paid') {
    const time = new Date(result.timestamp * 1000).toLocaleString(locale === 'en' ? 'en-US' : 'ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <div className="flex gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-emerald-900 ring-1 ring-emerald-200">
        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
        <div className="min-w-0 text-sm">
          <p className="font-semibold">{t('verifyPaid', { amount: groupAmountDigits(result.received) })}</p>
          <p className="mt-0.5 text-xs">{t('verifyPaidMeta', { time, block: result.blockNumber.toString() })}</p>
          <p className="mt-1 text-xs leading-relaxed">{t('verifyPaidNote')}</p>
        </div>
      </div>
    );
  }
  const message =
    result.status === 'notToReceiver'
      ? t('verifyNotToReceiver', { receiver: shortAddress(done.receiver) })
      : result.status === 'notFound'
        ? t('verifyNotFound', { chain: chainForSlug(done.chain).name })
        : t(`verify.${result.status}`);
  return (
    <div className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-amber-900 ring-1 ring-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-600" aria-hidden />
      <p className="min-w-0 text-sm">{message}</p>
    </div>
  );
}
