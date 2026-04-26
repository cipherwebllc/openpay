'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { erc20Abi, formatUnits, parseUnits } from 'viem';
import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { Row } from './Row';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useDirectPayment } from '@/hooks/useDirectPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import {
  calcBreakdown,
  calcDirectBreakdown,
  calcSplitBreakdown,
} from '@/lib/fee';
import { chainForToken } from '@/lib/chains';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getToken } from '@/lib/tokens';
import { parsePayParams, type PayParams } from '@/lib/url';

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function PaymentForm() {
  const search = useSearchParams();
  const parsed = useMemo(() => parsePayParams(search), [search]);
  const t = useTranslations('PaymentForm');

  if (!parsed.ok) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-700">
        <h2 className="font-semibold">{t('urlInvalidTitle')}</h2>
        <p className="mt-2 text-sm">{parsed.error}</p>
      </div>
    );
  }

  return <PaymentDetails params={parsed.params} />;
}

function PaymentDetails({ params }: { params: PayParams }) {
  const t = useTranslations('PaymentForm');
  const isDirect = params.mode === 'direct';
  const token = getToken(params.token);
  const requiredChain = chainForToken(params.token);

  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // Smart Account は gasless のみ必要 — direct では enabled=false で skip。
  const { data: saData, error: saError } = useSmartAccount(!isDirect);

  // 両方のフックを常に call し、isDirect で送信先を分岐 (条件付きフックは禁止)。
  const gasless = useBatchPayment();
  const direct = useDirectPayment();

  const fixedAmount = params.amount ?? '';
  const isFixed = fixedAmount.length > 0;
  const [inputAmount, setInputAmount] = useState('');
  const amountStr = isFixed ? fixedAmount : inputAmount;

  const amountWei = useMemo(() => {
    if (!amountStr || !/^\d+(\.\d+)?$/.test(amountStr)) return 0n;
    return parseUnits(amountStr, token.decimals);
  }, [amountStr, token.decimals]);

  // token の decimals と displaySymbol を毎回書くのを避ける。
  const fmt = (wei: bigint) =>
    `${formatUnits(wei, token.decimals)} ${token.displaySymbol}`;

  const breakdown = useMemo(
    () =>
      isDirect
        ? calcDirectBreakdown(amountWei)
        : calcBreakdown(amountWei, params.fee, params.token),
    [isDirect, amountWei, params.fee, params.token],
  );

  // C1: split が指定されていれば、breakdown.merchantReceives を分配する。
  // direct mode では split は無視 (シンプルな単一 transfer に限定)。
  const splitBreakdown = useMemo(() => {
    if (isDirect || !params.split || params.split.length === 0) return null;
    return calcSplitBreakdown(
      amountWei,
      params.fee,
      params.token,
      params.to,
      params.split,
    );
  }, [
    isDirect,
    amountWei,
    params.fee,
    params.token,
    params.to,
    params.split,
  ]);

  const balanceQuery = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: token.chainId,
    query: { enabled: !!address && isConnected },
  });

  const insufficientBalance =
    balanceQuery.data !== undefined &&
    breakdown.customerPays > 0n &&
    balanceQuery.data < breakdown.customerPays;

  const wrongChain = isConnected && chainId !== requiredChain.id;
  const flowPending = isDirect ? direct.isPending : gasless.isPending;
  const canSubmit =
    isConnected &&
    !wrongChain &&
    (isDirect || !!saData) &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !flowPending;

  const error =
    (isDirect ? direct.error?.message : gasless.error?.message) ??
    (!isDirect && saError ? saError.message : null);

  useEffect(() => {
    if (gasless.error) logger.error('payment.failed', { error: gasless.error });
  }, [gasless.error]);

  useEffect(() => {
    if (direct.error) logger.error('payment.direct.failed', { error: direct.error });
  }, [direct.error]);

  useEffect(() => {
    if (saError) logger.error('smart-account.init-failed', { error: saError });
  }, [saError]);

  useEffect(() => {
    if (gasless.data) {
      logger.info('payment.success', {
        userOpHash: gasless.data.userOpHash,
        txHash: gasless.data.txHash,
      });
    }
  }, [gasless.data]);

  useEffect(() => {
    if (direct.data) {
      logger.info('payment.direct.success', { txHash: direct.data.txHash });
    }
  }, [direct.data]);

  function onSubmit() {
    if (!canSubmit) return;
    if (isDirect) {
      direct.mutate({
        tokenAddress: token.address,
        merchant: params.to,
        amount: breakdown.customerPays,
        chainId: token.chainId,
      });
    } else if (splitBreakdown) {
      // recipients[0] は primary (params.to)、それ以降が split entries
      const [primary, ...extras] = splitBreakdown.recipients;
      gasless.mutate({
        tokenAddress: token.address,
        merchant: primary.to,
        merchantAmount: primary.amount,
        feeReceiver: env.feeReceiver,
        feeAmount: splitBreakdown.feeAmount,
        extraRecipients: extras.map((e) => ({ to: e.to, amount: e.amount })),
      });
    } else {
      gasless.mutate({
        tokenAddress: token.address,
        merchant: params.to,
        merchantAmount: breakdown.merchantReceives,
        feeReceiver: env.feeReceiver,
        feeAmount: breakdown.feeAmount,
      });
    }
  }

  return (
    <div className="space-y-6">
      <header className="rounded-2xl bg-gradient-to-br from-brand to-brand-dark p-6 text-white">
        <p className="text-sm uppercase tracking-wider opacity-80">
          {t('title')}
        </p>
        <p className="mt-1 text-xs opacity-70">{requiredChain.name}</p>
        <div className="mt-4">
          <p className="text-xs opacity-80">{t('amountHeader')}</p>
          {isFixed ? (
            <p className="mt-1 text-3xl font-bold">
              {fixedAmount} {token.displaySymbol}
            </p>
          ) : (
            <div className="mt-2">
              <input
                type="text"
                inputMode="decimal"
                value={inputAmount}
                onChange={(e) =>
                  setInputAmount(e.target.value.replace(/[^\d.]/g, ''))
                }
                placeholder={token.symbol === 'jpyc' ? '1000' : '10.00'}
                className="w-full rounded-lg bg-white/15 px-3 py-2 text-2xl font-bold text-white placeholder:text-white/50 focus:bg-white/20 focus:outline-none"
              />
              <p className="mt-1 text-xs opacity-70">
                {t('amountInputHint', { symbol: token.displaySymbol })}
              </p>
            </div>
          )}
        </div>
      </header>

      {isDirect && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{t('directWarningTitle')}</p>
          <p className="mt-1 text-xs">
            {t('directWarningBody', {
              nativeToken:
                requiredChain.id === 137 || requiredChain.id === 80002
                  ? 'MATIC'
                  : 'ETH',
            })}
          </p>
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          {t('breakdownTitle')}
        </h2>
        <dl className="mt-3 space-y-2 text-sm">
          {splitBreakdown ? (
            splitBreakdown.recipients.map((r, i) => (
              <Row
                key={r.to}
                label={t(
                  i === 0 ? 'primaryRecipientRow' : 'splitRecipientRow',
                  { percent: r.percent, addr: shortAddr(r.to) },
                )}
                value={fmt(r.amount)}
              />
            ))
          ) : (
            <Row label={t('merchantRow')} value={fmt(breakdown.merchantReceives)} />
          )}
          {!isDirect && (
            <Row
              label={t('feeRow')}
              value={fmt(
                splitBreakdown ? splitBreakdown.feeAmount : breakdown.feeAmount,
              )}
            />
          )}
          <div className="my-2 border-t border-slate-200" />
          <Row
            label={
              isDirect
                ? t('customerDirect')
                : params.fee === 'include'
                  ? t('customerInclude')
                  : t('customerExclude')
            }
            value={fmt(
              splitBreakdown
                ? splitBreakdown.customerPays
                : breakdown.customerPays,
            )}
            strong
          />
        </dl>
        <p className="mt-4 text-xs text-slate-500">
          {isDirect
            ? t('directBatchHint')
            : splitBreakdown
              ? t('splitBatchHint', {
                  count: splitBreakdown.recipients.length,
                })
              : t('gaslessBatchHint')}
        </p>
      </section>

      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          {t('walletSection')}
        </h2>
        <ConnectButton />

        {isConnected && wrongChain && (
          <button
            type="button"
            onClick={() => switchChain({ chainId: requiredChain.id })}
            disabled={isSwitching}
            className="w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {isSwitching
              ? t('switchingChain')
              : t('switchChain', { chainName: requiredChain.name })}
          </button>
        )}

        {isConnected && !wrongChain && balanceQuery.data !== undefined && (
          <div className="text-xs text-slate-500">
            {t('balanceLabel')}{' '}
            <span className="font-mono">{fmt(balanceQuery.data)}</span>
          </div>
        )}

        {insufficientBalance && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {t('insufficientBalance', {
              amount: fmt(breakdown.customerPays),
            })}
          </p>
        )}
      </section>

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className="w-full rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white shadow hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {flowPending
          ? t('btnSending')
          : !isConnected
            ? t('btnConnect')
            : wrongChain
              ? t('btnSwitchChain')
              : !isDirect && !saData
                ? t('btnSaInit')
                : breakdown.customerPays === 0n
                  ? t('btnEnterAmount')
                  : t('btnPay', { amount: fmt(breakdown.customerPays) })}
      </button>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-semibold">{t('errorTitle')}</p>
          <p className="mt-1 break-words">{error}</p>
        </div>
      )}

      {!isDirect && gasless.data && gasless.data.success && (
        <ResultPanel
          title={t('successTitle')}
          rows={[
            [t('successUserOp'), gasless.data.userOpHash],
            [t('successTx'), gasless.data.txHash],
            [t('successBlock'), gasless.data.blockNumber.toString()],
          ]}
        />
      )}

      {isDirect && direct.data && (
        <ResultPanel
          title={t('successTitle')}
          rows={[
            [t('successTx'), direct.data.txHash],
            [t('successBlock'), direct.data.blockNumber.toString()],
          ]}
        />
      )}
    </div>
  );
}

function ResultPanel({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string]>;
}) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
      <p className="font-semibold">{title}</p>
      <dl className="mt-2 space-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="opacity-70">{label}</dt>
            <dd className="break-all font-mono">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

