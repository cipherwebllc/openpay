'use client';

// セキュリティ: webhook payload と success_url の query は顧客側で改ざん可能
// (Stripe の whsec_ 署名相当の保証はない)。マーチャントは tx_hash を必ず
// on-chain で再検証してから注文を確定する責務を負う。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { InfoTooltip } from './InfoTooltip';
import { OnrampCta } from './OnrampCta';
import { ResultRow } from './ResultRow';
import { Row } from './Row';
import { SmartAccountFallbackBanner } from './SmartAccountFallbackBanner';
import { SuccessOverlay } from './SuccessOverlay';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useGasQuote } from '@/hooks/useGasQuote';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
import { calcBreakdown } from '@/lib/fee';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { isIncompatibleSmartAccountError } from '@/lib/accountDetection';
import { logger } from '@/lib/logger';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
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
  const [modeOverride, setModeOverride] = useState<'standard' | null>(null);

  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const isStandard = params.mode === 'standard' || modeOverride === 'standard';
  const paymasterMode = resolvePaymasterMode(deployment);
  const isErc20Paymaster = !isStandard && paymasterMode === 'erc20';
  const isSponsorship = !isStandard && paymasterMode === 'sponsorship';
  const isMerchantGas = !isStandard && params.gas === 'merchant';

  const { address, isConnected } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // Smart Account / Pimlico 経路は gasless のみ必要 — standard では skip。
  const { data: saData, error: saError } = useSmartAccount(
    deployment,
    !isStandard,
  );
  const gasless = useBatchPayment(deployment, !isStandard);
  const standard = useStandardPayment();
  const gasQuote = useGasQuote(deployment, !isStandard);

  const totalWei = useMemo(
    () => calcCheckoutTotal(params.items, deployment.decimals),
    [params.items, deployment.decimals],
  );

  // standard mode では gasQuote 不要 (顧客 wallet が gas を自前で算定)。
  const gasAmount = !isStandard ? gasQuote.data?.gasAmount : undefined;
  const effectiveMode = isStandard ? 'standard' : params.mode;
  const breakdown = useMemo(
    () =>
      calcBreakdown(
        totalWei,
        params.token,
        effectiveMode,
        params.gas,
        gasAmount ?? 0n,
      ),
    [totalWei, params.token, effectiveMode, params.gas, gasAmount],
  );

  const totalCustomerOutflow = breakdown.customerPays;
  const gasReimbursement = isSponsorship ? (gasAmount ?? 0n) : 0n;
  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  // ネイティブガストークン symbol を viem chain 経由で取得 (chain-aware)。
  // Polygon=POL / Kaia=KAIA / Base/Arbitrum/Optimism=ETH。standard mode の
  // 顧客向け wallet hint + gasInfoJpyc / gasInfoUsdc tooltip で使用。
  const nativeToken = requiredChain.nativeCurrency.symbol;

  const { balance, insufficientBalance, wrongChain } = useErc20BalanceAndChain(
    deployment,
    requiredChain,
    totalCustomerOutflow,
  );

  const flowPending = isStandard ? standard.isPending : gasless.isPending;
  const gasQuoteReady = isStandard || gasQuote.data !== undefined;
  // 運営の赤字防止: merchant が 0 になるケースは送信を block。
  //   gasless / customer:  total < fee → merchant = 0
  //   gasless / merchant:  total < fee + gas → merchant = 0
  //   standard:            total < fee (0.5%) → merchant = 0
  const merchantUnderflow =
    totalWei > 0n &&
    (isStandard || !isMerchantGas || gasQuote.data !== undefined) &&
    breakdown.merchantReceives === 0n;
  const minimumAmountWei =
    breakdown.feeAmount + (isMerchantGas ? (gasAmount ?? 0n) : 0n);

  const canSubmit =
    isConnected &&
    !wrongChain &&
    (isStandard || !!saData) &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !flowPending &&
    gasQuoteReady &&
    !merchantUnderflow;

  const flowError = isStandard ? standard.error : gasless.error;
  const saFallback = !isStandard && isIncompatibleSmartAccountError(saError);
  const error = isGasCongestedError(flowError)
    ? t('errorGasCongested')
    : (flowError?.message ??
      (isStandard || saFallback ? undefined : saError?.message) ??
      (gasQuote.error ? t('errorGasQuote') : null) ??
      (merchantUnderflow
        ? t('errorMerchantUnderflow', { min: fmt(minimumAmountWei) })
        : null));

  const [redirectIn, setRedirectIn] = useState<number | null>(null);
  // PayPay 風 大型成功 overlay。dismiss 後は inline 成功 panel + redirect countdown を表示。
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  // R: gasQuote refetch (30s) で breakdown が再計算 → notification effect が再実行
  //    される。同一 tx hash の重複 webhook を防ぐため key 単位の dedup gate を使う。
  const notifiedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (gasless.error) logger.error('checkout.failed', { error: gasless.error });
  }, [gasless.error]);

  useEffect(() => {
    if (standard.error)
      logger.error('checkout.standard.failed', { error: standard.error });
  }, [standard.error]);

  useEffect(() => {
    if (saError) logger.error('checkout.smart-account.init-failed', { error: saError });
  }, [saError]);

  useEffect(() => {
    if (gasQuote.error) logger.error('checkout.gas-quote.failed', { error: gasQuote.error });
  }, [gasQuote.error]);

  // mode 中立な決済結果ビュー: notification dedup key、webhook payload の hash field、
  // success_url query の (snake_case) hash field を 1 箇所に集約。
  const completion = useMemo(() => {
    if (isStandard && standard.data) {
      return {
        key: standard.data.merchantTxHash,
        mode: 'standard' as const,
        blockNumber: standard.data.blockNumber,
        hashFields: {
          merchantTxHash: standard.data.merchantTxHash,
          feeTxHash: standard.data.feeTxHash,
        },
        redirectQuery: {
          tx_hash: standard.data.merchantTxHash,
          ...(standard.data.feeTxHash
            ? { fee_tx_hash: standard.data.feeTxHash }
            : {}),
        },
      };
    }
    if (!isStandard && gasless.data?.success) {
      return {
        key: gasless.data.userOpHash,
        mode: 'gasless' as const,
        blockNumber: gasless.data.blockNumber,
        hashFields: {
          txHash: gasless.data.txHash,
          userOpHash: gasless.data.userOpHash,
        },
        redirectQuery: {
          tx_hash: gasless.data.txHash,
          user_op_hash: gasless.data.userOpHash,
        },
      };
    }
    return null;
  }, [isStandard, gasless.data, standard.data]);

  useEffect(() => {
    if (!completion) return;
    if (notifiedKeyRef.current === completion.key) return;
    notifiedKeyRef.current = completion.key;

    logger.info('checkout.success', {
      mode: completion.mode,
      ...completion.hashFields,
      merchant: params.to,
      orderId: params.orderId,
      token: params.token,
      chain: chainSlug,
    });

    // webhook 失敗 (CORS 等) は logger.warn のみ。決済自体は成立しているため UI には出さない。
    if (params.webhook) {
      const payload = {
        type: 'openpay.checkout.success',
        mode: completion.mode,
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
        ...completion.hashFields,
        blockNumber: completion.blockNumber.toString(),
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

    if (params.successUrl) {
      setRedirectIn(SUCCESS_REDIRECT_DELAY_MS / 1000);
    }
  }, [
    completion,
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

  // ローカル履歴 (Phase 2) — gasless / standard 全 5 transition を hook で集約。
  // note には description (なければ orderId) を入れ、CSV/UI で会計補助情報に使う。
  const historyCtx = useMemo(
    () => ({
      chainId: deployment.chainId,
      chainSlug,
      asset: params.token,
      tokenAddress: deployment.address,
      payMode: isStandard ? ('standard' as const) : ('gasless' as const),
      gasMode: isStandard ? null : params.gas,
      merchant: params.to,
      merchantAmount: breakdown.merchantReceives,
      customer: address,
      feeReceiver: env.feeReceiver,
      feeAmount: breakdown.feeAmount,
      storeName: '',
      note: params.description ?? params.orderId ?? '',
    }),
    [
      deployment.chainId,
      deployment.address,
      chainSlug,
      params.token,
      params.gas,
      params.to,
      params.description,
      params.orderId,
      isStandard,
      breakdown.merchantReceives,
      breakdown.feeAmount,
      address,
    ],
  );
  usePaymentHistory(historyCtx, gasless, standard);

  useEffect(() => {
    if (redirectIn === null) return;
    if (redirectIn <= 0) {
      doRedirect();
      return;
    }
    const id = setTimeout(() => setRedirectIn((v) => (v === null ? null : v - 1)), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doRedirect は意図的に除外 (含めると毎 render でタイマーがリセットされる)
  }, [redirectIn]);

  function doRedirect() {
    if (!params.successUrl || !completion) return;
    const u = new URL(params.successUrl);
    for (const [k, v] of Object.entries(completion.redirectQuery)) {
      u.searchParams.set(k, v);
    }
    u.searchParams.set('block', completion.blockNumber.toString());
    if (params.orderId) u.searchParams.set('order_id', params.orderId);
    u.searchParams.set('chain', chainSlug);
    u.searchParams.set('token', params.token);
    u.searchParams.set('mode', completion.mode);
    setRedirectIn(null);
    // Next.js の router は同一オリジンのみ。success_url は外部 URL なので window.location.assign。
    window.location.assign(u.toString());
  }

  function onSubmit() {
    if (!canSubmit) return;
    if (isStandard) {
      standard.mutate({
        tokenAddress: deployment.address,
        merchant: params.to,
        merchantAmount: breakdown.merchantReceives,
        feeReceiver: env.feeReceiver,
        feeAmount: breakdown.feeAmount,
        chainId: deployment.chainId,
      });
    } else {
      gasless.mutate({
        tokenAddress: deployment.address,
        merchant: params.to,
        merchantAmount: breakdown.merchantReceives,
        feeReceiver: env.feeReceiver,
        feeAmount: breakdown.feeAmount + gasReimbursement,
      });
    }
  }

  const explorerBase = blockExplorerUrl(deployment.chainId);
  const approvalCheckUrl =
    isErc20Paymaster && address && explorerBase
      ? `${explorerBase}/tokenapprovalchecker?search=${address}`
      : undefined;

  const completed = isStandard
    ? !!standard.data
    : !!(gasless.data && gasless.data.success);

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
          {requiredChain.name} · {deployment.displaySymbol} ·{' '}
          {isStandard ? t('modeBadgeStandard') : t('modeBadgeGasless')}
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
            {/* fee=0 のとき手数料行は非表示 (Phase 1 alpha)。 */}
            {breakdown.feeAmount > 0n && (
              <Row label={t('feeRow')} value={fmt(breakdown.feeAmount)} />
            )}
            {isStandard ? (
              <Row label={t('gasRowStandard')} value={t('gasRowStandardValue')} />
            ) : (
              <Row
                label={isMerchantGas ? t('gasRowMerchant') : t('gasRow')}
                labelExtra={
                  <InfoTooltip
                    text={
                      isErc20Paymaster
                        ? t('gasInfoUsdc', { nativeToken })
                        : t('gasInfoJpyc', { nativeToken })
                    }
                  />
                }
                value={
                  gasAmount !== undefined
                    ? t('gasRowValue', { amount: fmt(gasAmount) })
                    : t('gasRowPending')
                }
              />
            )}
            <div className="my-1 border-t border-slate-200" />
            <Row
              label={
                isStandard
                  ? t('totalRowStandard', { nativeToken })
                  : isMerchantGas
                    ? t('totalRowMerchantGas')
                    : t('totalRow')
              }
              value={fmt(totalCustomerOutflow)}
              strong
            />
          </dl>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {isStandard
            ? t('standardHint', { nativeToken })
            : isErc20Paymaster
              ? t('gaslessHintUsdc')
              : t('gaslessHintJpyc')}
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

      {saFallback && (
        <SmartAccountFallbackBanner
          delegateAddress={saError.delegateAddress}
          nativeToken={nativeToken}
          reason={
            saError.i18nKey === 'errorPristineNoBootstrap'
              ? 'pristine'
              : 'incompatible'
          }
          canFallbackToStandard
          onSwitchToStandard={() => setModeOverride('standard')}
        />
      )}

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

          {isConnected && !wrongChain && balance !== undefined && (
            <p className="text-xs text-slate-500">
              {t('balanceLabel')}{' '}
              <span className="font-mono">{fmt(balance)}</span>
            </p>
          )}

          {insufficientBalance && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <p>
                {t('insufficientBalance', {
                  amount: fmt(totalCustomerOutflow),
                })}
              </p>
              <OnrampCta token={params.token} namespace="CheckoutForm" />
            </div>
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
          {flowPending
            ? isStandard
              ? checkoutPhaseLabel(standard.phase, t)
              : t('btnSending')
            : !isConnected
              ? t('btnConnect')
              : wrongChain
                ? t('btnSwitchChain')
                : !isStandard && !saData
                  ? t('btnSaInit')
                  : !gasQuoteReady
                    ? t('btnGasQuoteLoading')
                    : t('btnPay', { amount: fmt(totalCustomerOutflow) })}
        </button>
      )}

      {/* standard モードで fee tx だけ失敗した場合の retry UI (merchant 確定済)。 */}
      {!completed && isStandard && standard.isFeeError && (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{t('standardFeeRetryTitle')}</p>
          <p className="text-xs">{t('standardFeeRetryBody')}</p>
          <button
            type="button"
            onClick={() => standard.retryFee()}
            className="w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
          >
            {t('standardFeeRetryButton')}
          </button>
        </div>
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

      {completed && (gasless.data || standard.data) && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <p className="font-semibold">{t('successTitle')}</p>
          <p className="mt-1 text-xs">{t('successBody')}</p>
          <dl className="mt-3 space-y-1 text-xs">
            {!isStandard && gasless.data && (
              <>
                <ResultRow
                  label={t('successUserOp')}
                  value={gasless.data.userOpHash}
                  copyable
                />
                <ResultRow
                  label={t('successTx')}
                  value={gasless.data.txHash}
                  copyable
                />
                <ResultRow
                  label={t('successBlock')}
                  value={gasless.data.blockNumber.toString()}
                />
              </>
            )}
            {isStandard && standard.data && (
              <>
                <ResultRow
                  label={t('standardMerchantTxLabel')}
                  value={standard.data.merchantTxHash}
                  copyable
                />
                {standard.data.feeTxHash && (
                  <ResultRow
                    label={t('standardFeeTxLabel')}
                    value={standard.data.feeTxHash}
                    copyable
                  />
                )}
                <ResultRow
                  label={t('successBlock')}
                  value={standard.data.blockNumber.toString()}
                />
              </>
            )}
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

      {/* PayPay 風 大型成功 overlay。dismiss 後は inline panel + redirect countdown を表示。
          success_url 指定時は overlay 表示中も 3 秒 countdown が並走する仕様。 */}
      {!overlayDismissed && completed && !isStandard && gasless.data && (
        <SuccessOverlay
          amountDisplay={fmt(totalCustomerOutflow)}
          txHash={gasless.data.txHash}
          userOpHash={gasless.data.userOpHash}
          blockNumber={gasless.data.blockNumber}
          explorerBase={explorerBase}
          merchantAddress={params.to}
          onDismiss={() => setOverlayDismissed(true)}
        />
      )}
      {!overlayDismissed && completed && isStandard && standard.data && (
        <SuccessOverlay
          amountDisplay={fmt(totalCustomerOutflow)}
          txHash={standard.data.merchantTxHash}
          blockNumber={standard.data.blockNumber}
          explorerBase={explorerBase}
          merchantAddress={params.to}
          onDismiss={() => setOverlayDismissed(true)}
        />
      )}
    </div>
  );
}

function checkoutPhaseLabel(
  phase: ReturnType<typeof useStandardPayment>['phase'],
  t: ReturnType<typeof useTranslations<'CheckoutForm'>>,
): string {
  switch (phase) {
    case 'merchant-sending':
      return t('btnStandardMerchantSending');
    case 'merchant-mining':
      return t('btnStandardMerchantMining');
    case 'fee-sending':
      return t('btnStandardFeeSending');
    case 'fee-mining':
      return t('btnStandardFeeMining');
    default:
      return t('btnSending');
  }
}

