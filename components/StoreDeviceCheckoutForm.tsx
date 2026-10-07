'use client';

// 「お店の端末で送る」の /checkout (submit=store&hs=・plans/store-gas-wallet.md P2b)。既存の CheckoutForm には
// 触れず、この経路だけを描画する (掟 12: money-path は追加のみ)。お客様は署名するだけで、送信とガス代は
// お店の端末。OpenPay 利用料は 0 円 (仕組み上、手数料欄 1 wei が加わる)。

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useAccount, useSwitchChain } from 'wagmi';
import { formatUnits } from 'viem';
import { ConnectButton } from './ConnectButton';
import { PayerReceiptCompletion } from './PayerReceiptCompletion';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
import { usePaymentHistory, type GaslessSnapshot } from '@/hooks/usePaymentHistory';
import {
  useStoreDevicePayment,
  type StoreDeviceIntent,
  type StoreDevicePaymentSnapshot,
} from '@/hooks/useStoreDevicePayment';
import { addressExplorerUrl, chainForSlug, txExplorerUrl } from '@/lib/chains';
import { env } from '@/lib/env';
import { formatTokenAmount } from '@/lib/format';
import { STORE_DEVICE_FEE_WEI } from '@/lib/storeDevicePayment';
import { taxAmountDecimal, taxDisplayDecimals } from '@/lib/tax';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import { calcCheckoutTotal, type CheckoutItem, type CheckoutParams } from '@/lib/url';
import type { Address } from 'viem';

const IDLE_STANDARD = { phase: 'idle', error: null } as const;

export function StoreDeviceCheckoutForm({ params }: { params: CheckoutParams }) {
  const t = useTranslations('CheckoutForm');
  const locale = useLocale();
  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const { address, isConnected } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const handoffId = params.handoffId ?? '';
  const { status, pay, checkNow, acknowledge } = useStoreDevicePayment(deployment, handoffId);
  // 署名した時点で固定した値 (表示・履歴・控えはこれで作る・後からウォレットや URL が変わっても動かない)。
  const frozen: StoreDeviceIntent | null =
    status.phase === 'waiting' ||
    status.phase === 'success' ||
    status.phase === 'expired' ||
    status.phase === 'used_unresolved' ||
    status.phase === 'previous'
      ? status.intent
      : null;
  // 結論待ちの間 (この会計でも前の会計でも) は、別の支払いを勧める案内を出さない。
  const unresolved = status.phase === 'waiting';

  const bill = useMemo(
    () => calcCheckoutTotal(params.items, deployment.decimals),
    [params.items, deployment.decimals],
  );
  // お客様の送金 = 請求額 + 1 wei (手数料欄・user 裁定)。残高の判定もこの額で行う。
  const customerPays = bill + STORE_DEVICE_FEE_WEI;
  const { balance, insufficientBalance, wrongChain } = useErc20BalanceAndChain(
    deployment,
    requiredChain,
    customerPays,
  );
  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  // 残り時間の表示 (送信待ちの間だけ 1 秒ごと)。
  const waitingUntil = status.phase === 'waiting' ? status.intent.validBefore : null;
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (waitingUntil === null) return;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [waitingUntil]);
  const remaining = waitingUntil === null ? 0 : Math.max(0, waitingUntil - nowSec);

  // 履歴と控え: 既存の usePaymentHistory に、この経路の結果を「ガスレスの 1 件」として渡す
  // (店の受取 = 請求額・利用料欄 = 1 wei・お客様はガスを払わない・ガス代は店の端末)。値は署名した時点で固定。
  const historyCtx = useMemo(() => {
    const snap: StoreDevicePaymentSnapshot = frozen?.snapshot ?? {
      storeName: params.storeName,
      invoiceNo: params.invoiceNo,
      items: params.items,
      description: params.description,
      taxRate: params.taxRate,
      taxCategory: params.taxCategory,
      receiptNo: params.receiptNo,
    };
    const merchantValue = frozen ? BigInt(frozen.merchantValue) : bill;
    return {
      chainId: deployment.chainId,
      chainSlug,
      asset: params.token,
      tokenAddress: deployment.address,
      payMode: 'gasless' as const,
      gasMode: 'merchant' as const,
      merchant: (frozen?.merchant ?? params.to) as Address,
      merchantAmount: merchantValue,
      customer: (frozen?.from ?? address) as Address | undefined,
      feeReceiver: env.feeReceiver,
      feeAmount: STORE_DEVICE_FEE_WEI,
      saleAmount: merchantValue,
      networkFeeEquivalent: null,
      storeName: '',
      receiptMerchantName: snap.storeName ?? null,
      invoiceNo: snap.invoiceNo ?? null,
      note: snap.description ?? '',
      productName: snap.items.map((it) => it.name).join(', '),
      memo: snap.description ?? null,
      taxRate: snap.taxRate ?? null,
      taxCategory: snap.taxCategory ?? null,
      receiptNo: snap.receiptNo ?? null,
      lineItems: snap.items.map((it: CheckoutItem, i: number) => {
        const amount = formatUnits(calcCheckoutTotal([it], deployment.decimals), deployment.decimals);
        const taxRate = it.taxRate ?? snap.taxRate ?? null;
        const taxAmt = taxAmountDecimal(Number(amount), taxRate, taxDisplayDecimals(params.token));
        return {
          id: String(i),
          name: it.name,
          quantity: it.qty,
          unitPrice: it.price,
          amount,
          currency: params.token,
          taxRate,
          taxCategory: it.taxCategory ?? snap.taxCategory ?? null,
          taxAmount: taxAmt == null ? '0' : String(taxAmt),
          memo: it.memo ?? null,
        };
      }),
      sourceRoute: '/checkout',
      locale,
    };
  }, [frozen, deployment, chainSlug, params, bill, address, locale]);
  // 記録するのは「支払い済み」の結論だけ (前の会計の結論も、その会計の値で記録する)。
  const successTx =
    status.phase === 'success'
      ? status.txHash
      : status.phase === 'previous' && status.outcome === 'success'
        ? status.txHash
        : null;
  const gaslessSnapshot: GaslessSnapshot = useMemo(() => {
    const merchantValue = frozen ? BigInt(frozen.merchantValue) : bill;
    const variables = {
      merchantAmount: merchantValue,
      feeAmount: STORE_DEVICE_FEE_WEI,
      saleAmount: merchantValue,
      networkFeeEquivalent: null,
    };
    // 記録するのは結論が「支払い済み」のときだけ (txHash は必ずある・控えの id = txHash で安定)。
    if (successTx) {
      return {
        data: { txHash: successTx, userOpHash: null, blockNumber: null, success: true },
        error: null,
        variables,
      };
    }
    return { error: null, variables };
  }, [successTx, frozen, bill]);
  usePaymentHistory(historyCtx, gaslessSnapshot, IDLE_STANDARD);

  const busy =
    status.phase === 'signing' || status.phase === 'submitting' || status.phase === 'waiting';
  const done =
    status.phase === 'success' || status.phase === 'expired' || status.phase === 'used_unresolved';
  const blocked = status.phase === 'error' && status.blocking;
  const canPay =
    isConnected && !wrongChain && !insufficientBalance && !busy && !done && !blocked && bill > 0n;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        {params.storeName && (
          <p className="text-sm font-semibold text-slate-800">{params.storeName}</p>
        )}
        <ul className="mt-2 space-y-1 text-sm">
          {params.items.map((it, i) => (
            <li key={`${it.name}-${i}`} className="flex justify-between gap-2">
              <span className="break-words">
                {it.name} <span className="text-slate-500">×{it.qty}</span>
              </span>
              <span className="font-mono">
                {fmt(calcCheckoutTotal([it], deployment.decimals))}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-between border-t border-slate-100 pt-2 text-base font-bold text-slate-900">
          <span>{t('storeDevice.totalLabel')}</span>
          <span className="font-mono">{fmt(bill)}</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('storeDevice.feeNote')}</p>
      </section>

      {!done && (
        <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('walletSection')}
          </p>
          <ConnectButton />
          {isConnected && wrongChain && (
            <button
              type="button"
              onClick={() => switchChain({ chainId: requiredChain.id })}
              disabled={isSwitching}
              className="w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {isSwitching ? t('switchingChain') : t('switchChain', { chainName: requiredChain.name })}
            </button>
          )}
          {isConnected && !wrongChain && balance !== undefined && (
            <p className="text-xs text-slate-500">
              {t('balanceLabel')} <span className="font-mono">{fmt(balance)}</span>
            </p>
          )}
          {insufficientBalance && !unresolved && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {t('storeDevice.insufficientBalance', { amount: fmt(bill) })}
            </p>
          )}
        </section>
      )}

      {!done && (
        <>
          <p className="text-xs leading-relaxed text-slate-500">{t('storeDevice.signNote')}</p>
          <button
            type="button"
            disabled={!canPay}
            onClick={() =>
              void pay({
                merchant: params.to,
                bill,
                snapshot: {
                  storeName: params.storeName,
                  invoiceNo: params.invoiceNo,
                  items: params.items,
                  description: params.description,
                  taxRate: params.taxRate,
                  taxCategory: params.taxCategory,
                  receiptNo: params.receiptNo,
                },
              })
            }
            className="w-full rounded-xl bg-brand px-5 py-3 text-base font-bold text-white shadow-card hover:bg-brand-dark disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
          >
            {status.phase === 'signing'
              ? t('storeDevice.btnSigning')
              : status.phase === 'submitting'
                ? t('btnSending')
                : t('btnPay', { amount: fmt(bill) })}
          </button>
        </>
      )}

      {status.phase === 'waiting' && (
        <div className="space-y-2 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900">
          {/* 読み上げは状態だけ (秒数の更新を毎秒読み上げない)。 */}
          <p role="status">
            {status.otherCheckout
              ? t('storeDevice.waitingOther')
              : status.confirming
                ? t('storeDevice.confirming')
                : t('storeDevice.waiting')}
          </p>
          {status.otherCheckout && (
            <p className="text-xs text-sky-800">
              {t('storeDevice.previousPayment', {
                store: status.intent.snapshot.storeName ?? '—',
                amount: fmt(BigInt(status.intent.merchantValue)),
              })}
            </p>
          )}
          {remaining > 0 && (
            <p className="text-xs text-sky-800">{t('storeDevice.remaining', { seconds: remaining })}</p>
          )}
          {status.autoStopped && <p className="text-xs text-sky-800">{t('storeDevice.autoStopped')}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={checkNow}
              className="rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-100"
            >
              {t('storeDevice.checkNow')}
            </button>
            {(() => {
              const href = status.txHint
                ? txExplorerUrl(deployment.chainId, status.txHint)
                : addressExplorerUrl(deployment.chainId, status.intent.from);
              return href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs text-sky-800 underline underline-offset-2"
                >
                  {status.txHint ? t('storeDevice.viewTx') : t('storeDevice.viewWallet')}
                </a>
              ) : null;
            })()}
          </div>
        </div>
      )}

      {status.phase === 'previous' && (
        <p role="status" className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-800">
          {t(`storeDevice.previous.${status.outcome}`, {
            store: status.intent.snapshot.storeName ?? '—',
            amount: fmt(BigInt(status.intent.merchantValue)),
          })}
        </p>
      )}

      {status.phase === 'used_unresolved' && (
        <div role="alert" className="space-y-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>{t('storeDevice.usedUnresolved')}</p>
          {status.ackFailed && <p className="text-xs font-semibold">{t('storeDevice.ackFailed')}</p>}
          {status.otherCheckout && (
            <p className="text-xs">
              {t('storeDevice.previousPayment', {
                store: status.intent.snapshot.storeName ?? '—',
                amount: fmt(BigInt(status.intent.merchantValue)),
              })}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {addressExplorerUrl(deployment.chainId, status.intent.from) && (
              <a
                href={addressExplorerUrl(deployment.chainId, status.intent.from)}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs underline underline-offset-2"
              >
                {t('storeDevice.viewWallet')}
              </a>
            )}
            <button
              type="button"
              onClick={() => void acknowledge()}
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              {t('storeDevice.acknowledge')}
            </button>
          </div>
        </div>
      )}

      {status.phase === 'success' && (
        <section role="status" className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-base font-bold text-emerald-900">{t('storeDevice.success')}</p>
          {status.txHash && txExplorerUrl(deployment.chainId, status.txHash) && (
            <a
              href={txExplorerUrl(deployment.chainId, status.txHash)}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-emerald-800 underline underline-offset-2"
            >
              {t('storeDevice.viewTx')}
            </a>
          )}
          <PayerReceiptCompletion candidateIds={[status.txHash]} />
        </section>
      )}

      {status.phase === 'expired' && (
        <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t('storeDevice.expired')}
        </p>
      )}

      {status.phase === 'error' && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {t(`storeDevice.error.${status.reason}`)}
        </p>
      )}
    </div>
  );
}

