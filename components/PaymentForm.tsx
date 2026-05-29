'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { parseUnits } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { PayEmptyLanding } from './PayEmptyLanding';
import { CopyableField } from './CopyableField';
import { InfoTooltip } from './InfoTooltip';
import { OnrampCta } from './OnrampCta';
import { CrossChainHint } from './CrossChainHint';
import { Row } from './Row';
import { SmartAccountFallbackBanner } from './SmartAccountFallbackBanner';
import { SuccessOverlay } from './SuccessOverlay';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useGasQuote } from '@/hooks/useGasQuote';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
import { calcBreakdown, calcSplitBreakdown } from '@/lib/fee';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { isIncompatibleSmartAccountError } from '@/lib/accountDetection';
import { logger } from '@/lib/logger';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import { DECIMAL_PATTERN, parsePayParams, type PayParams } from '@/lib/url';
import { formatTokenAmount, shortAddress } from '@/lib/format';

export function PaymentForm() {
  const search = useSearchParams();
  const parsed = useMemo(() => parsePayParams(search), [search]);
  const t = useTranslations('PaymentForm');

  if (!parsed.ok) {
    // bare /pay (query 一切なし) は誤訪問の可能性が高いので friendly landing を出す。
    // それ以外 (URL が半壊) は QR 生成側のバグなので赤エラーで原因を merchant に表示。
    if (parsed.errorKind === 'empty') return <PayEmptyLanding />;
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
  const [modeOverride, setModeOverride] = useState<'standard' | null>(null);
  const isStandard = params.mode === 'standard' || modeOverride === 'standard';
  // parsePayParams は chain を常に解決するが、型上は optional。安全側で default に倒す。
  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const paymasterMode = resolvePaymasterMode(deployment);
  const isErc20Paymaster = !isStandard && paymasterMode === 'erc20';
  const isSponsorship = !isStandard && paymasterMode === 'sponsorship';

  const { address, isConnected } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // Smart Account は gasless のみ必要 — standard では enabled=false で skip。
  const { data: saData, error: saError } = useSmartAccount(
    deployment,
    !isStandard,
  );

  // 両方のフックを常に call し、isStandard で送信先を分岐 (条件付きフックは禁止)。
  const gasless = useBatchPayment(deployment, !isStandard);
  const standard = useStandardPayment();
  const gasQuote = useGasQuote(deployment, !isStandard);

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

  const isMerchantGas = !isStandard && params.gas === 'merchant';

  // gas 見積 (gasless mode のみ):
  //   ERC20 Paymaster (USDC): paymaster が顧客 USDC から actualGas を別途徴収。
  //   Sponsorship (JPYC): Pimlico が POL gas を立替、運営は徴収した JPYC で別途精算。
  //   standard mode: 顧客 wallet が gas を自前で算定・支払うため OpenPay 側で見積らない。
  const gasAmount = !isStandard ? gasQuote.data?.gasAmount : undefined;

  const effectiveMode = isStandard ? 'standard' : params.mode;
  const breakdown = useMemo(
    () =>
      calcBreakdown(
        amountWei,
        params.token,
        effectiveMode,
        params.gas,
        gasAmount ?? 0n,
      ),
    [amountWei, params.token, effectiveMode, params.gas, gasAmount],
  );

  // standard mode では split は無視 (シンプルな EOA 直列 transfer に限定)。
  const splitBreakdown = useMemo(() => {
    if (isStandard || !params.split || params.split.length === 0) return null;
    return calcSplitBreakdown(
      amountWei,
      params.token,
      params.to,
      params.split,
      params.mode,
      params.gas,
      gasAmount ?? 0n,
    );
  }, [
    isStandard,
    amountWei,
    params.token,
    params.to,
    params.split,
    params.mode,
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

  // 運営の赤字防止: merchant が 0 になるケースは送信を block (fee>0 の Phase 2 で
  // 主に効く。fee=0 の現状で発火するのは gasless/merchant かつ amount < gas のみ)。
  //   gasless / customer:  amount < fee → merchant = 0
  //   gasless / merchant:  amount < fee + gas → merchant = 0 (gasQuote load 完了必須)
  //   standard:            amount < fee → merchant = 0
  const merchantUnderflow =
    amountWei > 0n &&
    (isStandard || !isMerchantGas || gasQuote.data !== undefined) &&
    breakdown.merchantReceives === 0n;
  const minimumAmountWei =
    breakdown.feeAmount + (isMerchantGas ? (gasAmount ?? 0n) : 0n);

  const { balance, insufficientBalance, wrongChain } = useErc20BalanceAndChain(
    deployment,
    requiredChain,
    totalCustomerOutflow,
  );

  const flowPending = isStandard ? standard.isPending : gasless.isPending;
  const gasQuoteReady = isStandard || gasQuote.data !== undefined;
  const canSubmit =
    isConnected &&
    !wrongChain &&
    (isStandard || !!saData) &&
    // merchantReceives > 0 を要求 (amount 未入力だと gasless では customerPays が
    // gas 分だけ正になり得るが、店舗送金額 0 の空 batch は無意味。hook 側でも
    // calls.length===0 を弾くが、UI でも button を無効化して金額入力を促す)。
    breakdown.merchantReceives > 0n &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !flowPending &&
    gasQuoteReady &&
    !merchantUnderflow;

  // gas congested は gasless モード固有の早期 abort。i18n された案内文に
  // 差し替え (standard モードは paymaster を経由しないため対象外)。
  // gasQuote の失敗は Pimlico RPC エラーで生表示するとユーザに技術詳細が
  // 漏れるため、i18n 化した friendly メッセージに置き換える (詳細は logger 経由で Sentry へ)。
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

  useEffect(() => {
    if (gasless.error) logger.error('payment.failed', { error: gasless.error });
  }, [gasless.error]);

  useEffect(() => {
    if (standard.error)
      logger.error('payment.standard.failed', { error: standard.error });
  }, [standard.error]);

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
    if (standard.data) {
      logger.info('payment.standard.success', {
        merchantTxHash: standard.data.merchantTxHash,
        feeTxHash: standard.data.feeTxHash,
      });
    }
  }, [standard.data]);

  // ローカル履歴 (Phase 2) — gasless / standard 全 5 transition を hook で集約。
  // 注: storeName は URL params に乗らないため空文字列。merchant 自身が自分の QR
  // で test 決済しても storeName は QrSettings 側に閉じており PaymentForm から
  // 見えない (将来 URL 拡張で乗せる余地あり、現状は CSV/UI に空欄で表示)。
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
      note: '',
    }),
    [
      deployment.chainId,
      deployment.address,
      chainSlug,
      params.token,
      params.gas,
      params.to,
      isStandard,
      breakdown.merchantReceives,
      breakdown.feeAmount,
      address,
    ],
  );
  usePaymentHistory(historyCtx, gasless, standard);

  function onSubmit() {
    if (!canSubmit) return;
    if (isStandard) {
      // standard mode: EOA から merchant transfer + fee transfer の 2 件直列。
      // split は標準モードでは無効化されているため breakdown を直接使う。
      standard.mutate({
        tokenAddress: deployment.address,
        merchant: params.to,
        merchantAmount: breakdown.merchantReceives,
        feeReceiver: env.feeReceiver,
        feeAmount: breakdown.feeAmount,
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

  // ネイティブガストークンの symbol を viem chain 経由で取得 (chain-aware)。
  // Polygon = POL / Kaia = KAIA / Base/Arbitrum/Optimism = ETH を自動 resolve。
  // standard モード説明 + gasInfoJpyc / gasInfoUsdc の tooltip {nativeToken}
  // placeholder の両方で使用する。
  const nativeToken = requiredChain.nativeCurrency.symbol;

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

      {isStandard && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{t('standardModeTitle')}</p>
          <p className="mt-1 text-xs">
            {t('standardModeBody', { nativeToken })}
          </p>
        </div>
      )}

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
              label={t('merchantRowAfterFee')}
              value={fmt(breakdown.merchantReceives)}
            />
          )}
          {/* fee=0 のとき手数料行は非表示 (Phase 1 alpha)。 */}
          {(splitBreakdown ? splitBreakdown.feeAmount : breakdown.feeAmount) >
            0n && (
            <Row
              label={t('feeRow')}
              value={fmt(
                splitBreakdown ? splitBreakdown.feeAmount : breakdown.feeAmount,
              )}
            />
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
          <div className="my-2 border-t border-slate-200" />
          <Row
            label={
              isStandard
                ? t('customerStandard', { nativeToken })
                : isMerchantGas
                  ? t('customerMerchantGas')
                  : t('customerCustomerGas')
            }
            value={fmt(totalCustomerOutflow)}
            strong
          />
        </dl>
        {isMerchantGas && !isStandard && (
          <p className="mt-3 text-xs text-emerald-700">
            {t('merchantGasHint')}
          </p>
        )}
        <p className="mt-4 text-xs text-slate-500">
          {isStandard
            ? t('standardBatchHint')
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

        {isConnected && !wrongChain && balance !== undefined && (
          <div className="text-xs text-slate-500">
            {t('balanceLabel')}{' '}
            <span className="font-mono">{fmt(balance)}</span>
          </div>
        )}

        {insufficientBalance && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            <p>
              {t('insufficientBalance', {
                amount: fmt(totalCustomerOutflow),
              })}
            </p>
            <OnrampCta token={params.token} namespace="PaymentForm" />
          </div>
        )}

        {/* Cross-chain hint: USDC かつ params.crossChain !== false の時のみ
            mounting (hint 内部でも guard あり)。target chain で balance 不足
            だが他 chain / Gateway に balance がある時、代替 path を提示する。
            JPYC は Gateway / CCTP V2 非対応のため自動 skip。 */}
        {params.token === 'usdc' && address && (
          <CrossChainHint
            token={params.token}
            enabled={params.crossChain !== false}
            targetChainId={requiredChain.id}
            recipient={params.to}
            requiredAtomic={amountWei}
            feeReceiver={env.feeReceiver}
            displayDecimals={deployment.decimals}
            tokenAddress={deployment.address}
            // 直接送金がガスレスなのは「ガスレスモード かつ smart account が実際に
            // 構築済 (saData あり)」時のみ。pristine/未対応の fallback、init 失敗、
            // 取得中はいずれも gasless 不可なので chooser でも「ガス代要」と表示する。
            directIsGasless={!isStandard && !!saData}
          />
        )}
      </section>

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className="w-full rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white shadow hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {flowPending
          ? isStandard
            ? phaseLabel(standard.phase, t)
            : t('btnSending')
          : !isConnected
            ? t('btnConnect')
            : wrongChain
              ? t('btnSwitchChain')
              : !isStandard && !saData
                ? t('btnSaInit')
                : !gasQuoteReady
                  ? t('btnGasQuoteLoading')
                  : breakdown.merchantReceives === 0n
                    ? t('btnEnterAmount')
                    : t('btnPay', { amount: fmt(totalCustomerOutflow) })}
      </button>

      {/* standard mode: merchant 確定 + fee 失敗のときに retry 用 button を表示。
           merchant への送金は確定済なので顧客に明示的に "あと 1 件 (手数料)" の再送を依頼。 */}
      {isStandard && standard.isFeeError && (
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

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-semibold">{t('errorTitle')}</p>
          <p className="mt-1 break-words">{error}</p>
        </div>
      )}

      {!isStandard && gasless.data && gasless.data.success && (
        <ResultPanel
          title={t('successTitle')}
          rows={[
            { label: t('successUserOp'), value: gasless.data.userOpHash, copyable: true },
            { label: t('successTx'), value: gasless.data.txHash, copyable: true },
            { label: t('successBlock'), value: gasless.data.blockNumber.toString() },
          ]}
        />
      )}

      {isStandard && standard.data && (
        <ResultPanel
          title={t('successTitle')}
          rows={[
            {
              label: t('standardMerchantTxLabel'),
              value: standard.data.merchantTxHash,
              copyable: true,
            },
            ...(standard.data.feeTxHash
              ? [
                  {
                    label: t('standardFeeTxLabel'),
                    value: standard.data.feeTxHash,
                    copyable: true,
                  },
                ]
              : []),
            { label: t('successBlock'), value: standard.data.blockNumber.toString() },
          ]}
        />
      )}

      {/* PayPay 風 大型成功 overlay。dismiss するまで全画面で「決済完了」+ 金額 + 時刻表示。 */}
      {!overlayDismissed && !isStandard && gasless.data && gasless.data.success && (
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
      {!overlayDismissed && isStandard && standard.data && (
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

// standard mode の phase → 「送信中」ボタンラベルの翻訳。
function phaseLabel(
  phase: ReturnType<typeof useStandardPayment>['phase'],
  t: ReturnType<typeof useTranslations<'PaymentForm'>>,
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
