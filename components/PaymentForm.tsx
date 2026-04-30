'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { erc20Abi, parseUnits } from 'viem';
import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { CopyableField } from './CopyableField';
import { InfoTooltip } from './InfoTooltip';
import { Row } from './Row';
import { SuccessOverlay } from './SuccessOverlay';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useDirectPayment } from '@/hooks/useDirectPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useGasQuote } from '@/hooks/useGasQuote';
import { useAutoSwitchChain } from '@/hooks/useAutoSwitchChain';
import {
  calcBreakdown,
  calcDirectBreakdown,
  calcSplitBreakdown,
} from '@/lib/fee';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { logger } from '@/lib/logger';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import { DECIMAL_PATTERN, parsePayParams, type PayParams } from '@/lib/url';
import { formatTokenAmount, shortAddress } from '@/lib/format';

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
  // parsePayParams は chain を常に解決するが、型上は optional。安全側で default に倒す。
  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const paymasterMode = resolvePaymasterMode(deployment);
  const isErc20Paymaster = !isDirect && paymasterMode === 'erc20';
  const isSponsorship = !isDirect && paymasterMode === 'sponsorship';

  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // Smart Account は gasless のみ必要 — direct では enabled=false で skip。
  const { data: saData, error: saError } = useSmartAccount(
    deployment,
    !isDirect,
  );

  // 両方のフックを常に call し、isDirect で送信先を分岐 (条件付きフックは禁止)。
  const gasless = useBatchPayment(deployment);
  const direct = useDirectPayment();
  const gasQuote = useGasQuote(deployment, !isDirect);

  const fixedAmount = params.amount ?? '';
  const isFixed = fixedAmount.length > 0;
  const [inputAmount, setInputAmount] = useState('');
  const amountStr = isFixed ? fixedAmount : inputAmount;
  // 成功時の大型 overlay (PayPay 風) を 1 度ユーザが閉じたら以降は inline panel のみ
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  const amountWei = useMemo(() => {
    if (!amountStr || !DECIMAL_PATTERN.test(amountStr)) return 0n;
    return parseUnits(amountStr, deployment.decimals);
  }, [amountStr, deployment.decimals]);

  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  const isMerchantGas = !isDirect && params.gas === 'merchant';

  // gas 見積 (両 paymaster mode で表示・計算に使用):
  //   ERC20 Paymaster (USDC): paymaster が顧客 USDC から actualGas を別途徴収。
  //   Sponsorship (JPYC): Pimlico が POL gas を立替、運営は徴収した JPYC で別途精算。
  const gasAmount = !isDirect ? gasQuote.data?.gasAmount : undefined;

  const breakdown = useMemo(
    () =>
      isDirect
        ? calcDirectBreakdown(amountWei)
        : calcBreakdown(amountWei, params.token, params.gas, gasAmount ?? 0n),
    [isDirect, amountWei, params.token, params.gas, gasAmount],
  );

  // direct mode では split は無視 (シンプルな単一 transfer に限定)。
  const splitBreakdown = useMemo(() => {
    if (isDirect || !params.split || params.split.length === 0) return null;
    return calcSplitBreakdown(
      amountWei,
      params.token,
      params.to,
      params.split,
      params.gas,
      gasAmount ?? 0n,
    );
  }, [
    isDirect,
    amountWei,
    params.token,
    params.to,
    params.split,
    params.gas,
    gasAmount,
  ]);

  // 顧客支払額: calcBreakdown が gasMode を考慮済 (customer なら +gas、merchant なら amount のまま)
  const totalCustomerOutflow = splitBreakdown
    ? splitBreakdown.customerPays
    : breakdown.customerPays;

  // Sponsorship 時は fee transfer に gas を含める。ERC20 Paymaster 時は fee のみ
  // (gas は paymaster が顧客から自動徴収するため二重徴収を避ける)。
  const gasReimbursement = isSponsorship ? (gasAmount ?? 0n) : 0n;

  // 運営の赤字防止: merchant が 0 になるケースは送信を block。
  //   customer mode: amount < fee → merchant = 0
  //   merchant mode: amount < fee + gas → merchant = 0
  //   merchant mode の判定には gasQuote の load 完了が必要。
  const merchantUnderflow =
    !isDirect &&
    amountWei > 0n &&
    (isMerchantGas ? gasQuote.data !== undefined : true) &&
    breakdown.merchantReceives === 0n;
  const minimumAmountWei =
    breakdown.feeAmount + (isMerchantGas ? (gasAmount ?? 0n) : 0n);

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
  useAutoSwitchChain(requiredChain.id, wrongChain);

  const flowPending = isDirect ? direct.isPending : gasless.isPending;
  const gasQuoteReady = isDirect || gasQuote.data !== undefined;
  const canSubmit =
    isConnected &&
    !wrongChain &&
    (isDirect || !!saData) &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !flowPending &&
    gasQuoteReady &&
    !merchantUnderflow;

  // gas congested は gasless モード固有の早期 abort。i18n された案内文に
  // 差し替え (direct モードは paymaster を経由しないため対象外)。
  // gasQuote の失敗は Pimlico RPC エラーで生表示するとユーザに技術詳細が
  // 漏れるため、i18n 化した friendly メッセージに置き換える (詳細は logger 経由で Sentry へ)。
  const flowError = isDirect ? direct.error : gasless.error;
  const error = isGasCongestedError(flowError)
    ? t('errorGasCongested')
    : (flowError?.message ??
      (isDirect ? undefined : saError?.message) ??
      (gasQuote.error ? t('errorGasQuote') : null) ??
      (merchantUnderflow
        ? t('errorMerchantUnderflow', { min: fmt(minimumAmountWei) })
        : null));

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
    if (gasQuote.error) logger.error('payment.gas-quote.failed', { error: gasQuote.error });
  }, [gasQuote.error]);

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
        tokenAddress: deployment.address,
        merchant: params.to,
        amount: breakdown.customerPays,
        chainId: deployment.chainId,
      });
    } else if (splitBreakdown) {
      // recipients[0] は primary (params.to)、それ以降が split entries
      const [primary, ...extras] = splitBreakdown.recipients;
      gasless.mutate({
        tokenAddress: deployment.address,
        merchant: primary.to,
        merchantAmount: primary.amount,
        feeReceiver: env.feeReceiver,
        feeAmount: splitBreakdown.feeAmount + gasReimbursement,
        extraRecipients: extras.map((e) => ({ to: e.to, amount: e.amount })),
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

  // direct モードのときネイティブ ガスが何かを表示するため。
  // JPYC は Polygon のみ (POL)、それ以外 (USDC) は対応 4 chain 全て ETH 系ガス。
  const directNativeToken = params.token === 'jpyc' ? 'POL' : 'ETH';

  // ERC20 Paymaster の Token Approval Checker リンク (chain 別 explorer)。
  // Etherscan 系 (basescan / arbiscan / optimistic.etherscan / polygonscan) は
  // /tokenapprovalchecker パスを共通で持つ。
  const explorerBase = blockExplorerUrl(deployment.chainId);
  const approvalCheckUrl =
    isErc20Paymaster && address && explorerBase
      ? `${explorerBase}/tokenapprovalchecker?search=${address}`
      : undefined;

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
              {fixedAmount} {deployment.displaySymbol}
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
                placeholder={deployment.symbol === 'jpyc' ? '1000' : '10.00'}
                className="w-full rounded-lg bg-white/15 px-3 py-2 text-2xl font-bold text-white placeholder:text-white/50 focus:bg-white/20 focus:outline-none"
              />
              <p className="mt-1 text-xs opacity-70">
                {t('amountInputHint', { symbol: deployment.displaySymbol })}
              </p>
            </div>
          )}
        </div>
      </header>

      {isDirect && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{t('directWarningTitle')}</p>
          <p className="mt-1 text-xs">
            {t('directWarningBody', { nativeToken: directNativeToken })}
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
                  { percent: r.percent, addr: shortAddress(r.to) },
                )}
                value={fmt(r.amount)}
              />
            ))
          ) : (
            <Row
              label={isDirect ? t('merchantRow') : t('merchantRowAfterFee')}
              value={fmt(breakdown.merchantReceives)}
            />
          )}
          {!isDirect && (
            <Row
              label={t('feeRow')}
              value={fmt(
                splitBreakdown ? splitBreakdown.feeAmount : breakdown.feeAmount,
              )}
            />
          )}
          {!isDirect && (
            <Row
              label={isMerchantGas ? t('gasRowMerchant') : t('gasRow')}
              labelExtra={
                <InfoTooltip
                  text={isErc20Paymaster ? t('gasInfoUsdc') : t('gasInfoJpyc')}
                />
              }
              value={
                gasAmount !== undefined
                  ? t('gasRowValue', { amount: fmt(gasAmount) })
                  : t('gasRowPending')
              }
            />
          )}
          <div className="my-2 border-t border-slate-200" />
          <Row
            label={
              isDirect
                ? t('customerDirect')
                : isMerchantGas
                  ? t('customerMerchantGas')
                  : t('customerCustomerGas')
            }
            value={fmt(totalCustomerOutflow)}
            strong
          />
        </dl>
        {isMerchantGas && (
          <p className="mt-3 text-xs text-emerald-700">
            {t('merchantGasHint')}
          </p>
        )}
        <p className="mt-4 text-xs text-slate-500">
          {isDirect
            ? t('directBatchHint')
            : splitBreakdown
              ? t('splitBatchHint', {
                  count: splitBreakdown.recipients.length,
                })
              : isErc20Paymaster
                ? t('gaslessBatchHintUsdc')
                : t('gaslessBatchHintJpyc')}
        </p>
        {approvalCheckUrl && (
          <p className="mt-2 text-xs">
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
              amount: fmt(totalCustomerOutflow),
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
                : !gasQuoteReady
                  ? t('btnGasQuoteLoading')
                  : breakdown.customerPays === 0n
                    ? t('btnEnterAmount')
                    : t('btnPay', { amount: fmt(totalCustomerOutflow) })}
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
            { label: t('successUserOp'), value: gasless.data.userOpHash, copyable: true },
            { label: t('successTx'), value: gasless.data.txHash, copyable: true },
            { label: t('successBlock'), value: gasless.data.blockNumber.toString() },
          ]}
        />
      )}

      {isDirect && direct.data && (
        <ResultPanel
          title={t('successTitle')}
          rows={[
            { label: t('successTx'), value: direct.data.txHash, copyable: true },
            { label: t('successBlock'), value: direct.data.blockNumber.toString() },
          ]}
        />
      )}

      {/* PayPay 風 大型成功 overlay。dismiss するまで全画面で「決済完了」+ 金額 + 時刻表示。 */}
      {!overlayDismissed && !isDirect && gasless.data && gasless.data.success && (
        <SuccessOverlay
          amountDisplay={fmt(totalCustomerOutflow)}
          txHash={gasless.data.txHash}
          userOpHash={gasless.data.userOpHash}
          blockNumber={gasless.data.blockNumber}
          explorerBase={explorerBase}
          onDismiss={() => setOverlayDismissed(true)}
        />
      )}
      {!overlayDismissed && isDirect && direct.data && (
        <SuccessOverlay
          amountDisplay={fmt(totalCustomerOutflow)}
          txHash={direct.data.txHash}
          blockNumber={direct.data.blockNumber}
          explorerBase={explorerBase}
          onDismiss={() => setOverlayDismissed(true)}
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
  // copyable=true の row はクリックで clipboard コピー可能 (tx hash 等の長い文字列向け)
  rows: Array<{ label: string; value: string; copyable?: boolean }>;
}) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
      <p className="font-semibold">{title}</p>
      <dl className="mt-2 space-y-1 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-2">
            <dt className="opacity-70">{r.label}</dt>
            <dd className="min-w-0 flex-1 text-right">
              {r.copyable ? (
                <CopyableField value={r.value} label={r.label} />
              ) : (
                <span className="break-all font-mono">{r.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
