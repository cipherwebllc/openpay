'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { parseUnits } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { CrossChainHint } from './CrossChainHint';
import { SmartAccountFallbackBanner } from './SmartAccountFallbackBanner';
import { InfoTooltip } from './InfoTooltip';
import { OnrampCta } from './OnrampCta';
import { ResultRow } from './ResultRow';
import { Row } from './Row';
import { SuccessOverlay } from './SuccessOverlay';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useGasQuote } from '@/hooks/useGasQuote';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
import { calcBreakdown } from '@/lib/fee';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { isIncompatibleSmartAccountError } from '@/lib/accountDetection';
import { logger } from '@/lib/logger';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import { DECIMAL_PATTERN, DEFAULT_TIP_PRESETS, type TipParams } from '@/lib/url';
import { formatTokenAmount } from '@/lib/format';

const DEFAULT_THEME_COLOR = '#2563eb';

export function TipForm({ params }: { params: TipParams }) {
  const t = useTranslations('TipForm');
  // parseTipParams は chain を常に解決するが、型上は optional。安全側で default に倒す。
  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const paymasterMode = resolvePaymasterMode(deployment);
  const isErc20Paymaster = paymasterMode === 'erc20';
  const isSponsorship = paymasterMode === 'sponsorship';
  // ネイティブガストークン symbol (Polygon=POL / Kaia=KAIA / Base etc=ETH)。
  // gasInfoJpyc / gasInfoUsdc tooltip の {nativeToken} で使用。
  const nativeToken = requiredChain.nativeCurrency.symbol;
  const presets =
    params.presets && params.presets.length > 0
      ? params.presets
      : DEFAULT_TIP_PRESETS[params.token];
  const themeColor = params.color ?? DEFAULT_THEME_COLOR;
  const creatorName = params.name ?? '';
  const creatorMessage = params.message ?? '';

  const { address, isConnected } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  // TipForm は Circle 未配線 (useGasQuoteCircle / circlePermitAmount を持たない)。USDC tip が
  // Circle に routing されると useBatchPayment の circle 分岐が permitAmount 未算定で throw する
  // ため、disableCircle=true で Pimlico erc20 に固定する (JPYC は sponsorship なので非影響)。
  const { data: saData, error: saError } = useSmartAccount(deployment, true, true);
  // disableCircle=true を useBatchPayment にも渡す。これを渡さないと決済実行に使う内部
  // useSmartAccount が Circle に routing され、USDC tip が circlePermitAmount 不在で送信時に
  // throw する (saData 側だけ Pimlico でも実行 client は別)。
  const gasless = useBatchPayment(deployment, true, true);
  const gasQuote = useGasQuote(deployment);

  const [selectedPreset, setSelectedPreset] = useState<string | null>(
    presets[0] ?? null,
  );
  const [customAmount, setCustomAmount] = useState('');
  const customSelected = selectedPreset === null;
  // PayPay 風 大型成功 overlay (dismiss するまで全画面)
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  const amountStr = customSelected ? customAmount : (selectedPreset ?? '');
  const amountWei = useMemo(() => {
    if (!amountStr || !DECIMAL_PATTERN.test(amountStr)) return 0n;
    return parseUnits(amountStr, deployment.decimals);
  }, [amountStr, deployment.decimals]);

  // Tip widget は gasless / gas=customer 固定 (preset セマンティクス維持):
  // creator は preset - fee を受け取り、ファンは preset + gas を支払う。
  // standard mode (顧客 wallet で gas 自前負担) は creator-fan UX を崩すため
  // tip 文脈では非対応。URL で mode=standard が来ても無視して gasless で動かす。
  const gasAmount = gasQuote.data?.gasAmount;
  const breakdown = useMemo(
    () =>
      calcBreakdown(amountWei, params.token, 'gasless', 'customer', gasAmount ?? 0n),
    [amountWei, params.token, gasAmount],
  );

  // gas 軸:
  //   ERC20 Paymaster (USDC): paymaster が顧客 USDC から actualGas を別途徴収。
  //   Sponsorship (JPYC): Pimlico が立替、運営は徴収 JPYC で精算 (fee transfer に内包)。
  const totalCustomerOutflow = breakdown.customerPays;
  const gasReimbursement = isSponsorship ? (gasAmount ?? 0n) : 0n;
  // TipForm は常に gasless・非 circle (disableCircle)。記録用ネットワーク手数料相当額は gas
  // 見積 (JPYC sponsorship の立替回収 / USDC erc20 で paymaster が顧客から徴収する gas)。
  const networkFeeEquivalent = gasAmount ?? 0n;

  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  const { balance, insufficientBalance, wrongChain } = useErc20BalanceAndChain(
    deployment,
    requiredChain,
    totalCustomerOutflow,
  );

  const gasQuoteReady = gasQuote.data !== undefined;
  const canSubmit =
    isConnected &&
    !wrongChain &&
    !!saData &&
    // creator 受取 > 0 を要求 (custom amount 未入力だと gas 分で customerPays が
    // 正になり得るが、tip 額 0 の空 batch は無意味)。hook 側でも calls.length===0
    // を弾くが、UI でも button を無効化して金額入力を促す。
    breakdown.merchantReceives > 0n &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !gasless.isPending &&
    gasQuoteReady;

  // gas congested はチェーン別の早期 abort なので、生のエラーメッセージ
  // (デバッグ向け詳細) ではなく i18n された案内文に差し替える。
  // gasQuote の失敗も同様に i18n 化 (詳細は logger 経由で Sentry へ)。
  const saFallback = isIncompatibleSmartAccountError(saError);
  const error = isGasCongestedError(gasless.error)
    ? t('errorGasCongested')
    : (gasless.error?.message ??
      (saFallback ? undefined : saError?.message) ??
      (gasQuote.error ? t('errorGasQuote') : null));

  useEffect(() => {
    if (gasless.error) logger.error('tip.failed', { error: gasless.error });
  }, [gasless.error]);

  useEffect(() => {
    if (saError) logger.error('tip.smart-account.init-failed', { error: saError });
  }, [saError]);

  useEffect(() => {
    if (gasQuote.error) logger.error('tip.gas-quote.failed', { error: gasQuote.error });
  }, [gasQuote.error]);

  // userOpHash ごとに 1 回限りの webhook 発火。gasQuote の refetchInterval (30s)
  // で breakdown が再計算 → effect 再実行 → 二重発火を防ぐ gate。
  const notifiedUserOpHashRef = useRef<string | null>(null);

  useEffect(() => {
    if (!gasless.data || !gasless.data.success) return;
    if (notifiedUserOpHashRef.current === gasless.data.userOpHash) return;
    notifiedUserOpHashRef.current = gasless.data.userOpHash;
    logger.info('tip.success', {
      userOpHash: gasless.data.userOpHash,
      txHash: gasless.data.txHash,
      creator: params.to,
      amount: amountStr,
      token: params.token,
    });
    // webhook 失敗 (CORS / non-2xx) は logger.warn のみ。tip は成立しているため UI には出さない。
    // fetch の Promise は HTTP non-2xx でも resolve するため res.ok を明示確認。
    if (params.webhook) {
      const payload = {
        type: 'openpay.tip.success',
        creator: params.to,
        from: address,
        token: params.token,
        chain: chainSlug,
        amount: amountStr,
        merchantAmount: breakdown.merchantReceives.toString(),
        feeAmount: breakdown.feeAmount.toString(),
        customerPays: breakdown.customerPays.toString(),
        message: params.message,
        txHash: gasless.data.txHash,
        userOpHash: gasless.data.userOpHash,
        blockNumber: gasless.data.blockNumber.toString(),
        chainId: deployment.chainId,
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
            logger.warn('tip.webhook.non_ok', {
              status: res.status,
              statusText: res.statusText,
              url: params.webhook,
            });
          }
        })
        .catch((err) =>
          logger.warn('tip.webhook.failed', {
            error: err,
            url: params.webhook,
          }),
        );
    }
  }, [
    gasless.data,
    params.to,
    params.token,
    chainSlug,
    params.message,
    params.webhook,
    amountStr,
    address,
    breakdown.merchantReceives,
    breakdown.feeAmount,
    breakdown.customerPays,
    deployment.chainId,
  ]);

  function selectPreset(preset: string) {
    setSelectedPreset(preset);
    setCustomAmount('');
  }

  function selectCustom() {
    setSelectedPreset(null);
  }

  function onSubmit() {
    if (!canSubmit) return;
    gasless.mutate({
      tokenAddress: deployment.address,
      merchant: params.to,
      merchantAmount: breakdown.merchantReceives,
      feeReceiver: env.feeReceiver,
      // 利用手数料 (サービス料) と gas 立替回収を分離。feeReceiver への on-chain transfer は
      // useBatchPayment が両者を合算する (挙動不変)。会計記録は分離フィールドで残す。
      feeAmount: breakdown.feeAmount,
      gasReimbursement,
      saleAmount: amountWei,
      networkFeeEquivalent,
    });
  }

  const explorerBase = blockExplorerUrl(deployment.chainId);
  const approvalCheckUrl =
    isErc20Paymaster && address && explorerBase
      ? `${explorerBase}/tokenapprovalchecker?search=${address}`
      : undefined;

  return (
    <div className="space-y-4">
      <header
        className="rounded-2xl p-5 text-white shadow-sm"
        style={{ backgroundColor: themeColor }}
      >
        <p className="text-xs uppercase tracking-wider opacity-80">
          {t('header')}
        </p>
        <p className="mt-2 text-xl font-bold leading-tight">
          {creatorName
            ? t('headerNamed', { name: creatorName })
            : t('headerGeneric')}
        </p>
        {creatorMessage && (
          <p className="mt-2 whitespace-pre-wrap text-sm opacity-90">
            {creatorMessage}
          </p>
        )}
        <p className="mt-3 text-xs opacity-70">
          {requiredChain.name} · {deployment.displaySymbol}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('amountTitle')}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {presets.map((p) => {
            const active = !customSelected && selectedPreset === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => selectPreset(p)}
                className={`rounded-xl border px-2 py-3 text-center text-sm font-semibold transition ${
                  active
                    ? 'border-transparent text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                }`}
                style={active ? { backgroundColor: themeColor } : undefined}
              >
                {p} {deployment.displaySymbol}
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t('amountCustom')}
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={customAmount}
              onFocus={selectCustom}
              onChange={(e) => {
                setSelectedPreset(null);
                setCustomAmount(e.target.value.replace(/[^\d.]/g, ''));
              }}
              placeholder={
                params.token === 'jpyc'
                  ? t('amountCustomPlaceholderJpyc')
                  : t('amountCustomPlaceholderUsdc')
              }
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-lg font-semibold focus:outline-none"
              style={{ borderColor: customSelected ? themeColor : undefined }}
            />
          </label>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('breakdownTitle')}
        </p>
        <dl className="mt-2 space-y-1.5">
          <Row label={t('creatorRow')} value={fmt(breakdown.merchantReceives)} />
          {/* fee=0 のとき手数料行は非表示 (Phase 1 alpha)。 */}
          {breakdown.feeAmount > 0n && (
            <Row label={t('feeRow')} value={fmt(breakdown.feeAmount)} />
          )}
          <Row
            label={t('gasRow')}
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
          <div className="my-1 border-t border-slate-200" />
          <Row
            label={t('customerRow')}
            value={fmt(totalCustomerOutflow)}
            strong
          />
        </dl>
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

      {saFallback && (
        <SmartAccountFallbackBanner
          delegateAddress={saError.delegateAddress}
          nativeToken={nativeToken}
          reason={
            saError.i18nKey === 'errorPristineNoBootstrap'
              ? 'pristine'
              : 'incompatible'
          }
          canFallbackToStandard={false}
        />
      )}

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
            <OnrampCta token={params.token} namespace="TipForm" />
          </div>
        )}

        {/* Cross-chain hint: USDC かつ params.crossChain !== false の時のみ
            mounting (hint 内部でも guard あり)。fan が dest chain で USDC 不足
            だが他 chain / Gateway に balance がある時、Circle Gateway / CCTP V2
            経由の代替 path を提示する。JPYC は Gateway 非対応のため自動 skip
            (token guard で early return)。PaymentForm と同型実装。 */}
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
            // tip は常にガスレスモードだが、直接送金がガスレスなのは smart account が
            // 実際に構築済 (saData あり) の時のみ。pristine/未対応 fallback・init 失敗・
            // 取得中は gasless 不可なので「ガス代要」表示にする。
            directIsGasless={!!saData}
          />
        )}
      </section>

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className="w-full rounded-xl px-4 py-3 text-base font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50"
        style={{ backgroundColor: themeColor }}
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
                  : breakdown.merchantReceives === 0n
                    ? t('btnSelectAmount')
                    : t('btnSend', { amount: fmt(totalCustomerOutflow) })}
      </button>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <p className="font-semibold">{t('errorTitle')}</p>
          <p className="mt-1 break-words">{error}</p>
        </div>
      )}

      {gasless.data && gasless.data.success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
          <p className="font-semibold">{t('successTitle')}</p>
          {params.thanks && (
            <p className="mt-2 whitespace-pre-wrap text-sm">{params.thanks}</p>
          )}
          {params.thanksUrl && (
            <a
              href={params.thanksUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              {t('openLink')}
            </a>
          )}
          <dl className="mt-3 space-y-1">
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
          </dl>
        </div>
      )}

      {/* PayPay 風 大型成功 overlay。dismiss 後は上記の従来 panel (thanks 含む) を表示。 */}
      {!overlayDismissed && gasless.data && gasless.data.success && (
        <SuccessOverlay
          amountDisplay={fmt(totalCustomerOutflow)}
          txHash={gasless.data.txHash}
          userOpHash={gasless.data.userOpHash}
          blockNumber={gasless.data.blockNumber}
          explorerBase={explorerBase}
          onDismiss={() => setOverlayDismissed(true)}
        />
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

