'use client';

// 受け付けるチェーンが複数の注文リンク (chains・plans/order-link-multichain.md): 払う前にお客様がチェーンを選ぶ。
// 選ぶと URL に chain を足して開き直し、/checkout は選んだチェーン 1 つで今と同じ計算をする。支払いの画面の中では
// チェーンを替えないので、払っている途中に別のチェーンへ切り替わることがない (Fable の推奨)。
// このタブで前に払った記録が、どのチェーンにでもあれば先に出し、チェーンを選ばせない (同じ注文を別のチェーンで二重に
// 払わせない・Codex P1)。何度でも使えるリンクだけ「新しい注文として払う」で選べるようにする。

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChainLogo } from '@/components/AssetLogo';
import { isRemoteOrderCheckout, NotifyShopButton, type NotifyShopData } from '@/components/NotifyShopButton';
import { blockExplorerUrl, chainForSlug, type ChainSlug } from '@/lib/chains';
import { formatTokenAmount, shortAddress } from '@/lib/format';
import { findRememberedOrderPayment } from '@/lib/orderPaidLookup';
import { shopContactLabel } from '@/lib/shopContact';
import { deploymentForSlug } from '@/lib/tokens';
import { calcCheckoutPayable, type CheckoutParams } from '@/lib/url/checkout';

export function CheckoutChainPicker({ params }: { params: CheckoutParams }) {
  const t = useTranslations('CheckoutForm');
  const router = useRouter();
  const [opening, startTransition] = useTransition();
  const [picked, setPicked] = useState<ChainSlug | null>(null);
  const chains = params.chains ?? [];
  const deployment = deploymentForSlug(params.token, chains[0]);
  const amount = formatTokenAmount(calcCheckoutPayable(params, deployment.decimals), deployment);
  const remote = isRemoteOrderCheckout(params);
  const [remembered, setRemembered] = useState<ReturnType<typeof findRememberedOrderPayment>>(null);
  const [newPurchase, setNewPurchase] = useState(false);
  const canPayAgainAsNewOrder = params.ship === 'ask' && !params.orderId;
  const showChoices = remembered === null || newPurchase;
  useEffect(() => {
    if (remote) setRemembered(findRememberedOrderPayment(params, Date.now()));
  }, [remote, params]);

  const pick = (chain: ChainSlug) => {
    setPicked(chain);
    const search = new URLSearchParams(window.location.search);
    search.set('chain', chain);
    startTransition(() => router.replace(`?${search.toString()}`, { scroll: false }));
  };

  const restored: NotifyShopData | null = remembered
    ? (() => {
        const explorer = blockExplorerUrl(deploymentForSlug(params.token, remembered.chain).chainId);
        return {
          orderNo: params.orderId,
          askShipping: params.ship === 'ask',
          storeName: params.storeName,
          items: params.items.map((item) => ({ name: item.name, qty: item.qty })),
          amountDisplay: amount,
          txHash: remembered.payment.txHash,
          explorerTxUrl: explorer ? `${explorer}/tx/${remembered.payment.txHash}` : undefined,
          chain: remembered.chain,
          shop: params.to,
          ...(remembered.payment.payer ? { payer: remembered.payment.payer } : {}),
          confirm: params.token === 'jpyc',
          contact: params.contact,
        };
      })()
    : null;

  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs uppercase tracking-wider text-slate-500">{t('header')}</p>
        {/* 店名は確かめていない名前 (支払いの画面と同じ注記・第 9 回レビュー D-1)。 */}
        {params.storeName && (
          <>
            <p className="mt-1 break-words text-lg font-bold text-slate-900">{params.storeName}</p>
            <p className="mt-0.5 text-xs text-slate-600">{t('storeNameUnverified')}</p>
          </>
        )}
        <p className="mt-1 text-base font-semibold text-slate-800">
          {params.orderId ? t('orderHeading', { id: params.orderId }) : t('checkoutTitle')}
        </p>
        {params.description && (
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{params.description}</p>
        )}
        <ul className="mt-3 space-y-1 text-sm text-slate-700">
          {params.items.map((item, index) => (
            <li key={index} className="break-words">
              {item.name}
              {item.qty > 1 && <span className="ml-1 tabular-nums text-slate-500">×{item.qty}</span>}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-slate-100 pt-3">
          <span className="text-sm font-semibold text-slate-800">{t('totalRow')}</span>
          <span className="text-lg font-bold tabular-nums text-slate-900">{amount}</span>
        </div>
        {remote && params.ship === 'ask' && (
          <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
            {params.contact
              ? t('shipAskNoteWithContact', { dest: shopContactLabel(params.contact) })
              : t('shipAskNote')}
          </p>
        )}
      </header>

      {restored && (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
          <p className="text-sm font-semibold">{t('notifyRestoredTitle')}</p>
          <p className="mt-1 break-all text-xs">{t('notifyRestoredBody', { tx: shortAddress(restored.txHash) })}</p>
          <div className="mt-3">
            <NotifyShopButton {...restored} tone="panel" />
          </div>
          {!newPurchase && canPayAgainAsNewOrder && (
            <button
              type="button"
              onClick={() => setNewPurchase(true)}
              className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-emerald-800 underline underline-offset-4"
            >
              {t('payAgainAsNewOrder')}
            </button>
          )}
        </section>
      )}

      {showChoices && (
      <section aria-labelledby="checkout-chain-pick" className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 id="checkout-chain-pick" className="text-sm font-semibold text-slate-900">
          {t('chainPickTitle')}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">{t('chainPickHint')}</p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {chains.map((chain) => (
            <button
              key={chain}
              type="button"
              disabled={opening}
              aria-pressed={picked === chain}
              onClick={() => pick(chain)}
              className={`flex min-h-12 items-center gap-2 rounded-xl border px-3 text-left text-sm font-semibold transition-colors disabled:opacity-60 ${
                picked === chain
                  ? 'border-brand bg-brand/5 text-brand-dark ring-2 ring-brand/15'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
              }`}
            >
              <ChainLogo slug={chain} size={20} className="h-5 w-5 shrink-0" />
              {t('chainPickOption', { chain: chainForSlug(chain).name })}
            </button>
          ))}
        </div>
        {opening && (
          <p role="status" className="mt-2 text-xs text-slate-500">
            {t('chainPickOpening')}
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">{t('payToLabel', { addr: shortAddress(params.to) })}</p>
      </section>
      )}
    </div>
  );
}
