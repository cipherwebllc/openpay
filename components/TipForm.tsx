'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { SmartAccountFallbackBanner } from './SmartAccountFallbackBanner';
import { InfoTooltip } from './InfoTooltip';
import { OnrampCta } from './OnrampCta';
import { Row } from './Row';
import type { SignReassuranceProps } from './SignReassurance';
import {
  PaymentSuccessOverlay,
  type PaymentSuccessOverlayPayload,
} from './PaymentSuccessOverlay';

// First Load JS から外すための遅延ロード (bundle 予算)。いずれも client 専用で
// 条件付き表示 (cross-chain hint = USDC 接続時 / success overlay・受領控え = 決済成功後 /
// payment status = 送信後の pending・unknown 時) のため SSR 不要。挙動は静的 import と同一。
const CrossChainHint = dynamic(
  () => import('./CrossChainHint').then((m) => m.CrossChainHint),
  { ssr: false },
);
const TipSuccessPanel = dynamic(
  () =>
    import('./TipSuccessPanel').then((m) => m.TipSuccessPanel),
  { ssr: false },
);
const PaymentStatusPanel = dynamic(
  () =>
    import('./PaymentStatusPanel').then((m) => m.PaymentStatusPanel),
  { ssr: false },
);
const SignReassurance = dynamic(
  () => import('./SignReassurance').then((m) => m.SignReassurance),
);
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useGasQuote } from '@/hooks/useGasQuote';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
import { useTipAmount } from '@/hooks/useTipAmount';
import {
  effectiveGasAmount as deriveEffectiveGasAmount,
  paymentBreakdown,
  gasReimbursementValue,
  networkFeeEquivalentValue,
} from '@/lib/paymentMoney';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { primeChimeAudio } from '@/lib/successChime';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { isIncompatibleSmartAccountError } from '@/lib/accountDetection';
import { logger } from '@/lib/logger';
import { redactUrlForTelemetry } from '@/lib/telemetryRedaction';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import {
  resolvePaymentRoute,
  isRelayRoute,
  isRecoverRoute,
  isCircleRoute,
} from '@/lib/paymentRoute';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
import {
  isFallbackSafeRelayError,
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import {
  DEFAULT_TIP_PRESETS,
  offOriginCallbackHosts,
  parseTipPreset,
  type TipParams,
} from '@/lib/url';
import { useOrigin } from '@/hooks/useOrigin';
import type { ExecuteResult } from '@/hooks/useCrossChainPayment';
import { formatTokenAmount } from '@/lib/format';
import { appendPayerReceipt, buildPayerReceipt } from '@/lib/payerReceipt';
import { computeCrossChainFeeSplit } from '@/lib/crossChain/feeSplit';
import {
  buildJpycRelaySignPreview,
  buildJpycRecoverSignPreview,
} from '@/lib/signPreview';
import { RecoverFeeNotice } from './RecoverFeeNotice';
import { tipFormTheme } from '@/lib/tipFormTheme';

const DEFAULT_THEME_COLOR = '#2563eb';
const TIP_MESSAGE_MIN_WEI = 10n ** 18n;

export function TipForm({
  params,
  preview = false,
}: {
  params: TipParams;
  preview?: boolean;
}) {
  const t = useTranslations('TipForm');
  const locale = useLocale();
  // parseTipParams は chain を常に解決するが、型上は optional。安全側で default に倒す。
  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const paymasterMode = resolvePaymasterMode(deployment);
  const isErc20Paymaster = paymasterMode === 'erc20';
  // JPYC ガス無料化: JPYC ガスレスは recover を除き常に無徴収 (relay free / 非 relay
  // sponsorship free のいずれも OpenPay が gas を全額負担)。USDC は従来どおり。
  const isJpyc = deployment.symbol === 'jpyc';
  // ネイティブガストークン symbol (Polygon=POL / Kaia=KAIA / Base etc=ETH)。
  // gasInfoJpyc / gasInfoUsdc tooltip の {nativeToken} で使用。
  const nativeToken = requiredChain.nativeCurrency.symbol;
  const rawPresets =
    params.presets && params.presets.length > 0
      ? params.presets
      : DEFAULT_TIP_PRESETS[params.token];
  // URL preset の構文解釈は lib/url/tip.ts の単一パーサへ委譲する。決済額 state には
  // amount だけを渡すため、ラベル追加は金額計算・内訳・送信ロジックへ波及しない。
  const parsedPresets = useMemo(
    () =>
      rawPresets.flatMap((preset) => {
        const parsed = parseTipPreset(preset);
        return parsed ? [parsed] : [];
      }),
    [rawPresets],
  );
  const presetAmounts = useMemo(
    () => parsedPresets.map((preset) => preset.amount),
    [parsedPresets],
  );
  const themeColor = params.color ?? DEFAULT_THEME_COLOR;
  const themed = params.theme
    ? tipFormTheme(themeColor, params.theme)
    : undefined;
  const creatorName = params.name ?? '';
  const creatorMessage = params.message ?? '';

  const { address, isConnected } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // F7: webhook / thanksUrl のうち、現在の origin と host が異なる第三者ホスト。決済者データの
  // POST 先 / 送信成功後に開くリンク先になり得るため、送信前に payer (ファン) へ明示開示する
  // (block はしない — Discord/Patreon 等の正当な off-origin リンクが存在する)。origin 未確定は空配列。
  const origin = useOrigin();
  const offOriginHosts = useMemo(
    () =>
      origin
        ? offOriginCallbackHosts(
            [params.webhook, params.thanksUrl],
            new URL(origin).host,
          )
        : [],
    [origin, params.webhook, params.thanksUrl],
  );

  // 決済経路の単一情報源 (Phase 1.1)。散在していた useRelay / useRecover / isCircle を
  // この 1 値から導出する。引数は現行どおりに算出した解決済み値で、判定の優先順位・短絡は
  // resolvePaymentRoute が現行ロジックをそのまま再現する (挙動不変)。/pay・/checkout と同型だが、
  // tip は常に gasless / gas=customer 固定で standard 経路を持たず、split も非対応なので
  // isStandard は常に false・disableRelay は渡さない (CheckoutForm と同じく省略)。
  // ⚠️ chain 引数は TipForm の現行どおり deployment.chainId を渡す (PaymentForm/CheckoutForm は
  // useAccount() の chainId ?? deployment.chainId だが、TipForm は chainId を読まないため差異あり)。
  //   - JPYC ガスレスを EIP-3009 relay に倒すか (flag ON + JPYC + relay 対応 chain)。OFF / 非対応 /
  //     USDC は 'pimlico-7702' で従来挙動 (Pimlico fallback)。relay は smart account / gas quote 不要で
  //     顧客が署名するだけ・自前 relayer がガス負担 (memory:jpyc-eip3009)。
  //   - recover: forwarder 設定済 chain は gas 相当額を JPYC 回収 (tip は customer 上乗せ固定)。
  //     未設定は free (OpenPay 負担)。
  //   - USDC ガスレスが Circle に解決される場合は Circle Paymaster (permit + surcharge 込み quote)。
  const route = resolvePaymentRoute({
    isStandard: false,
    jpycGaslessProvider: resolveJpycGaslessProvider(
      deployment,
      deployment.chainId,
    ),
    usdcGaslessProvider: resolveUsdcGaslessProvider(
      deployment,
      deployment.chainId,
    ),
    hasJpycForwarder: jpycForwarderFor(deployment.chainId) !== null,
  });
  const useRelay = isRelayRoute(route);
  const showTipMessageComposer = env.enableTipMessage && isRelayRoute(route);
  const relay = useJpycEip3009Payment(deployment);
  // recover: relay かつ forwarder 設定済 chain (gas 相当額を JPYC 回収・tip は customer 上乗せ固定)。
  // 未設定は free (OpenPay 負担)。relayGasEquiv は amountWei 確定後に算出する (CDX-3: 実スケジュール
  // recoverFeeValue を使う。チップは gasMode=customer 固定でフロアのみ — bps を適用しないため
  // bps>0 でも常にフロア = 従来挙動と一致)。
  const useRecover = isRecoverRoute(route);

  // relay 時は smart account / batch / gas quote とも skip (enabled=!useRelay)。
  const paymentEnabled = !preview && !useRelay;
  const { data: saData, error: saError } = useSmartAccount(
    deployment,
    paymentEnabled,
  );
  const gasless = useBatchPayment(deployment, paymentEnabled);
  const gasQuote = useGasQuote(deployment, paymentEnabled);
  // USDC ガスレスが Circle に解決される場合は Circle Paymaster (route 由来)。
  const isCircle = isCircleRoute(route);
  const circleQuote = useGasQuoteCircle(
    deployment,
    paymentEnabled && isCircle,
  );
  // 表示・readiness・error は circle のときは circleQuote を本線にする。
  const activeQuote = isCircle ? circleQuote : gasQuote;
  const circlePermitAmount = isCircle ? circleQuote.data?.permitAmount : undefined;

  // プリセット + カスタム金額の選択ステートマシン (NativeTipForm と共有・挙動不変)。
  // amountWei の精度ガード連鎖・amountStr 導出・各ハンドラは hooks/useTipAmount.ts に集約。
  const {
    selectedPreset,
    customAmount,
    customSelected,
    amountStr,
    amountWei,
    amountPrecisionError,
    selectPreset,
    selectCustom,
    changeCustomAmount,
  } = useTipAmount({ presets: presetAmounts, decimals: deployment.decimals });
  const [privateTipMessage, setPrivateTipMessage] = useState('');
  const canAttachPrivateTipMessage = amountWei >= TIP_MESSAGE_MIN_WEI;
  // PayPay 風 大型成功 overlay (dismiss するまで全画面)
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [crossChainLocked, setCrossChainLocked] = useState(false);
  const [crossChainResult, setCrossChainResult] = useState<ExecuteResult>();

  // recover 時に回収する利用料 (= 実 settle で feeReceiver へ分割される額)。CDX-3: 実スケジュール
  // recoverFeeValue を使う。チップは gasMode=customer 固定で、recoverFeeValue は customer に bps を
  // 適用せず常にフロア (= 2 JPYC) を返す → bps>0 でもフロアのまま従来挙動と一致。free (非 recover) は 0n。
  const relayGasEquiv = useRecover
    ? recoverFeeValue(amountWei, 'customer', deployment.chainId)
    : 0n;

  // Tip widget は gasless / gas=customer 固定 (preset セマンティクス維持):
  // creator は preset - fee を受け取り、ファンは preset + gas を支払う。
  // standard mode (顧客 wallet で gas 自前負担) は creator-fan UX を崩すため
  // tip 文脈では非対応。URL で mode=standard が来ても無視して gasless で動かす。
  // circle のときは surcharge 込み circleQuote を使う。
  const gasAmount = activeQuote.data?.gasAmount;
  // breakdown/会計に使う gas 相当額: relay は固定の回収額 (recover=fee / free=0)、非 relay は
  // paymaster quote (circle / erc20)。relay は quote を持たないため effective で切り替える。
  // money 計算は route 駆動の純関数 (lib/paymentMoney) に一元化済 (Phase 1.2・式は不変)。
  const effectiveGasAmount: bigint | undefined = deriveEffectiveGasAmount(
    route,
    { isJpyc, relayGasEquiv, gasAmount },
  );
  // tip は payMode='gasless' / gasMode='customer' 固定 (creator-fan UX)。recover でも顧客上乗せの
  // ままなので effectiveGasMode (recover→'merchant') は使わず literal を渡す (現行と byte 一致)。
  const breakdown = useMemo(
    () =>
      paymentBreakdown({
        totalWei: amountWei,
        token: params.token,
        payMode: 'gasless',
        gasMode: 'customer',
        effectiveGasAmount,
      }),
    [amountWei, params.token, effectiveGasAmount],
  );

  // gas 軸:
  //   ERC20 Paymaster (USDC): paymaster が顧客 USDC から actualGas を別途徴収。
  //   Sponsorship (JPYC・非 relay): Pimlico が立替、運営は徴収 JPYC で精算 (fee transfer に内包)。
  //   EIP-3009 relay (JPYC): recover は forwarder が gas 相当を feeReceiver へ分割回収。
  const totalCustomerOutflow = breakdown.customerPays;
  // JPYC ガス無料化: JPYC は gas を一切徴収しないため 0 (OpenPay 全額負担)。relay / circle は
  // 元々 0。残る testnet USDC sponsorship fallback (非商用・非 JPYC) のみ従来どおり回収。
  // 現行の余分な `!useRelay` ガードは relay⟹JPYC (resolveJpycGaslessProvider が JPYC のみ relay 化)
  // のため !isJpyc に内包され、shared 関数 (gasReimbursementValue) と reachable 入力で byte 一致。
  const gasReimbursement = gasReimbursementValue(route, {
    isJpyc,
    paymasterMode,
    gasAmount,
  });
  // 記録用ネットワーク手数料相当額 (会計分離・on-chain transfer とは別)。relay=回収額/0、
  // 非 relay sponsorship=立替回収 / USDC erc20=paymaster 徴収分。circle は receipt 由来の
  // circlePaymasterNetUsdc を使うため null (mutate へは undefined)。tip は route が常に非 standard
  // のため networkFeeEquivalentValue の !isStandard 句は常に真 → 現行の `!isCircle` 条件と byte 一致。
  const networkFeeEquivalent: bigint | null = networkFeeEquivalentValue(
    route,
    effectiveGasAmount,
  );

  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  const { balance, insufficientBalance, wrongChain } = useErc20BalanceAndChain(
    deployment,
    requiredChain,
    totalCustomerOutflow,
  );

  // 決済結果を mode 中立に正規化 (relay は txHash のみ・blockNumber/userOpHash 無し)。
  const relayResponseUnknown = isRelayResponseUnknownError(relay.error);
  const relayAmbiguous = relay.recoveryState != null || relayResponseUnknown;
  // Pimlico は broadcast 後の receipt 取得失敗を relay と同じ unknown として保持する。
  // latch 中は新しい UserOperation ではなく、保持済み hash の receipt 再照会だけを許可する。
  const gaslessAmbiguous = gasless.isUnknown;
  const relayIpRateLimited = isRelayIpRateLimitedError(relay.error)
    ? relay.error
    : null;
  const directFlowPending = relay.isRestoring || relayAmbiguous
    ? true
    : useRelay
      ? relay.isPending
      : gasless.isPending || gaslessAmbiguous;
  const directFlowSuccess = useRelay
    ? !!(relay.data?.success && relay.data.txHash)
    : !!gasless.data?.success;
  const directFlowTxHash = useRelay ? relay.data?.txHash : gasless.data?.txHash;
  const flowPending = directFlowPending || crossChainLocked;
  const flowSuccess = directFlowSuccess || !!crossChainResult;
  const flowTxHash = crossChainResult?.mintTxHash ?? directFlowTxHash;
  const flowUserOpHash = crossChainResult
    ? undefined
    : useRelay
      ? undefined
      : gasless.data?.userOpHash;
  const flowBlockNumber: bigint | undefined = useRelay
    ? undefined
    : crossChainResult
      ? undefined
      : gasless.data?.blockNumber;
  const restoredRelayPayment = relay.restoredIntent != null;

  // relay は gas quote / smart account 不要なので readiness 即満たす。circle は permitAmount を含む
  // activeQuote(circleQuote) 確定まで待つ (未算定で送信すると useBatchPayment が throw)。
  const gasQuoteReady = useRelay || activeQuote.data !== undefined;
  // 送金が確定 (または broadcast 済で確定しうる) 後の再送信を禁止。再送すると同一受取人へ
  // 2 件目の on-chain 送金 = 二重支払いになる。revert (送金未成立) は安全なので再試行を許す
  // (CheckoutForm/PaymentForm と同一防御。TipForm は standard 経路を持たないため gasless/relay のみ)。
  const directSettledNoRetry =
    relay.hasActiveIntent ||
    (!useRelay && (gaslessAmbiguous || !!gasless.data?.success)) ||
    (useRelay &&
      (relayAmbiguous ||
        !!relayIpRateLimited ||
        (!!relay.data && (relay.data.success || !!relay.data.pending))));
  const settledNoRetry = directSettledNoRetry || !!crossChainResult;
  // relay 202: broadcast 済だが未確定 (success でも error でもない)。送信ボタンに「送信中」を
  // 出してフィードバックの空白を防ぐ (再送は settledNoRetry で既に禁止)。
  const relayPending =
    useRelay && !!relay.data && !relay.data.success && !!relay.data.pending;
  // 未接続時に最下部 CTA からウォレット選択セクションへ誘導するためのアンカー。
  const walletSectionRef = useRef<HTMLElement | null>(null);

  const canSubmit =
    !preview &&
    isConnected &&
    !wrongChain &&
    (useRelay || !!saData) &&
    // creator 受取 > 0 を要求 (custom amount 未入力だと gas 分で customerPays が
    // 正になり得るが、tip 額 0 の空 batch は無意味)。hook 側でも calls.length===0
    // を弾くが、UI でも button を無効化して金額入力を促す。
    breakdown.merchantReceives > 0n &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !flowPending &&
    gasQuoteReady &&
    !settledNoRetry;

  // gas congested はチェーン別の早期 abort なので、生のエラーメッセージ
  // (デバッグ向け詳細) ではなく i18n された案内文に差し替える。
  // gasQuote の失敗も同様に i18n 化 (詳細は logger 経由で Sentry へ)。
  const saFallback = !useRelay && isIncompatibleSmartAccountError(saError);
  // 送信は成立したがチェーン上で revert したケース (gasless/relay: data.success===false・relay は
  // pending を除外)。success overlay も error も出ず無反応に見える穴を明示メッセージで塞ぐ。
  const revertedNoFeedback =
    (!useRelay && !!gasless.data && !gasless.data.success) ||
    (useRelay && !!relay.data && !relay.data.success && !relay.data.pending);
  // relay の error は code 文字列 (rate_limited 等) なので friendly i18n に差し替える。
  const flowError = relayAmbiguous || gaslessAmbiguous
    ? null
    : useRelay
      ? relay.error
      : gasless.error;
  const flowErrorMessage = useRelay
    ? isFallbackSafeRelayError(flowError)
      ? t(relayErrorKey(flowError))
      : undefined
    : flowError?.message;
  const error = isGasCongestedError(flowError)
    ? t('errorGasCongested')
    : (flowErrorMessage ??
      (useRelay || saFallback ? undefined : saError?.message) ??
      (!useRelay && activeQuote.error ? t('errorGasQuote') : null) ??
      (amountPrecisionError
        ? t('errorAmountPrecision', { decimals: deployment.decimals })
        : null) ??
      (revertedNoFeedback ? t('errorReverted') : null));

  useEffect(() => {
    if (gasless.error) logger.error('tip.failed', { error: gasless.error });
  }, [gasless.error]);

  useEffect(() => {
    if (relay.error) logger.error('tip.relay.failed', { error: relay.error });
  }, [relay.error]);

  useEffect(() => {
    if (saError) logger.error('tip.smart-account.init-failed', { error: saError });
  }, [saError]);

  useEffect(() => {
    if (activeQuote.error)
      logger.error('tip.gas-quote.failed', { error: activeQuote.error });
  }, [activeQuote.error]);

  // userOpHash ごとに 1 回限りの webhook 発火。gasQuote の refetchInterval (30s)
  // で breakdown が再計算 → effect 再実行 → 二重発火を防ぐ gate。
  const notifiedUserOpHashRef = useRef<string | null>(null);
  // 送信時点の確定スナップショット。webhook が live state (amountStr / breakdown) を読むと、
  // 送信後にユーザが額を変えたり gasQuote が refetch されたとき、実際に送ったチップと異なる
  // 値を creator へ通知してしまう。onSubmit でここに固定し、webhook はこちらを参照する。
  const submittedRef = useRef<{
    amount: string;
    merchantAmount: string;
    feeAmount: string;
    customerPays: string;
  } | null>(null);
  // 成功 overlay の表示額は送信時点を固定 (送信後に金額編集しても overlay が live 値で
  // ぶれないように・Codex P2)。onSubmit で fmt(totalCustomerOutflow) を保存。
  const submittedAmountDisplayRef = useRef<string | null>(null);

  const onCrossChainAttemptStart = useCallback(
    (attemptAmount: bigint) => {
      const { bridgedAmount, feeAmount } = computeCrossChainFeeSplit(
        attemptAmount,
        'usdc',
        'standard',
      );
      // cross-chain の network gas は native token の別払い。webhook / 控えには
      // execute 開始時点の USDC 額を固定し、後続の preset 変更から切り離す。
      submittedRef.current = {
        amount: formatUnits(attemptAmount, deployment.decimals),
        merchantAmount: bridgedAmount.toString(),
        feeAmount: feeAmount.toString(),
        customerPays: attemptAmount.toString(),
      };
      submittedAmountDisplayRef.current = formatTokenAmount(
        attemptAmount,
        deployment,
      );
      setCrossChainLocked(true);
    },
    [deployment],
  );
  const onCrossChainExecutingChange = useCallback((executing: boolean) => {
    setCrossChainLocked(executing);
  }, []);
  const onCrossChainSuccess = useCallback((result: ExecuteResult) => {
    setCrossChainResult(result);
    setCrossChainLocked(false);
  }, []);

  useEffect(() => {
    // mode 中立: relay (txHash のみ) / gasless (userOpHash + blockNumber) 双方を flow* で扱う。
    if (!flowSuccess || !flowTxHash) return;
    // 元の name/message/webhook は許可済み intent metadata に保存しない。reload 復元 hash から
    // 現在 URL の webhook・控えを生成して別 tip へ誤帰属させる波及を断ち、hash 表示だけ残す。
    if (restoredRelayPayment) return;
    // dedup 鍵: gasless は userOpHash、relay は txHash。
    const dedupKey = flowUserOpHash ?? flowTxHash;
    if (notifiedUserOpHashRef.current === dedupKey) return;
    notifiedUserOpHashRef.current = dedupKey;
    // 送信時スナップショット優先 (live state drift を排除)。万一未設定なら live に fallback。
    const sent = submittedRef.current ?? {
      amount: amountStr,
      merchantAmount: breakdown.merchantReceives.toString(),
      feeAmount: breakdown.feeAmount.toString(),
      customerPays: breakdown.customerPays.toString(),
    };
    logger.info('tip.success', {
      mode: crossChainResult ? 'cross-chain' : useRelay ? 'relay' : 'gasless',
      userOpHash: flowUserOpHash,
      txHash: flowTxHash,
      creator: params.to,
      amount: sent.amount,
      token: params.token,
    });
    // 顧客向け電子レシート (支払い控え) を支払い側ブラウザに保存。/tip は usePaymentHistory
    // 非経由のためここで直接 append (明細なし → 仮想 1 行)。dedupe は receiptId 任せ。
    appendPayerReceipt(
      buildPayerReceipt({
        txHash: flowTxHash,
        userOpHash: flowUserOpHash ?? null,
        chainId: crossChainResult?.destChainId ?? deployment.chainId,
        asset: params.token,
        tokenAddress: deployment.address,
        amount: sent.amount,
        merchantAddress: params.to,
        merchantName: params.name ?? null,
        payerAddress: address,
        paymentMode: crossChainResult ? 'cross-chain' : 'gasless',
        gasMode: 'customer',
        memo: params.message ?? null,
        sourceRoute: '/tip',
        locale,
      }),
    );
    // webhook 失敗 (CORS / non-2xx) は logger.warn のみ。tip は成立しているため UI には出さない。
    // fetch の Promise は HTTP non-2xx でも resolve するため res.ok を明示確認。
    if (params.webhook) {
      // hash は fetch と並行に開始し、失敗 telemetry が必要な場合だけ await する。
      const webhookTelemetry = redactUrlForTelemetry(params.webhook);
      const payload = {
        type: 'openpay.tip.success',
        creator: params.to,
        from: address,
        token: params.token,
        chain: chainSlug,
        amount: sent.amount,
        merchantAmount: sent.merchantAmount,
        feeAmount: sent.feeAmount,
        customerPays: sent.customerPays,
        message: params.message,
        txHash: flowTxHash,
        // relay は userOpHash / blockNumber を持たない → payload から省略 (null 文字列化しない)。
        ...(flowUserOpHash ? { userOpHash: flowUserOpHash } : {}),
        ...(flowBlockNumber !== undefined
          ? { blockNumber: flowBlockNumber.toString() }
          : {}),
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
        .then(async (res) => {
          if (!res.ok) {
            const redacted = await webhookTelemetry;
            logger.warn('tip.webhook.non_ok', {
              status: res.status,
              statusText: res.statusText,
              webhookOrigin: redacted.origin,
              webhookHash: redacted.hash,
            });
          }
        })
        .catch(async (err) => {
          const redacted = await webhookTelemetry;
          logger.warn('tip.webhook.failed', {
            error: err,
            webhookOrigin: redacted.origin,
            webhookHash: redacted.hash,
          });
        });
    }
  }, [
    flowSuccess,
    flowTxHash,
    flowUserOpHash,
    flowBlockNumber,
    useRelay,
    crossChainResult,
    restoredRelayPayment,
    params.to,
    params.token,
    params.name,
    chainSlug,
    params.message,
    params.webhook,
    amountStr,
    address,
    breakdown.merchantReceives,
    breakdown.feeAmount,
    breakdown.customerPays,
    deployment.chainId,
    deployment.address,
    deployment.decimals,
    locale,
  ]);

  function onSubmit() {
    if (preview || !canSubmit) return;
    // 完了画面のチャイムを iOS でも鳴らせるよう、この gesture 内で AudioContext を解錠。
    primeChimeAudio();
    // 送信時点の値を固定 (webhook はこのスナップショットを使い、後続の編集 / gasQuote
    // refetch による drift を排除する)。
    submittedRef.current = {
      amount: amountStr,
      merchantAmount: breakdown.merchantReceives.toString(),
      feeAmount: breakdown.feeAmount.toString(),
      customerPays: breakdown.customerPays.toString(),
    };
    submittedAmountDisplayRef.current = fmt(totalCustomerOutflow);
    if (useRelay) {
      // JPYC EIP-3009 relay: 顧客が署名するだけ・自前 relayer がガス負担。tip は customer 固定
      // (recover 時 forwarder が gas 相当を回収・free 時 OpenPay 負担)。value=tip 額。
      relay.mutate({
        merchant: params.to,
        value: amountWei,
        gasMode: 'customer',
        ...(showTipMessageComposer &&
          canAttachPrivateTipMessage &&
          privateTipMessage.trim().length > 0
          ? { tipMessage: privateTipMessage }
          : {}),
      });
      return;
    }
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
      networkFeeEquivalent: networkFeeEquivalent ?? undefined,
      circlePermitAmount,
    });
  }

  const explorerBase = blockExplorerUrl(deployment.chainId);
  const approvalCheckUrl =
    isErc20Paymaster && address && explorerBase
      ? `${explorerBase}/tokenapprovalchecker?search=${address}`
      : undefined;

  // PayPay 風 大型成功 overlay の payload (Phase 1.4)。tip は経路が gasless / relay の 1 系統 (mode
  // 中立化済の flow* を使う) なので overlay も元から 1 個。共通 PaymentSuccessOverlay へ寄せても挙動は
  // 不変。amountDisplay は submit 時点の固定値 (送信後の金額編集で overlay がぶれない・Codex P2)、
  // txHash/userOpHash/blockNumber は flow* (relay は userOpHash/blockNumber 無し)。tip は店舗アドレス
  // explorer link を出さないため merchantAddress は渡さない (= 従来どおり省略)。未成功は null。
  const successOverlayPayload: PaymentSuccessOverlayPayload | null =
    !restoredRelayPayment && flowSuccess && flowTxHash
      ? {
          amountDisplay:
            submittedAmountDisplayRef.current ?? fmt(totalCustomerOutflow),
          txHash: flowTxHash,
          userOpHash: flowUserOpHash,
          blockNumber: flowBlockNumber,
          explorerBase,
        }
      : null;

  // 「署名安心 UX」(plans/sign-reassurance-ux.md・P2+P4)。tip は standard 経路を持たないので
  // (a) relay free / (a') relay recover / (c) Circle USDC の 3 kind のみ (計画 §3.3)。
  //   (a) relay free (forwarder 未設定): jpyc-relay-free フルパネル。preview は relay.mutate に
  //       渡す変数 (params.to / amountWei) と同一ソース。testnet 等 forwarder 無し chain 用。
  //   (a') relay recover (forwarder 設定済・本番): jpyc-relay-recover フルパネル (P4)。tip は gas=
  //       customer 固定なのでウォレットは amountWei+fee を出す。照合表で内訳を説明する。forwarder
  //       無しなら build が null → free 経路へ倒れる。
  //   (c) Circle (USDC gasless): usdc-permit。permitCap は circle quote の permitAmount を
  //       formatUnits (未取得なら省略)。tip は split 非対応のため transferCount は出さない。
  // 署名内容は不変・表示のみ。Pimlico 7702 経路はスコープ外。
  const showRelayFree =
    useRelay && !useRecover && amountWei > 0n;
  const recoverPreview =
    useRelay && useRecover && amountWei > 0n
      ? buildJpycRecoverSignPreview({
          value: amountWei,
          merchant: params.to,
          storeName: params.name ?? undefined,
          decimals: deployment.decimals,
          displaySymbol: deployment.displaySymbol,
          chainId: deployment.chainId,
          gasMode: 'customer',
        })
      : null;
  const signReassurance: SignReassuranceProps | null = showRelayFree
    ? {
        kind: 'jpyc-relay-free',
        preview: buildJpycRelaySignPreview({
          value: amountWei,
          merchant: params.to,
          storeName: params.name ?? undefined,
          decimals: deployment.decimals,
          displaySymbol: deployment.displaySymbol,
        }),
        awaiting: relay.isPending,
      }
    : recoverPreview
      ? {
          kind: 'jpyc-relay-recover',
          preview: recoverPreview,
          awaiting: relay.isPending,
        }
      : isCircle && amountWei > 0n
      ? {
          kind: 'usdc-permit',
          amountHuman: formatUnits(amountWei, deployment.decimals),
          symbol: deployment.displaySymbol,
          permitCapHuman:
            circlePermitAmount !== undefined
              ? formatUnits(circlePermitAmount, deployment.decimals)
              : undefined,
          awaiting: gasless.isPending,
        }
      : null;

  return (
    <div
      className={
        themed
          ? `space-y-4 ${themed.rootClassName}`
          : 'space-y-4'
      }
      style={themed?.rootStyle}
      data-tip-theme={params.theme}
      data-tip-preview={preview || undefined}
    >
      <header
        className={
          themed
            ? `rounded-2xl p-5 text-white shadow-sm ${themed.headerClassName}`
            : 'rounded-2xl p-5 text-white shadow-sm'
        }
        style={themed?.headerStyle ?? { backgroundColor: themeColor }}
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

      <section
        className={
          themed
            ? `rounded-2xl border border-slate-200 bg-white p-4 ${themed.amountClassName}`
            : 'rounded-2xl border border-slate-200 bg-white p-4'
        }
        // night 等の地色は inline style で確実に適用する (bg-white との Tailwind クラス競合は
        // stylesheet 順に依存し、負けると淡ラベルだけ残るコントラスト破綻になる)。
        style={themed?.amountStyle}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('amountTitle')}
        </p>
        <div
          className={`mt-3 grid gap-2 ${
            // ラベル付き preset は 12 字までありモバイル 3 列だとほぼ必ず truncate する。
            // ラベルを使うときだけ 2 列で表示幅を確保 (ラベル無しは現行 3 列を完全維持)。
            parsedPresets.some((p) => p.label) ? 'grid-cols-2' : 'grid-cols-3'
          }`}
        >
          {parsedPresets.map((preset) => {
            const active =
              !customSelected && selectedPreset === preset.amount;
            return (
              <button
                key={preset.amount}
                type="button"
                onClick={() => selectPreset(preset.amount)}
                disabled={flowPending}
                className={`rounded-xl border ${
                  preset.label ? 'px-2 py-2' : 'px-2 py-3'
                } text-center text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? 'border-transparent text-white shadow-sm'
                    : `border-slate-200 bg-white text-slate-700 hover:border-slate-300 ${
                        themed?.inactivePillClassName ?? ''
                      }`
                }`}
                style={
                  active
                    ? themed?.activePillStyle ?? { backgroundColor: themeColor }
                    : undefined
                }
              >
                {preset.label ? (
                  <span className="flex flex-col items-center gap-0.5">
                    <span className="max-w-full truncate text-xs font-normal leading-tight opacity-80">
                      {preset.label}
                    </span>
                    <span className="leading-tight">
                      {preset.amount} {deployment.displaySymbol}
                    </span>
                  </span>
                ) : (
                  <>
                    {preset.amount} {deployment.displaySymbol}
                  </>
                )}
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
              disabled={flowPending}
              onFocus={selectCustom}
              onChange={(e) => changeCustomAmount(e.target.value)}
              placeholder={
                params.token === 'jpyc'
                  ? t('amountCustomPlaceholderJpyc')
                  : t('amountCustomPlaceholderUsdc')
              }
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-lg font-semibold focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: customSelected ? themeColor : undefined }}
            />
          </label>
        </div>
      </section>

      {showTipMessageComposer && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t('privateTipMessageLabel')}
            </span>
            <textarea
              value={privateTipMessage}
              onChange={(event) => setPrivateTipMessage(event.target.value)}
              placeholder={t('privateTipMessagePlaceholder')}
              maxLength={300}
              rows={3}
              disabled={flowPending || !canAttachPrivateTipMessage}
              className="mt-2 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70"
            />
          </label>
          {!canAttachPrivateTipMessage && (
            <p className="mt-1 text-xs text-amber-700">
              {t('privateTipMessageMinimum')}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            {t('privateTipMessagePrivacy')}
          </p>
        </section>
      )}

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
          {/* relay は gas quote 非取得。recover=固定回収額 / free=OpenPay 立替 (無料)。
              非 relay は従来 paymaster quote (USDC erc20 / JPYC sponsorship)。 */}
          {useRecover ? (
            <Row
              label={t('gasRow')}
              labelExtra={<InfoTooltip text={t('gasInfoJpycRecover')} />}
              value={fmt(relayGasEquiv)}
            />
          ) : useRelay || isJpyc ? (
            // JPYC ガスレス (relay free / 非 relay sponsorship free) は無徴収。中立ラベル。
            <Row
              label={t('gasRowFree')}
              labelExtra={<InfoTooltip text={t('gasInfoJpycRelay')} />}
              value={t('gasRowRelayFree')}
            />
          ) : (
            <Row
              label={t('gasRow')}
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
          <div className="my-1 border-t border-slate-200" />
          <Row
            label={t('customerRow')}
            value={fmt(totalCustomerOutflow)}
            strong
          />
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {useRecover
            ? t('gaslessHintJpycRecover')
            : useRelay || isJpyc
              ? t('gaslessHintJpycRelay')
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
          canFallbackToStandard={false}
        />
      )}

      <section
          ref={walletSectionRef}
          className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
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
        {!preview && params.token === 'usdc' && address && (
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
            executionDisabled={directFlowPending || directSettledNoRetry}
            onAttemptStart={onCrossChainAttemptStart}
            onExecutingChange={onCrossChainExecutingChange}
            onSuccess={onCrossChainSuccess}
          />
        )}
      </section>

      {/* F7: off-origin コールバック開示 (送信前・payer 向け)。webhook/thanksUrl が第三者ホストを
          指すとき、送信後に通知/遷移する先を明示する (情報提供のみ・送信は妨げない)。 */}
      {!flowSuccess && offOriginHosts.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          <p>{t('offOriginCallbackNote', { host: offOriginHosts.join('、') })}</p>
        </div>
      )}

      {/* 署名安心パネル/ヒント (送信ボタン直上)。relay free=フルパネル / Circle USDC=usdc-permit。
          recover/Pimlico 7702 はスコープ外で出さない。署名/確認待ち中は待機表示に置換する。
          表示専用で決済ロジックには触れない。 */}
      {signReassurance && <SignReassurance {...signReassurance} />}

      {/* Recover モードの手数料開示 (送信ボタン直上)。tip は gas=customer 固定 (チッパーが
          チップ + 手数料を負担)。free モード / 非 recover では何も描画しない。 */}
      <RecoverFeeNotice
        billAmount={useRecover && amountWei > 0n ? amountWei : null}
        chainId={deployment.chainId}
        gasMode="customer"
      />

      <button
        type="button"
        // 未接続時 (builder プレビュー除く): 押せない「ウォレットを接続」を解消し、
        // タップでウォレット選択へスクロール (#266 CheckoutForm と同型・送信不変)。
        onClick={
          !preview && !isConnected
            ? () =>
                  walletSectionRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                  })
            : onSubmit
        }
        disabled={(preview || isConnected) && !canSubmit}
        className={
          themed
            ? `w-full rounded-xl px-4 py-3 text-base font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${themed.submitClassName}`
            : 'w-full rounded-xl px-4 py-3 text-base font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50'
        }
        style={themed?.submitStyle ?? { backgroundColor: themeColor }}
      >
        {preview
          ? t('btnSend', { amount: fmt(totalCustomerOutflow) })
          : flowPending || relayPending
          ? t('btnSending')
          : !isConnected
            ? t('btnConnect')
            : wrongChain
              ? t('btnSwitchChain')
              : !useRelay && !saData
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

      {/* Pimlico receipt RPC が不確定な間は新しい UserOperation を作らず、保持した
          userOpHash の receipt 再照会だけを許可する。文言は relay unknown と共通。 */}
      {gaslessAmbiguous && (
        <PaymentStatusPanel
          title={t('responseUnknownTitle')}
          body={t('responseUnknownBody')}
          titleWithIcon
          showSpinner
          identifier={gasless.pendingUserOpHash}
          actionLabel={t('responseUnknownRetryButton')}
          actionDisabled={gasless.isPending}
          onAction={gasless.retryReceipt}
        />
      )}

      {/* Tip には standard fallback が無い。ambiguity latch 中は Pay を封鎖し、同一 payload の
          再確認だけを許可する。 */}
      {relayAmbiguous && (
        <PaymentStatusPanel
          title={t('responseUnknownTitle')}
          body={
            relay.recoveryState === 'auto'
              ? t('responseUnknownAutoBody')
              : t('responseUnknownBody')
          }
          titleWithIcon
          showSpinner={relay.recoveryState === 'auto'}
          actionLabel={
            relay.recoveryState === 'auto'
              ? undefined
              : t('responseUnknownRetryButton')
          }
          actionDisabled={
            relay.recoveryState === 'auto' ? undefined : relay.isPending
          }
          onAction={
            relay.recoveryState === 'auto'
              ? undefined
              : relay.retrySamePayload
          }
        />
      )}

      {/* relay IP rate limit: idem 確認前の 429 なので main Pay / 再署名を封鎖し、保持済みの
          同一署名 payload の再 POST だけを許可する。 */}
      {relayIpRateLimited && !relayAmbiguous && (
        <PaymentStatusPanel
          title={t('ipRateLimitedTitle')}
          body={
            relayIpRateLimited.retryAfterSeconds === null
              ? t('ipRateLimitedBody')
              : t('ipRateLimitedBodyWithRetryAfter', {
                  seconds: relayIpRateLimited.retryAfterSeconds,
                })
          }
          actionLabel={t('ipRateLimitedRetryButton')}
          actionDisabled={relay.isPending}
          onAction={relay.retryRelay}
        />
      )}

      {/* relay pending: broadcast 済だが未確定。standard へ fallback させず「確認待ち」を表示
          (再送信は canSubmit の settledNoRetry で禁止)。txHash があれば Explorer で追跡。 */}
      {useRelay && !relayAmbiguous && relay.data?.pending && (
        <PaymentStatusPanel
          title={t('pendingTitle')}
          body={t('pendingBody')}
          titleWithIcon
          showSpinner
          identifier={relay.data.txHash ?? undefined}
          explorerHref={
            relay.data.txHash && explorerBase
              ? `${explorerBase}/tx/${relay.data.txHash}`
              : undefined
          }
          explorerLabel={t('pendingExplorerLink')}
        />
      )}

      {flowSuccess && flowTxHash && (
        <TipSuccessPanel
          title={t('successTitle')}
          thanks={restoredRelayPayment ? undefined : params.thanks}
          thanksUrl={restoredRelayPayment ? undefined : params.thanksUrl}
          openLinkLabel={t('openLink')}
          userOpHash={flowUserOpHash}
          txHash={flowTxHash}
          blockNumber={flowBlockNumber}
          userOpLabel={t('successUserOp')}
          txLabel={t('successTx')}
          blockLabel={t('successBlock')}
        />
      )}

      {/* PayPay 風 大型成功 overlay。dismiss 後は上記の従来 panel (thanks 含む) を表示。共通
          PaymentSuccessOverlay へ集約 (payload で表示値を確定・挙動不変)。 */}
      <PaymentSuccessOverlay
        dismissed={overlayDismissed}
        payload={successOverlayPayload}
        onDismiss={() => setOverlayDismissed(true)}
      />

      <p className="pt-2 text-center text-[10px] text-slate-500">
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
