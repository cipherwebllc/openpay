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
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor, relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
import { calcBreakdown, calcSplitBreakdown } from '@/lib/fee';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { isIncompatibleSmartAccountError } from '@/lib/accountDetection';
import { logger } from '@/lib/logger';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { resolvePaymasterMode } from '@/lib/pimlico';
import {
  counterpartSymbol,
  DEFAULT_CHAIN_FOR_SYMBOL,
  deploymentForSlug,
} from '@/lib/tokens';
import {
  DECIMAL_PATTERN,
  exceedsTokenPrecision,
  parsePayParams,
  type PayParams,
} from '@/lib/url';
import { formatRemaining, isExpired, secondsRemaining } from '@/lib/fx';
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

  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // JPYC ガスレスを EIP-3009 relay に倒すか (flag ON + JPYC + Polygon)。OFF は 'pimlico-7702'
  // で既存挙動 (memory:jpyc-eip3009)。relay 経路は smart account / gas quote 不要で、顧客が
  // 署名するだけ・Gelato がガス負担。
  // Phase 1 relay は単発 transfer のみ。split 指定時は従来の 7702 経路へ倒す (split 対応は Phase 2)。
  const hasSplit = !!params.split && params.split.length > 0;
  const useRelay =
    !isStandard &&
    !hasSplit &&
    resolveJpycGaslessProvider(deployment, chainId ?? deployment.chainId) ===
      'eip3009-relay';
  const relay = useJpycEip3009Payment(deployment);

  // recover: forwarder 設定済 chain は gas 相当額を JPYC 回収 (gasMode で顧客上乗せ/店主吸収)。
  // 未設定は free (OpenPay 負担)。relayGasEquiv は回収する固定 gas 相当額 (free は 0)。
  const useRecover =
    useRelay && jpycForwarderFor(chainId ?? deployment.chainId) !== null;
  const relayGasEquiv = useRecover ? relayGasFeeValue() : 0n;

  // Smart Account は gasless (非 relay) のみ必要 — standard / relay では enabled=false で skip。
  const { data: saData, error: saError } = useSmartAccount(
    deployment,
    !isStandard && !useRelay,
  );

  // 全フックを常に call し、mode で送信先を分岐 (条件付きフックは禁止)。relay 経路は
  // smart account / gas quote 不要なので enabled=false で skip する。
  const gasless = useBatchPayment(deployment, !isStandard && !useRelay);
  const standard = useStandardPayment();
  const gasQuote = useGasQuote(deployment, !isStandard && !useRelay);
  // USDC ガスレスが Circle Paymaster に解決される場合は surcharge 込みの quote +
  // permit allowance を Circle 専用フックから取る (provider は flag/allowlist/fee で決まる)。
  const isCircle =
    !isStandard &&
    resolveUsdcGaslessProvider(deployment, deployment.chainId) === 'circle';
  const circleQuote = useGasQuoteCircle(deployment, !isStandard && isCircle);
  // 表示・readiness・error は circle のときは circleQuote を本線にする。
  const activeQuote = isCircle ? circleQuote : gasQuote;
  // Circle 経路で useBatchPayment に渡す permit allowance 上限 (未取得なら undefined)。
  const circlePermitAmount = isCircle ? circleQuote.data?.permitAmount : undefined;

  const fixedAmount = params.amount ?? '';
  const isFixed = fixedAmount.length > 0;
  const [inputAmount, setInputAmount] = useState('');
  const amountStr = isFixed ? fixedAmount : inputAmount;
  // 成功時の大型 overlay (PayPay 風) を 1 度ユーザが閉じたら以降は inline panel のみ
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  // 動的 QR の有効期限。exp 付き QR (FX 換算で生成) のみカウントダウン + 期限切れ block。
  // exp 無し (通常 QR) では nowMs=0 のまま・expired=false で従来挙動。
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (params.expiresAt === undefined) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [params.expiresAt]);
  // nowMs は effect (client) で初めて実時刻になる。計測前 (nowMs=0) は expired=false に
  // 固定し、submit は下記 canSubmit の (expiresAt undefined || nowMs>0) で計測後に限定する
  // ことで「既に期限切れの QR を初回フレームで送信される」窓を塞ぐ。SSR/hydration では
  // 両者 nowMs=0 で一致 (countdown も nowMs>0 まで非表示) なので mismatch しない。
  const timeMeasured = nowMs > 0;
  const expired = timeMeasured && isExpired(params.expiresAt, nowMs);
  const remainingSeconds = secondsRemaining(params.expiresAt, nowMs);
  // 顧客への文脈表示 (元の円価格 + レート)。anchor token は QR token の counterpart。
  const anchorDisplay = counterpartSymbol(params.token) === 'jpyc' ? 'JPYC' : 'USDC';

  const amountWei = useMemo(() => {
    if (!amountStr || !DECIMAL_PATTERN.test(amountStr)) return 0n;
    // 精度超過は parseUnits が黙って丸めて表示額と実送金額が乖離するため弾く (0n=送信 block)。
    if (exceedsTokenPrecision(amountStr, deployment.decimals)) return 0n;
    return parseUnits(amountStr, deployment.decimals);
  }, [amountStr, deployment.decimals]);
  // 精度超過を UI で明示するためのフラグ (amountWei は 0n になるが理由を伝える)。
  const amountPrecisionError =
    !!amountStr &&
    DECIMAL_PATTERN.test(amountStr) &&
    exceedsTokenPrecision(amountStr, deployment.decimals);

  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  const isMerchantGas = !isStandard && params.gas === 'merchant';

  // gas 見積 (gasless mode のみ):
  //   ERC20 Paymaster (USDC): paymaster が顧客 USDC から actualGas を別途徴収。
  //   Sponsorship (JPYC): Pimlico が POL gas を立替、運営は徴収した JPYC で別途精算。
  //   standard mode: 顧客 wallet が gas を自前で算定・支払うため OpenPay 側で見積らない。
  const gasAmount = !isStandard ? activeQuote.data?.gasAmount : undefined;
  // breakdown/会計に使う gas 相当額: relay は固定の回収額 (recover=fee / free=0)、
  // 非 relay は paymaster quote。relay は quote を持たないため effective で切り替える。
  const effectiveGasAmount: bigint | undefined = useRelay
    ? relayGasEquiv
    : gasAmount;

  const effectiveMode = isStandard ? 'standard' : params.mode;
  const breakdown = useMemo(
    () =>
      calcBreakdown(
        amountWei,
        params.token,
        effectiveMode,
        params.gas,
        effectiveGasAmount ?? 0n,
      ),
    [amountWei, params.token, effectiveMode, params.gas, effectiveGasAmount],
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
  // Circle 経路は顧客が permit で USDC gas を Circle paymaster に支払うため、sponsorship
  // 形式の gas 立替 reimbursement は加算しない (加算すると testnet で resolvePaymasterMode が
  // sponsorship に倒れる際に gas 二重徴収 + OpenPay 徴収0 違反になる)。
  const gasReimbursement = isSponsorship && !isCircle ? (gasAmount ?? 0n) : 0n;

  // 記録用ネットワーク手数料相当額 (会計分離・on-chain transfer とは別)。非 circle の
  // gasless 経路は gas 見積を計上する: JPYC sponsorship は立替回収 (= feeReceiver へ送る
  // gasReimbursement と同額)、USDC erc20 は paymaster が顧客 USDC から直接徴収する gas。
  // circle は receipt 由来の circlePaymasterNetUsdc を検証ステータス付きで使うため null、
  // standard は OpenPay が gas に touch しないため null。
  const networkFeeEquivalent =
    !isStandard && !isCircle ? (effectiveGasAmount ?? 0n) : null;

  // 運営の赤字防止: merchant が 0 になるケースは送信を block (fee>0 の Phase 2 で
  // 主に効く。fee=0 の現状で発火するのは gasless/merchant かつ amount < gas のみ)。
  //   gasless / customer:  amount < fee → merchant = 0
  //   gasless / merchant:  amount < fee + gas → merchant = 0 (gasQuote load 完了必須)
  //   standard:            amount < fee → merchant = 0
  // relay は固定 fee で見積待ちが無いので即判定可 (activeQuote ではなく useRelay で gate)。
  const merchantUnderflow =
    amountWei > 0n &&
    (isStandard || !isMerchantGas || useRelay || activeQuote.data !== undefined) &&
    breakdown.merchantReceives === 0n;
  const minimumAmountWei =
    breakdown.feeAmount + (isMerchantGas ? (effectiveGasAmount ?? 0n) : 0n);

  const { balance, insufficientBalance, wrongChain } = useErc20BalanceAndChain(
    deployment,
    requiredChain,
    totalCustomerOutflow,
  );

  const flowPending = isStandard
    ? standard.isPending
    : useRelay
      ? relay.isPending
      : gasless.isPending;
  // relay は gas quote も smart account も不要なので readiness は常に満たす。
  const gasQuoteReady = isStandard || useRelay || activeQuote.data !== undefined;
  // relay が成功 or pending (broadcast 済) の後の再送信を禁止。再送すると新しい nonce で
  // 2 件目の authorization を出すことになり、元の tx が確定すると二重支払いになる。
  // revert (確定失敗で送金未成立) は安全なので再試行を許す。
  const relaySettledNoRetry =
    useRelay && !!relay.data && (relay.data.success || !!relay.data.pending);
  const canSubmit =
    isConnected &&
    !wrongChain &&
    (isStandard || useRelay || !!saData) &&
    // merchantReceives > 0 を要求 (amount 未入力だと gasless では customerPays が
    // gas 分だけ正になり得るが、店舗送金額 0 の空 batch は無意味。hook 側でも
    // calls.length===0 を弾くが、UI でも button を無効化して金額入力を促す)。
    breakdown.merchantReceives > 0n &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !flowPending &&
    gasQuoteReady &&
    !merchantUnderflow &&
    !relaySettledNoRetry &&
    // 動的 QR の有効期限切れは支払いをブロック (固定レートが陳腐化しているため)。
    !expired &&
    // exp 付き QR は now 計測 (effect 後) まで送信不可 = 計測前 (expired=false) の
    // 初回フレームで既期限切れ QR が送信される窓を塞ぐ。
    (params.expiresAt === undefined || timeMeasured);

  // gas congested は gasless モード固有の早期 abort。i18n された案内文に
  // 差し替え (standard モードは paymaster を経由しないため対象外)。
  // gasQuote の失敗は Pimlico RPC エラーで生表示するとユーザに技術詳細が
  // 漏れるため、i18n 化した friendly メッセージに置き換える (詳細は logger 経由で Sentry へ)。
  const flowError = isStandard
    ? standard.error
    : useRelay
      ? relay.error
      : gasless.error;
  const saFallback =
    !isStandard && !useRelay && isIncompatibleSmartAccountError(saError);
  // 送信は成立したがチェーン上で revert したケース。gasless/relay は data.success===false、
  // standard は phase=*-error だが receipt 自体は成功 (status=reverted) なので Error が無い。
  // どれも success panel も error も出ず「無反応」に見える穴を、明示メッセージで塞ぐ。
  const revertedNoFeedback =
    (!isStandard && !useRelay && !!gasless.data && !gasless.data.success) ||
    (useRelay &&
      !!relay.data &&
      !relay.data.success &&
      !relay.data.pending) ||
    (isStandard &&
      (standard.isMerchantError || standard.isFeeError) &&
      !standard.error);
  // relay 経路の error は code 文字列 (rate_limited 等) なので friendly i18n に差し替える。
  const flowErrorMessage = useRelay
    ? flowError
      ? relayErrorMessage(flowError, t)
      : undefined
    : flowError?.message;
  const error = isGasCongestedError(flowError)
    ? t('errorGasCongested')
    : (flowErrorMessage ??
      (isStandard || useRelay || saFallback ? undefined : saError?.message) ??
      (activeQuote.error ? t('errorGasQuote') : null) ??
      (amountPrecisionError
        ? t('errorAmountPrecision', { decimals: deployment.decimals })
        : null) ??
      (merchantUnderflow
        ? t('errorMerchantUnderflow', { min: fmt(minimumAmountWei) })
        : null) ??
      (revertedNoFeedback ? t('errorReverted') : null));

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
    if (activeQuote.error) logger.error('payment.gas-quote.failed', { error: activeQuote.error });
  }, [activeQuote.error]);

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

  useEffect(() => {
    if (relay.error) logger.error('payment.relay.failed', { error: relay.error });
  }, [relay.error]);

  useEffect(() => {
    if (relay.data) {
      logger.info('payment.relay.success', {
        txHash: relay.data.txHash,
        success: relay.data.success,
      });
    }
  }, [relay.data]);

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
      saleAmount: amountWei,
      networkFeeEquivalent,
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
      amountWei,
      networkFeeEquivalent,
      address,
    ],
  );
  // relay 成功/失敗/pending を既存の gasless 履歴経路に流す合成 snapshot。relay は userOp/receipt
  // block を持たないため両者 null。amount は mutate() の variables で固定し drift を避ける。
  // recover は hook と同一式で split を再計算: feeAmount(=サービス料) は常に 0、ネットワーク手数料
  // 相当額 = 回収した gas (feeValue)、merchantAmount は customer 上乗せなら満額・merchant 吸収なら
  // 満額−fee、saleAmount は請求額 (value)。free は fee=0・netFee=0。pending は status='pending'。
  const relayHistoryGasless = useMemo(() => {
    const v = relay.variables;
    const fee = useRecover ? relayGasFeeValue() : 0n;
    const merchantAmount = v
      ? useRecover && v.gasMode === 'merchant'
        ? v.value - fee
        : v.value
      : 0n;
    return {
      data: relay.data
        ? {
            txHash: relay.data.txHash,
            userOpHash: null,
            blockNumber: null,
            success: relay.data.success,
            pending: relay.data.pending,
          }
        : undefined,
      error: relay.error,
      variables: v
        ? {
            merchantAmount,
            feeAmount: 0n,
            saleAmount: v.value,
            networkFeeEquivalent: fee,
          }
        : undefined,
    };
  }, [relay.data, relay.error, relay.variables, useRecover]);
  usePaymentHistory(
    historyCtx,
    useRelay ? relayHistoryGasless : gasless,
    standard,
  );

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
    } else if (useRelay) {
      // JPYC EIP-3009 relay: 顧客が transferWithAuthorization に署名 → Gelato が gas 負担で submit。
      // fee=0・gas は OpenPay 肩代わりなので、全額 (amountWei) をそのまま merchant へ単発送金。
      relay.mutate({ merchant: params.to, value: amountWei, gasMode: params.gas });
    } else if (splitBreakdown) {
      // recipients[0] は primary (params.to)、それ以降が split entries
      const [primary, ...extras] = splitBreakdown.recipients;
      gasless.mutate({
        tokenAddress: deployment.address,
        merchant: primary.to,
        merchantAmount: primary.amount,
        feeReceiver: env.feeReceiver,
        feeAmount: splitBreakdown.feeAmount,
        gasReimbursement,
        saleAmount: amountWei,
        networkFeeEquivalent: networkFeeEquivalent ?? undefined,
        extraRecipients: extras.map((e) => ({ to: e.to, amount: e.amount })),
        circlePermitAmount,
      });
    } else {
      gasless.mutate({
        tokenAddress: deployment.address,
        merchant: params.to,
        merchantAmount: breakdown.merchantReceives,
        feeReceiver: env.feeReceiver,
        feeAmount: breakdown.feeAmount,
        gasReimbursement,
        saleAmount: amountWei,
        networkFeeEquivalent: networkFeeEquivalent ?? undefined,
        circlePermitAmount,
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

      {/* 動的 QR (FX 換算) の文脈表示: 元の円価格 ≈ 請求トークン額 + 生成時レート + 残り時間。
          refAmt + fxRate が URL に在るときのみ。anchor token は QR token の counterpart。 */}
      {params.priceRefAmount && params.fxRate && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-700">
            {t('fxAnchorLine', {
              refAmt: params.priceRefAmount,
              anchorSymbol: anchorDisplay,
              amount: fixedAmount,
              symbol: deployment.displaySymbol,
            })}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {t('fxRateLine', { rate: params.fxRate })}
          </p>
          {params.expiresAt !== undefined &&
            timeMeasured &&
            (expired ? (
              <p className="mt-1 text-xs font-medium text-amber-700">
                {t('fxExpiredShort')}
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">
                {t('fxRemaining', { time: formatRemaining(remainingSeconds) })}
              </p>
            ))}
        </div>
      )}

      {/* 有効期限切れ: 固定レートが陳腐化しているため支払いをブロックし、再生成を促す。 */}
      {expired && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{t('expiredTitle')}</p>
          <p className="mt-1 text-xs">{t('expiredBody')}</p>
        </div>
      )}

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
          ) : useRecover ? (
            <Row
              label={isMerchantGas ? t('gasRowMerchant') : t('gasRow')}
              labelExtra={<InfoTooltip text={t('gasInfoJpycRecover')} />}
              value={fmt(relayGasEquiv)}
            />
          ) : useRelay ? (
            <Row
              label={t('gasRow')}
              labelExtra={<InfoTooltip text={t('gasInfoJpycRelay')} />}
              value={t('gasRowRelayFree')}
            />
          ) : (
            <Row
              label={isMerchantGas ? t('gasRowMerchant') : t('gasRow')}
              labelExtra={
                <InfoTooltip
                  text={
                    isCircle
                      ? t('gasInfoUsdcCircle', { nativeToken })
                      : isErc20Paymaster
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
            : useRecover
              ? t('gaslessBatchHintJpycRecover')
              : useRelay
                ? t('gaslessBatchHintJpycRelay')
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
            // 有効期限切れは代替 cross-chain 経路 (CrossChainHint 内の独自 Pay) も封じる。
            // これがないと main ボタンを block しても cross-chain chooser から支払えてしまう。
            enabled={params.crossChain !== false && !expired}
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
          : expired
            ? t('btnExpired')
            : !isConnected
            ? t('btnConnect')
            : wrongChain
              ? t('btnSwitchChain')
              : !isStandard && !useRelay && !saData
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

      {!isStandard && !useRelay && gasless.data && gasless.data.success && (
        <ResultPanel
          title={t('successTitle')}
          rows={[
            { label: t('successUserOp'), value: gasless.data.userOpHash, copyable: true },
            { label: t('successTx'), value: gasless.data.txHash, copyable: true },
            { label: t('successBlock'), value: gasless.data.blockNumber.toString() },
          ]}
        />
      )}

      {/* relay は userOp/block を持たないため Tx Hash のみ表示 (Explorer link は overlay 側)。 */}
      {useRelay && relay.data && relay.data.success && relay.data.txHash && (
        <ResultPanel
          title={t('successTitle')}
          rows={[{ label: t('successTx'), value: relay.data.txHash, copyable: true }]}
        />
      )}

      {/* relay pending: broadcast 済だが未確定。standard へ fallback させず「確認待ち」を表示
          (再送信は canSubmit の relaySettledNoRetry で禁止)。txHash があれば Explorer で追跡。 */}
      {useRelay && relay.data?.pending && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
          <p className="font-semibold">{t('pendingTitle')}</p>
          <p className="mt-1 break-words">{t('pendingBody')}</p>
          {relay.data.txHash && (
            <p className="mt-2 break-all font-mono text-xs">
              {relay.data.txHash}
              {explorerBase && (
                <>
                  {' · '}
                  <a
                    href={`${explorerBase}/tx/${relay.data.txHash}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-sans underline hover:text-sky-900"
                  >
                    {t('pendingExplorerLink')} ↗
                  </a>
                </>
              )}
            </p>
          )}
        </div>
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
      {!overlayDismissed &&
        !isStandard &&
        !useRelay &&
        gasless.data &&
        gasless.data.success && (
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
      {!overlayDismissed &&
        useRelay &&
        relay.data &&
        relay.data.success &&
        relay.data.txHash && (
        <SuccessOverlay
          amountDisplay={fmt(totalCustomerOutflow)}
          txHash={relay.data.txHash}
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

// JPYC relay (/api/relay/jpyc) の error code → 顧客向け i18n。検証系の細かな reason や
// 技術コード (signature_*/unsupported_chain/http_* 等) は generic に丸め、顧客が取れる
// アクションのある 3 種のみ専用文言にする。
function relayErrorMessage(
  err: Error,
  t: ReturnType<typeof useTranslations<'PaymentForm'>>,
): string {
  switch (err.message) {
    case 'rate_limited':
      return t('errorRelayRateLimited');
    case 'relay_not_configured':
      return t('errorRelayNotConfigured');
    case 'insufficient_balance':
      return t('errorRelayInsufficientBalance');
    default:
      return t('errorRelayGeneric');
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
