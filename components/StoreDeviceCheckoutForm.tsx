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
import { useStoreDevicePayment } from '@/hooks/useStoreDevicePayment';
import { chainForSlug, txExplorerUrl } from '@/lib/chains';
import { env } from '@/lib/env';
import { formatTokenAmount } from '@/lib/format';
import { STORE_DEVICE_FEE_WEI } from '@/lib/storeDevicePayment';
import { taxAmountDecimal, taxDisplayDecimals } from '@/lib/tax';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import { calcCheckoutTotal, type CheckoutParams } from '@/lib/url';

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
  const { status, pay } = useStoreDevicePayment(deployment, handoffId);

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
  const waitingUntil =
    status.phase === 'waiting' || status.phase === 'confirming' ? status.validBefore : null;
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (waitingUntil === null) return;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [waitingUntil]);
  const remaining = waitingUntil === null ? 0 : Math.max(0, waitingUntil - nowSec);

  // 履歴と控え: 既存の usePaymentHistory に、この経路の結果を「ガスレスの 1 件」として渡す
  // (店の受取 = 請求額・利用料欄 = 1 wei・お客様はガスを払わない)。
  const historyCtx = useMemo(
    () => ({
      chainId: deployment.chainId,
      chainSlug,
      asset: params.token,
      tokenAddress: deployment.address,
      payMode: 'gasless' as const,
      gasMode: 'customer' as const,
      merchant: params.to,
      merchantAmount: bill,
      customer: address,
      feeReceiver: env.feeReceiver,
      feeAmount: STORE_DEVICE_FEE_WEI,
      saleAmount: bill,
      networkFeeEquivalent: null,
      storeName: '',
      receiptMerchantName: params.storeName ?? null,
      invoiceNo: params.invoiceNo ?? null,
      note: params.description ?? '',
      productName: params.items.map((it) => it.name).join(', '),
      memo: params.description ?? null,
      taxRate: params.taxRate ?? null,
      taxCategory: params.taxCategory ?? null,
      receiptNo: params.receiptNo ?? null,
      lineItems: params.items.map((it, i) => {
        const amount = formatUnits(calcCheckoutTotal([it], deployment.decimals), deployment.decimals);
        const taxRate = it.taxRate ?? params.taxRate ?? null;
        const taxAmt = taxAmountDecimal(Number(amount), taxRate, taxDisplayDecimals(params.token));
        return {
          id: String(i),
          name: it.name,
          quantity: it.qty,
          unitPrice: it.price,
          amount,
          currency: params.token,
          taxRate,
          taxCategory: it.taxCategory ?? params.taxCategory ?? null,
          taxAmount: taxAmt == null ? '0' : String(taxAmt),
          memo: it.memo ?? null,
        };
      }),
      sourceRoute: '/checkout',
      locale,
    }),
    [deployment, chainSlug, params, bill, address, locale],
  );
  const gaslessSnapshot: GaslessSnapshot = useMemo(() => {
    const variables = {
      merchantAmount: bill,
      feeAmount: STORE_DEVICE_FEE_WEI,
      saleAmount: bill,
      networkFeeEquivalent: null,
    };
    if (status.phase === 'success' || status.phase === 'reverted') {
      return {
        data: {
          txHash: status.txHash,
          userOpHash: null,
          blockNumber: null,
          success: status.phase === 'success',
        },
        error: null,
        variables,
      };
    }
    return { error: null, variables };
  }, [status, bill]);
  usePaymentHistory(historyCtx, gaslessSnapshot, IDLE_STANDARD);

  const busy =
    status.phase === 'signing' ||
    status.phase === 'submitting' ||
    status.phase === 'waiting' ||
    status.phase === 'confirming';
  const done = status.phase === 'success';
  const canPay = isConnected && !wrongChain && !insufficientBalance && !busy && !done && bill > 0n;

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
          {insufficientBalance && (
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
            onClick={() => void pay({ merchant: params.to, bill })}
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

      {(status.phase === 'waiting' || status.phase === 'confirming') && (
        <p role="status" className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900">
          {t('storeDevice.waiting', { seconds: remaining })}
        </p>
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
          <PayerReceiptCompletion candidateIds={[status.txHash ?? undefined]} />
        </section>
      )}

      {status.phase === 'reverted' && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {t('storeDevice.reverted')}
        </p>
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

