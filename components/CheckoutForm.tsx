'use client';

// Stripe Checkout 相当の itemized 決済画面。
//
// /pay (汎用送金) と /tip (固定 widget) の中間に位置する: line items 表示 +
// 注文 metadata + success_url redirect + webhook (Tip と互換シェイプ)。
// 既存 useSmartAccount / useBatchPayment / useGasQuote をそのまま流用。
//
// 重要 (セキュリティ):
//   webhook payload 自体はクライアントから POST されるため、改ざん耐性は
//   Stripe の whsec_ 署名と異なり弱い。マーチャントは webhook 受信後、
//   tx_hash を on-chain で再検証してから注文を確定する責務を負う。同様に
//   success_url の query を信用してはならず、必ず on-chain verification する。

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { erc20Abi, formatUnits } from 'viem';
import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { Row } from './Row';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useGasQuote } from '@/hooks/useGasQuote';
import { calcBreakdown } from '@/lib/fee';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { logger } from '@/lib/logger';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import {
  calcCheckoutTotal,
  type CheckoutParams,
} from '@/lib/url';
import { formatTokenAmount, shortAddress } from '@/lib/format';

const SUCCESS_REDIRECT_DELAY_MS = 3000;

export function CheckoutForm({ params }: { params: CheckoutParams }) {
  const t = useTranslations('CheckoutForm');
  const router = useRouter();

  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const paymasterMode = resolvePaymasterMode(deployment);
  const isErc20Paymaster = paymasterMode === 'erc20';
  const isSponsorship = paymasterMode === 'sponsorship';
  const isMerchantGas = params.gas === 'merchant';

  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const { data: saData, error: saError } = useSmartAccount(deployment, true);
  const gasless = useBatchPayment(deployment);
  const gasQuote = useGasQuote(deployment);

  const totalWei = useMemo(
    () => calcCheckoutTotal(params.items, deployment.decimals),
    [params.items, deployment.decimals],
  );

  const gasAmount = gasQuote.data?.gasAmount;
  const breakdown = useMemo(
    () => calcBreakdown(totalWei, params.token, params.gas, gasAmount ?? 0n),
    [totalWei, params.token, params.gas, gasAmount],
  );

  const totalCustomerOutflow = breakdown.customerPays;
  const gasReimbursement = isSponsorship ? (gasAmount ?? 0n) : 0n;
  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  const balanceQuery = useReadContract({
    address: deployment.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: deployment.chainId,
    query: { enabled: !!address && isConnected },
  });

  const insufficientBalance =
    balanceQuery.data !== undefined &&
    totalCustomerOutflow > 0n &&
    balanceQuery.data < totalCustomerOutflow;

  const wrongChain = isConnected && chainId !== requiredChain.id;
  const gasQuoteReady = gasQuote.data !== undefined;
  // 運営の赤字防止: merchant が 0 になるケースは送信を block。
  //   customer mode: total < fee → merchant = 0
  //   merchant mode: total < fee + gas → merchant = 0
  const merchantUnderflow =
    totalWei > 0n &&
    (isMerchantGas ? gasQuote.data !== undefined : true) &&
    breakdown.merchantReceives === 0n;
  const minimumAmountWei =
    breakdown.feeAmount + (isMerchantGas ? (gasAmount ?? 0n) : 0n);

  const canSubmit =
    isConnected &&
    !wrongChain &&
    !!saData &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !gasless.isPending &&
    gasQuoteReady &&
    !merchantUnderflow;

  const error = isGasCongestedError(gasless.error)
    ? t('errorGasCongested')
    : (gasless.error?.message ??
      saError?.message ??
      (gasQuote.error ? t('errorGasQuote') : null) ??
      (merchantUnderflow
        ? t('errorMerchantUnderflow', { min: fmt(minimumAmountWei) })
        : null));

  // 成功時の redirect スケジューラ (3 秒後 success_url へ移動、skip ボタンで即時)。
  const [redirectIn, setRedirectIn] = useState<number | null>(null);

  useEffect(() => {
    if (gasless.error) logger.error('checkout.failed', { error: gasless.error });
  }, [gasless.error]);

  useEffect(() => {
    if (saError) logger.error('checkout.smart-account.init-failed', { error: saError });
  }, [saError]);

  useEffect(() => {
    if (gasQuote.error) logger.error('checkout.gas-quote.failed', { error: gasQuote.error });
  }, [gasQuote.error]);

  useEffect(() => {
    if (!gasless.data || !gasless.data.success) return;
    logger.info('checkout.success', {
      userOpHash: gasless.data.userOpHash,
      txHash: gasless.data.txHash,
      merchant: params.to,
      orderId: params.orderId,
      token: params.token,
      chain: chainSlug,
    });

    // webhook (Tip と互換シェイプ + checkout 固有フィールド)。
    // 失敗しても決済自体は成立しているので、log だけ残し UI には出さない。
    if (params.webhook) {
      const payload = {
        type: 'openpay.checkout.success',
        merchant: params.to,
        from: address,
        token: params.token,
        chain: chainSlug,
        chainId: deployment.chainId,
        amount: formatUnits(totalWei, deployment.decimals),
        items: params.items,
        merchantAmount: breakdown.merchantReceives.toString(),
        feeAmount: breakdown.feeAmount.toString(),
        customerPays: breakdown.customerPays.toString(),
        orderId: params.orderId,
        description: params.description,
        customerEmail: params.customerEmail,
        txHash: gasless.data.txHash,
        userOpHash: gasless.data.userOpHash,
        blockNumber: gasless.data.blockNumber.toString(),
        ts: Date.now(),
      };
      fetch(params.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        mode: 'cors',
        keepalive: true,
      })
        .then((res) => {
          if (!res.ok) {
            logger.warn('checkout.webhook.non_ok', {
              status: res.status,
              statusText: res.statusText,
              url: params.webhook,
            });
          }
        })
        .catch((err) =>
          logger.warn('checkout.webhook.failed', {
            error: err,
            url: params.webhook,
          }),
        );
    }

    // success_url 自動 redirect (3 秒)。skip ボタンで即時可能。
    if (params.successUrl) {
      setRedirectIn(SUCCESS_REDIRECT_DELAY_MS / 1000);
    }
  }, [
    gasless.data,
    params.to,
    params.token,
    chainSlug,
    params.items,
    params.orderId,
    params.description,
    params.customerEmail,
    params.webhook,
    params.successUrl,
    address,
    breakdown.merchantReceives,
    breakdown.feeAmount,
    breakdown.customerPays,
    deployment.chainId,
    deployment.decimals,
    totalWei,
  ]);

  useEffect(() => {
    if (redirectIn === null) return;
    if (redirectIn <= 0) {
      doRedirect();
      return;
    }
    const id = setTimeout(() => setRedirectIn((v) => (v === null ? null : v - 1)), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirectIn]);

  function doRedirect() {
    if (!params.successUrl || !gasless.data) return;
    const u = new URL(params.successUrl);
    u.searchParams.set('tx_hash', gasless.data.txHash);
    u.searchParams.set('user_op_hash', gasless.data.userOpHash);
    u.searchParams.set('block', gasless.data.blockNumber.toString());
    if (params.orderId) u.searchParams.set('order_id', params.orderId);
    u.searchParams.set('chain', chainSlug);
    u.searchParams.set('token', params.token);
    setRedirectIn(null);
    // 外部 URL のため Next.js の router ではなく window.location.assign を使う。
    window.location.assign(u.toString());
  }

  function onSubmit() {
    if (!canSubmit) return;
    gasless.mutate({
      tokenAddress: deployment.address,
      merchant: params.to,
      merchantAmount: breakdown.merchantReceives,
      feeReceiver: env.feeReceiver,
      feeAmount: breakdown.feeAmount + gasReimbursement,
    });
  }

  const explorerBase = blockExplorerUrl(deployment.chainId);
  const approvalCheckUrl =
    isErc20Paymaster && address && explorerBase
      ? `${explorerBase}/tokenapprovalchecker?search=${address}`
      : undefined;

  // 完了後の状態 (success panel 表示)。
  const completed = gasless.data && gasless.data.success;

  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs uppercase tracking-wider text-slate-500">
          {t('header')}
        </p>
        <p className="mt-1 text-base font-semibold text-slate-800">
          {params.orderId ? t('orderHeading', { id: params.orderId }) : t('checkoutTitle')}
        </p>
        {params.description && (
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">
            {params.description}
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          {t('payToLabel', { addr: shortAddress(params.to) })} ·{' '}
          {requiredChain.name} · {deployment.displaySymbol}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('itemsTitle')}
        </p>
        <ul className="mt-3 divide-y divide-slate-100">
          {params.items.map((it, i) => {
            const lineTotalWei = calcCheckoutTotal([it], deployment.decimals);
            return (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0 flex-1 break-words font-medium text-slate-700">
                  {it.name}
                </span>
                <span className="shrink-0 font-mono text-xs text-slate-500">
                  ×{it.qty}
                </span>
                <span className="shrink-0 font-mono text-sm text-slate-800">
                  {fmt(lineTotalWei)}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 border-t border-slate-200 pt-3">
          <dl className="space-y-1.5">
            <Row label={t('subtotalRow')} value={fmt(totalWei)} />
            <Row
              label={t('feeRow')}
              value={fmt(breakdown.feeAmount)}
            />
            <Row
              label={isMerchantGas ? t('gasRowMerchant') : t('gasRow')}
              value={
                gasAmount !== undefined
                  ? t('gasRowValue', { amount: fmt(gasAmount) })
                  : t('gasRowPending')
              }
            />
            <div className="my-1 border-t border-slate-200" />
            <Row
              label={
                isMerchantGas ? t('totalRowMerchantGas') : t('totalRow')
              }
              value={fmt(totalCustomerOutflow)}
              strong
            />
          </dl>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {isErc20Paymaster ? t('gaslessHintUsdc') : t('gaslessHintJpyc')}
        </p>
        {approvalCheckUrl && (
          <p className="mt-2 text-[11px]">
            <a
              href={approvalCheckUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-slate-500 underline hover:text-slate-700"
            >
              {t('approvalCheckLink')} ↗
            </a>
          </p>
        )}
      </section>

      {!completed && (
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
              {isSwitching
                ? t('switchingChain')
                : t('switchChain', { chainName: requiredChain.name })}
            </button>
          )}

          {isConnected && !wrongChain && balanceQuery.data !== undefined && (
            <p className="text-xs text-slate-500">
              {t('balanceLabel')}{' '}
              <span className="font-mono">{fmt(balanceQuery.data)}</span>
            </p>
          )}

          {insufficientBalance && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {t('insufficientBalance', { amount: fmt(totalCustomerOutflow) })}
            </p>
          )}

          {params.customerEmail && (
            <p className="text-[11px] text-slate-500">
              {t('emailHint', { email: params.customerEmail })}
            </p>
          )}
        </section>
      )}

      {!completed && (
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="w-full rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {gasless.isPending
            ? t('btnSending')
            : !isConnected
              ? t('btnConnect')
              : wrongChain
                ? t('btnSwitchChain')
                : !saData
                  ? t('btnSaInit')
                  : !gasQuoteReady
                    ? t('btnGasQuoteLoading')
                    : t('btnPay', { amount: fmt(totalCustomerOutflow) })}
        </button>
      )}

      {!completed && params.cancelUrl && (
        <a
          href={params.cancelUrl}
          className="block text-center text-xs text-slate-500 underline hover:text-slate-700"
        >
          {t('cancelLink')}
        </a>
      )}

      {error && !completed && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <p className="font-semibold">{t('errorTitle')}</p>
          <p className="mt-1 break-words">{error}</p>
        </div>
      )}

      {completed && gasless.data && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <p className="font-semibold">{t('successTitle')}</p>
          <p className="mt-1 text-xs">{t('successBody')}</p>
          <dl className="mt-3 space-y-1 text-xs">
            <ResultRow label={t('successUserOp')} value={gasless.data.userOpHash} />
            <ResultRow label={t('successTx')} value={gasless.data.txHash} />
            <ResultRow
              label={t('successBlock')}
              value={gasless.data.blockNumber.toString()}
            />
            {params.orderId && (
              <ResultRow label={t('orderIdLabel')} value={params.orderId} />
            )}
          </dl>
          {params.successUrl && (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs">
                {redirectIn !== null && redirectIn > 0
                  ? t('redirectingIn', { sec: redirectIn })
                  : t('redirectingNow')}
              </p>
              <button
                type="button"
                onClick={doRedirect}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                {t('redirectNowButton')}
              </button>
            </div>
          )}
          {!params.successUrl && (
            <button
              type="button"
              onClick={() => router.push('/')}
              className="mt-4 inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              {t('returnHomeButton')}
            </button>
          )}
        </div>
      )}

      <p className="pt-2 text-center text-[10px] text-slate-400">
        {t('poweredBy')}{' '}
        <a
          href="https://github.com/cipherwebllc/openpay"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-slate-600"
        >
          OpenPay
        </a>
      </p>
    </div>
  );
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="opacity-70">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </div>
  );
}
