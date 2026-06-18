'use client';

// セキュリティ: webhook payload と success_url の query は顧客側で改ざん可能
// (Stripe の whsec_ 署名相当の保証はない)。マーチャントは tx_hash を必ず
// on-chain で再検証してから注文を確定する責務を負う。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { InfoTooltip } from './InfoTooltip';
import { OnrampCta } from './OnrampCta';
import { ResultRow } from './ResultRow';
import { Row } from './Row';
import { SmartAccountFallbackBanner } from './SmartAccountFallbackBanner';
import { RelayFallbackBanner } from './RelayFallbackBanner';
import {
  PaymentSuccessOverlay,
  type PaymentSuccessOverlayPayload,
} from './PaymentSuccessOverlay';
import { SignReassurance, type SignReassuranceProps } from './SignReassurance';
import { PayerReceiptCompletion } from './PayerReceiptCompletion';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useGasQuote } from '@/hooks/useGasQuote';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import {
  resolvePaymentRoute,
  isStandardRoute,
  isRelayRoute,
  isRecoverRoute,
  isCircleRoute,
} from '@/lib/paymentRoute';
import { recoverFeeValue, recoverPercentValue } from '@/lib/relay/recoverFee';
import {
  feeSplit,
  mobileOrderBreakdown,
  mobileOrderGasMode,
  type MobileOrderFeeKind,
} from '@/lib/mobileOrderFee';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
import { type GasMode } from '@/lib/fee';
import {
  effectiveGasMode,
  isMerchantGasAbsorb,
  effectivePayMode,
  effectiveGasAmount as deriveEffectiveGasAmount,
  paymentBreakdown,
  gasReimbursementValue,
  networkFeeEquivalentValue,
  minimumAmountWei as deriveMinimumAmountWei,
} from '@/lib/paymentMoney';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { primeChimeAudio } from '@/lib/successChime';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { isIncompatibleSmartAccountError } from '@/lib/accountDetection';
import { logger } from '@/lib/logger';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { useRelayGaslessSnapshot } from '@/hooks/useRelayGaslessSnapshot';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import {
  calcCheckoutTotal,
  type CheckoutParams,
} from '@/lib/url';
import { taxAmountDecimal, taxDisplayDecimals } from '@/lib/tax';
import { formatTokenAmount, shortAddress } from '@/lib/format';
import {
  buildJpycRelaySignPreview,
  buildJpycRecoverSignPreview,
} from '@/lib/signPreview';
import { RecoverFeeNotice } from './RecoverFeeNotice';

const SUCCESS_REDIRECT_DELAY_MS = 3000;

export function CheckoutForm({ params }: { params: CheckoutParams }) {
  const t = useTranslations('CheckoutForm');
  const locale = useLocale();
  const router = useRouter();
  const [modeOverride, setModeOverride] = useState<'standard' | null>(null);

  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const paymasterMode = resolvePaymasterMode(deployment);
  // JPYC ガス無料化: JPYC ガスレスは recover を除き常に無徴収 (relay free / 非 relay
  // sponsorship free のいずれも OpenPay が gas を全額負担)。USDC は従来どおり。
  const isJpyc = deployment.symbol === 'jpyc';

  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // 決済経路の単一情報源 (Phase 1.1)。散在していた isStandard / useRelay / useRecover / isCircle を
  // この 1 値から導出する。引数は現行どおりに算出した解決済み値で、判定の優先順位・短絡は
  // resolvePaymentRoute が現行ロジックをそのまま再現する (挙動不変)。
  //   - isStandard: params.mode='standard' か SA fallback の override。
  //   - JPYC ガスレスを EIP-3009 relay に倒すか (flag ON + JPYC + relay 対応 chain)。OFF / 非対応は
  //     'pimlico-7702' で従来挙動 (Pimlico fallback)。relay は smart account / gas quote 不要で、顧客が
  //     署名するだけ・自前 relayer がガス負担 (memory:jpyc-eip3009)。checkout は split 非対応なので
  //     PaymentForm のような split ガードは要らない。
  //   - recover: forwarder 設定済 chain は gas 相当額を JPYC 回収 (gasMode で顧客上乗せ/店主吸収)。
  //     未設定は free (OpenPay 負担)。
  //   - USDC ガスレスが Circle に解決される場合は surcharge 込み quote + permit allowance。
  const route = resolvePaymentRoute({
    isStandard: params.mode === 'standard' || modeOverride === 'standard',
    jpycGaslessProvider: resolveJpycGaslessProvider(
      deployment,
      chainId ?? deployment.chainId,
    ),
    usdcGaslessProvider: resolveUsdcGaslessProvider(
      deployment,
      deployment.chainId,
    ),
    hasJpycForwarder: jpycForwarderFor(chainId ?? deployment.chainId) !== null,
  });
  const isStandard = isStandardRoute(route);
  const useRelay = isRelayRoute(route);
  const isErc20Paymaster = !isStandard && paymasterMode === 'erc20';
  const relay = useJpycEip3009Payment(deployment);
  // B1 Layer B: relay 経路でのみ relayer の事前 (preflight) 健全性を polling する。degraded なら
  // 署名 *前* に「通常決済へ切替」を先回り案内する (Layer A は submit 失敗 *後* の reactive な導線)。
  // fail-open (読込中/error は degraded:false) なので advisory に徹し決済実行には影響しない。
  const relayHealth = useRelayHealth({
    chainId: deployment.chainId,
    enabled: useRelay,
  });
  // relayGasEquiv (= recover 時の利用料) は totalWei 確定後に算出する
  // (CDX-3: 実スケジュール recoverFeeValue を使い、bps>0 で会計サマリと実 settle 額を一致させる)。
  const useRecover = isRecoverRoute(route);

  // 確定モデル (2026-06-12): JPYC recover 決済は店舗が常に手数料を吸収する固定 (gasMode=merchant)。
  // 旧 QR が gas=customer を載せていても無視し merchant に倒す (発行済 QR の audience は極小で
  // user-approved)。recover 以外は URL の gas をそのまま使う (USDC の負担者トグルは不変)。
  // money 計算は route 駆動の純関数 (lib/paymentMoney) に一元化済 (Phase 1.2・式は不変)。
  // モバイル注文システム利用料 (storefront/preorder)。flag ON + feeKind が storefront/preorder の
  // ときだけ経路非依存に 1%(店頭)/3%(事前) を分割する。負担者 (店舗負担=merchant / 顧客上乗せ=
  // customer) は mode/feePayer から確定し effectiveGasMode を上書きする (顧客上乗せ preorder では
  // recover でも customer が必要)。'register' (レジ) は下記 isRegisterStandardFee で別扱い (standard
  // のみ)。feeKind 無し・/pay・/tip・通常 checkout は従来動作のまま (一切不変)。
  const mobileFeeKind: MobileOrderFeeKind | null =
    env.enableMobileOrderFee &&
    (params.feeKind === 'storefront' || params.feeKind === 'preorder')
      ? params.feeKind
      : null;
  const isMobileFee = mobileFeeKind !== null;
  const mobileGasMode: GasMode | undefined = mobileFeeKind
    ? mobileOrderGasMode(mobileFeeKind, params.feePayer)
    : undefined;
  const effectiveGas: GasMode = effectiveGasMode(
    route,
    params.gas,
    mobileGasMode,
  );
  const isMerchantGas = isMerchantGasAbsorb(route, effectiveGas);

  // Smart Account / Pimlico 経路は gasless のみ必要 — standard / relay では skip。
  const { data: saData, error: saError } = useSmartAccount(
    deployment,
    !isStandard && !useRelay,
  );
  const gasless = useBatchPayment(deployment, !isStandard && !useRelay);
  const standard = useStandardPayment();
  const gasQuote = useGasQuote(deployment, !isStandard && !useRelay);
  // USDC ガスレスが Circle に解決される場合は surcharge 込み quote + permit allowance (route 由来)。
  const isCircle = isCircleRoute(route);
  const circleQuote = useGasQuoteCircle(deployment, !isStandard && isCircle);
  const activeQuote = isCircle ? circleQuote : gasQuote;
  const circlePermitAmount = isCircle ? circleQuote.data?.permitAmount : undefined;

  const totalWei = useMemo(
    () => calcCheckoutTotal(params.items, deployment.decimals),
    [params.items, deployment.decimals],
  );

  // レジ (店頭POS) システム利用料: standard 経路 (JPYC) で recover の OpenPay利用料 % を店舗負担で
  // 課金する (relay 経路は既存 recover が徴収するので register は standard のみ追加)。7月前
  // (recoverFeeBps=0) は 0 = 無料・flag OFF も 0 = 完全 inert。USDC は対象外 (無料据置)。
  const isRegisterStandardFee =
    env.enableRegisterFee &&
    params.feeKind === 'register' &&
    isStandard &&
    isJpyc;
  const registerFee = isRegisterStandardFee
    ? recoverPercentValue(totalWei)
    : 0n;

  // recover 時に回収する利用料 (= 実 settle で feeReceiver へ分割される額)。CDX-3: 実スケジュール
  // recoverFeeValue(billAmount, effectiveGas) を使う。billAmount は relay.mutate に渡す totalWei、
  // effectiveGas は recover で強制される 'merchant'。bps=0 では floor (= 2 JPYC) になり従来挙動と
  // 完全一致。free (非 recover) は 0n。
  // モバイル注文料金は gas 項ではなく breakdown.feeAmount (システム利用料) に載せるため、gas 相当額
  // としては 0 にする (会計ラベルを gas でなく利用料へ倒す)。非モバイルは従来 recoverFeeValue/0。
  const relayGasEquiv =
    !isMobileFee && useRecover
      ? recoverFeeValue(totalWei, effectiveGas, deployment.chainId)
      : 0n;

  // standard mode では gasQuote 不要 (顧客 wallet が gas を自前で算定)。
  const gasAmount = !isStandard ? activeQuote.data?.gasAmount : undefined;
  // breakdown/会計に使う gas 相当額: relay は固定の回収額 (recover=fee / free=0)、非 relay は
  // paymaster quote。relay は quote を持たないため effective で切り替える (PaymentForm と同型)。
  //
  // 【不変条件: USDC erc20/circle の gas=merchant は二重徴収ではない】
  // merchant 着金から gas 見積を控除するが、その控除分は顧客の手元に残り、
  // 顧客がそれで paymaster の実 gas pull を賄う (= 控除は顧客への前補填)。
  // ネットで 顧客支出 = amount・店主受領 = amount − gas となり、
  // JPYC recover (控除分を feeReceiver へ送って立替者を補償) と等価。
  // gasMode の約束 (店主吸収: 顧客は請求額のみ・店主は amount−gas) は USDC でも成立。
  // 残る差は gas 見積と実 pull 額の僅差のみ (standard tier で有界)。
  const effectiveGasAmount: bigint | undefined = isMobileFee
    ? 0n
    : deriveEffectiveGasAmount(route, { isJpyc, relayGasEquiv, gasAmount });
  const effectiveMode = effectivePayMode(route, params.mode);
  // モバイル注文は経路非依存の mobileOrderBreakdown で分割を確定する (relay/standard 同一・
  // feeAmount=システム利用料)。lib/fee.calcBreakdown は standard で gas 項を無視する設計のため、
  // システム利用料を gas 項に載せると standard で消える → 専用 breakdown で **置換** する。
  // 非モバイルは従来 paymentBreakdown (byte 不変)。両者とも {customerPays/merchantReceives/feeAmount}。
  const breakdown = useMemo(
    () =>
      mobileFeeKind
        ? mobileOrderBreakdown(totalWei, mobileFeeKind, params.feePayer)
        : isRegisterStandardFee
          ? // レジ standard: 店舗負担 (顧客は表示額・店舗が利用料を受取から吸収)。利用料は別 tx で
            // feeReceiver へ (useStandardPayment の 2-tx 分割)。会計は feeAmount (システム利用料)。
            // モバイル注文の店舗負担と同一の分割なので feeSplit を共有する (下限ガードの単一情報源)。
            feeSplit(totalWei, registerFee, 'merchant')
          : paymentBreakdown({
              totalWei,
              token: params.token,
              payMode: effectiveMode,
              gasMode: effectiveGas,
              effectiveGasAmount,
            }),
    [
      mobileFeeKind,
      params.feePayer,
      isRegisterStandardFee,
      registerFee,
      totalWei,
      params.token,
      effectiveMode,
      effectiveGas,
      effectiveGasAmount,
    ],
  );

  const totalCustomerOutflow = breakdown.customerPays;
  // JPYC ガス無料化: JPYC は gas を一切徴収しないため 0 (OpenPay 全額負担)。mainnet USDC は
  // erc20 で 0、残る testnet USDC sponsorship fallback (非商用・非 JPYC) のみ従来どおり回収。
  const gasReimbursement = gasReimbursementValue(route, {
    isJpyc,
    paymasterMode,
    gasAmount,
  });

  // 記録用ネットワーク手数料相当額 (会計分離・on-chain transfer とは別)。非 circle の
  // gasless 経路は gas 見積を計上 (JPYC relay=回収額/0 or sponsorship=立替回収 / USDC erc20=
  // paymaster 徴収分)。circle は receipt 由来の circlePaymasterNetUsdc を使うため null、standard は null。
  // モバイル注文料金はシステム利用料 (breakdown.feeAmount) として記帳するため、ネットワーク手数料
  // 相当額には計上しない (二重計上回避・gas ではなくサービス利用料)。非モバイルは従来どおり。
  const networkFeeEquivalent = isMobileFee
    ? null
    : networkFeeEquivalentValue(route, effectiveGasAmount);
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

  const flowPending = isStandard
    ? standard.isPending
    : useRelay
      ? relay.isPending
      : gasless.isPending;
  // relay は gas quote も smart account も不要なので readiness は常に満たす。
  const gasQuoteReady = isStandard || useRelay || activeQuote.data !== undefined;
  // 運営の赤字防止: merchant が 0 になるケースは送信を block (fee>0 の Phase 2 で
  // 主に効く。fee=0 の現状で発火するのは gasless/merchant かつ total < gas のみ)。
  //   gasless / customer:  total < fee → merchant = 0
  //   gasless / merchant:  total < fee + gas → merchant = 0
  //   standard:            total < fee → merchant = 0
  // relay は固定 fee で見積待ちが無いので即判定可 (activeQuote ではなく useRelay で gate)。
  const merchantUnderflow =
    totalWei > 0n &&
    (isStandard || !isMerchantGas || useRelay || activeQuote.data !== undefined) &&
    breakdown.merchantReceives === 0n;
  const minimumAmountWei = deriveMinimumAmountWei({
    feeAmount: breakdown.feeAmount,
    isMerchantGas,
    effectiveGasAmount,
  });

  // 送金が確定 (または broadcast 済で確定しうる) 後の再送信を禁止。再送すると同一
  // 受取人へ 2 件目の on-chain 送金 = 二重支払いになる。revert (送金未成立) は安全
  // なので再試行を許す。standard の fee-error は merchant transfer が確定済なので
  // main ボタンは禁止し、fee の再送は専用 retryFee ボタンのみに限定する
  // (PaymentForm と同一防御)。
  const settledNoRetry =
    (!isStandard && !useRelay && !!gasless.data?.success) ||
    (useRelay && !!relay.data && (relay.data.success || !!relay.data.pending)) ||
    (isStandard && (!!standard.data || standard.isFeeError));

  const canSubmit =
    isConnected &&
    !wrongChain &&
    (isStandard || useRelay || !!saData) &&
    // PaymentForm と揃える明示ガード。現状は totalWei>0 (有効 items) 不変で merchantUnderflow
    // が拾うが、空 batch (merchant 受取 0) 送信を構造的にも塞ぐ defense-in-depth。
    breakdown.merchantReceives > 0n &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !flowPending &&
    gasQuoteReady &&
    !merchantUnderflow &&
    !settledNoRetry;

  const flowError = isStandard
    ? standard.error
    : useRelay
      ? relay.error
      : gasless.error;
  const saFallback =
    !isStandard && !useRelay && isIncompatibleSmartAccountError(saError);
  // 送信は成立したがチェーン上で revert したケース。gasless/relay は data.success===false、
  // standard は phase=*-error だが receipt 成功で Error 無し。無反応穴を明示メッセージで塞ぐ。
  const revertedNoFeedback =
    (!isStandard && !useRelay && !!gasless.data && !gasless.data.success) ||
    (useRelay && !!relay.data && !relay.data.success && !relay.data.pending) ||
    (isStandard &&
      (standard.isMerchantError || standard.isFeeError) &&
      !standard.error);
  // relay 経路の error は code 文字列 (rate_limited 等) なので friendly i18n に差し替える。
  const flowErrorMessage = useRelay
    ? flowError
      ? t(relayErrorKey(flowError))
      : undefined
    : flowError?.message;
  const error = isGasCongestedError(flowError)
    ? t('errorGasCongested')
    : (flowErrorMessage ??
      (isStandard || useRelay || saFallback ? undefined : saError?.message) ??
      (activeQuote.error ? t('errorGasQuote') : null) ??
      (merchantUnderflow
        ? t('errorMerchantUnderflow', { min: fmt(minimumAmountWei) })
        : null) ??
      (revertedNoFeedback ? t('errorReverted') : null));

  // B1 graceful degradation: relay が API レベルで失敗 (rate_limited 等の error code) したとき、
  // ガス代自己負担の「通常決済」へ 1 タップで切り替える導線を出す。on-chain revert
  // (relay.data.success===false) は別経路 (revertedNoFeedback) で扱うため、ここでは relay.error
  // (= API 失敗) のみを条件にする。banner の中で friendly 文言を 1 度だけ出し、下の汎用 error
  // ブロックでは重複表示しない (relayBannerActive で抑止)。
  const relayFallbackActive = useRelay && !!relay.error;
  // B1 Layer B (preflight): relay 経路で relayer が degraded、かつ顧客がまだ submit していない
  // (relay.error なし・relay.data なし) ときに、署名 *前* に同じ banner で「通常決済へ切替」を促す。
  // 優先順位: relay.error → Layer A (per-error 文言) / それ以外で preflight-degraded → Layer B
  // (固定の preflight 文言)。両方は出さない (relay.error が優先)。
  const relayPreflightActive =
    useRelay && relayHealth.degraded && !relay.error && !relay.data;
  // Layer A は汎用 error box を「置換」する (relay error の二重表示防止)、Layer B は「additive」
  // に出す (汎用 error box を抑止しない)。両者は !relay.error で排他。
  const relayFallbackMessage = relay.error ? t(relayErrorKey(relay.error)) : '';

  const [redirectIn, setRedirectIn] = useState<number | null>(null);
  // PayPay 風 大型成功 overlay。dismiss 後は inline 成功 panel + redirect countdown を表示。
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  // R: gasQuote refetch (30s) で breakdown が再計算 → notification effect が再実行
  //    される。同一 tx hash の重複 webhook を防ぐため key 単位の dedup gate を使う。
  const notifiedKeyRef = useRef<string | null>(null);

  // webhook/記録は「送金した瞬間の額」を報告する (成功描画時の live breakdown は
  // gas quote 再取得等で動きうるため、submit 時点の snapshot を真実とする)。
  // onSubmit が mutate へ渡すのと同源 (totalWei / breakdown) を固定する。
  const submitSnapshotRef = useRef<{
    totalWei: bigint;
    merchantReceives: bigint;
    feeAmount: bigint;
    customerPays: bigint;
  } | null>(null);

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
    if (activeQuote.error) logger.error('checkout.gas-quote.failed', { error: activeQuote.error });
  }, [activeQuote.error]);

  useEffect(() => {
    if (relay.error) logger.error('checkout.relay.failed', { error: relay.error });
  }, [relay.error]);

  useEffect(() => {
    if (relay.data) {
      logger.info('checkout.relay.success', {
        txHash: relay.data.txHash,
        success: relay.data.success,
      });
    }
  }, [relay.data]);

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
    if (!isStandard && !useRelay && gasless.data?.success) {
      return {
        key: gasless.data.userOpHash,
        mode: 'gasless' as const,
        blockNumber: gasless.data.blockNumber as bigint | null,
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
    // relay は txHash のみ (userOpHash / blockNumber 無し)。202 pending も txHash を持ちうるため
    // success を必須ガード (success を見ないと pending で webhook/redirect が誤発火する・Codex P1)。
    if (useRelay && relay.data?.success && relay.data.txHash) {
      return {
        key: relay.data.txHash,
        mode: 'gasless' as const,
        blockNumber: null as bigint | null,
        hashFields: { txHash: relay.data.txHash },
        redirectQuery: { tx_hash: relay.data.txHash },
      };
    }
    return null;
  }, [isStandard, useRelay, gasless.data, standard.data, relay.data]);

  useEffect(() => {
    if (!completion) return;
    // completion は同一セッションの submit 後 (mutation の in-memory data 由来) にのみ発火する
    // ため snapshot は必ず存在する。両ガードで型を自然に絞る (live breakdown への silent
    // fallback は乖離バグの再発口になるため書かない)。
    const snapshot = submitSnapshotRef.current;
    if (!snapshot) return;
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
        // amount = 税込注文小計 (totalWei・gas を含まない)。顧客の総支払いは customerPays、
        // 店主着金は merchantAmount。金額はすべて submit 時点の snapshot で固定する
        // (成功描画時の live 値ではない)。
        amount: formatUnits(snapshot.totalWei, deployment.decimals),
        items: params.items,
        merchantAmount: snapshot.merchantReceives.toString(),
        feeAmount: snapshot.feeAmount.toString(),
        customerPays: snapshot.customerPays.toString(),
        orderId: params.orderId,
        description: params.description,
        // URL 仕様 (lib/url.ts) で customerEmail は prefill 専用・クライアントから送信しない、
        // と明記しているため payload に含めない (orderId で突合可能)。
        ...completion.hashFields,
        // relay は block 不明 (txHash のみ)。null のときは payload から省略する
        // (下流 consumer が missing と null を区別するため・"null" 文字列にしない)。
        ...(completion.blockNumber !== null
          ? { blockNumber: completion.blockNumber.toString() }
          : {}),
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
    // 金額は submitSnapshotRef (ref・非 reactive) から読む。snapshot は submit と同期で固定され、
    // completion (mutation 解決) が変わるのはその後なので、ref で十分かつ live 値の混入を防げる。
  }, [
    completion,
    params.to,
    params.token,
    chainSlug,
    params.items,
    params.orderId,
    params.description,
    params.webhook,
    params.successUrl,
    address,
    deployment.chainId,
    deployment.decimals,
  ]);

  // ローカル履歴 (Phase 2) — gasless / standard 全 5 transition を hook で集約。
  // note には description (なければ orderId) を入れ、CSV/UI で会計補助情報に使う。
  // v5: itemized checkout の items を売上明細 (lineItems) として保存し、税/管理番号も記録。
  // productName は明細名の連結 (buildHistoryEntry で 80 文字 cap)、memo は description。
  const historyCtx = useMemo(
    () => ({
      chainId: deployment.chainId,
      chainSlug,
      asset: params.token,
      tokenAddress: deployment.address,
      payMode: isStandard ? ('standard' as const) : ('gasless' as const),
      gasMode: isStandard ? null : effectiveGas,
      merchant: params.to,
      merchantAmount: breakdown.merchantReceives,
      customer: address,
      feeReceiver: env.feeReceiver,
      feeAmount: breakdown.feeAmount,
      saleAmount: totalWei,
      networkFeeEquivalent,
      storeName: '',
      note: params.description ?? params.orderId ?? '',
      productName: params.items.map((it) => it.name).join(', '),
      memo: params.description ?? null,
      taxRate: params.taxRate ?? null,
      taxCategory: params.taxCategory ?? null,
      receiptNo: params.receiptNo ?? null,
      lineItems: params.items.map((it, i) => {
        // amount = price × qty を人間可読 decimal で (raw wei ではない)。
        const amount = formatUnits(
          calcCheckoutTotal([it], deployment.decimals),
          deployment.decimals,
        );
        // per-item 税を優先 (混在税率カート)、無ければ checkout 単位 (単一税率) に fallback。
        const taxRate = it.taxRate ?? params.taxRate ?? null;
        const taxCategory = it.taxCategory ?? params.taxCategory ?? null;
        const taxAmt = taxAmountDecimal(
          Number(amount),
          taxRate,
          taxDisplayDecimals(params.token),
        );
        return {
          id: String(i),
          name: it.name,
          quantity: it.qty,
          unitPrice: it.price,
          amount,
          currency: params.token,
          taxRate,
          taxCategory,
          taxAmount: taxAmt == null ? '0' : String(taxAmt),
          memo: it.memo ?? null,
        };
      }),
      // 顧客向け電子レシート (PayerReceipt) の発生元 / 表示 locale。
      sourceRoute: '/checkout',
      locale,
    }),
    [
      deployment.chainId,
      deployment.address,
      deployment.decimals,
      chainSlug,
      params.token,
      effectiveGas,
      params.to,
      params.description,
      params.orderId,
      params.items,
      params.taxRate,
      params.taxCategory,
      params.receiptNo,
      isStandard,
      breakdown.merchantReceives,
      breakdown.feeAmount,
      totalWei,
      networkFeeEquivalent,
      address,
      locale,
    ],
  );
  // relay 成功/失敗/pending を既存の gasless 履歴経路に流す合成 snapshot。relay は userOp/receipt
  // block を持たないため両者 null。amount は mutate() の variables で固定し drift を避ける。
  // recover は hook と同一式で split を再計算: feeAmount(=サービス料) は常に 0、ネットワーク手数料
  // 相当額 = 回収した gas (feeValue)、merchantAmount は customer 上乗せなら満額・merchant 吸収なら
  // 満額−fee、saleAmount は請求額 (value)。free は fee=0・netFee=0。pending は status='pending'。
  const relayHistoryGasless = useRelayGaslessSnapshot(
    relay,
    useRecover,
    deployment.chainId,
  );
  usePaymentHistory(
    historyCtx,
    useRelay ? relayHistoryGasless : gasless,
    standard,
  );

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
    // relay は block 不明 — 値があるときだけ付与 (redirectQuery も relay は tx_hash のみ)。
    if (completion.blockNumber !== null) {
      u.searchParams.set('block', completion.blockNumber.toString());
    }
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
    // webhook/記録は「送金した瞬間の額」を報告する (成功描画時の live breakdown は
    // gas quote 再取得等で動きうるため、submit 時点の snapshot を真実とする)。
    // 下の各 mutate は breakdown.merchantReceives / breakdown.feeAmount / totalWei を渡す
    // (relay は totalWei・recover 控除は hook 側)。snapshot はそれと同源。
    submitSnapshotRef.current = {
      totalWei,
      merchantReceives: breakdown.merchantReceives,
      feeAmount: breakdown.feeAmount,
      customerPays: breakdown.customerPays,
    };
    // 完了画面のチャイムを iOS でも鳴らせるよう、この gesture 内で AudioContext を解錠。
    primeChimeAudio();
    if (isStandard) {
      standard.mutate({
        tokenAddress: deployment.address,
        merchant: params.to,
        merchantAmount: breakdown.merchantReceives,
        feeReceiver: env.feeReceiver,
        feeAmount: breakdown.feeAmount,
        chainId: deployment.chainId,
        // 売上総額 = 商品小計 (totalWei)。顧客上乗せ時に merchant+fee で gross を over しないよう、
        // 履歴 snapshot に正しい gross を運ぶ (非モバイルは fee=0 で merchantAmount に一致)。
        saleAmount: totalWei,
      });
    } else if (useRelay) {
      // JPYC EIP-3009 relay: 顧客が transferWithAuthorization に署名 → 自前 relayer が gas 負担で
      // submit。fee=0・gas は OpenPay 肩代わり (free) or JPYC 回収 (recover・hook 内で分割)。
      // 全額 (totalWei) をそのまま relay に渡す (recover の控除は hook 側)。
      relay.mutate({
        merchant: params.to,
        value: totalWei,
        gasMode: effectiveGas,
        // モバイル注文 (storefront/preorder) のときだけ feeKind を載せる (server が定数表から % を
        // 再計算・on-chain 強制)。register(レジ) は relay では既存 recover が徴収するので渡さない。
        ...(mobileFeeKind ? { feeKind: mobileFeeKind } : {}),
      });
    } else {
      gasless.mutate({
        tokenAddress: deployment.address,
        merchant: params.to,
        merchantAmount: breakdown.merchantReceives,
        feeReceiver: env.feeReceiver,
        feeAmount: breakdown.feeAmount,
        gasReimbursement,
        saleAmount: totalWei,
        networkFeeEquivalent: networkFeeEquivalent ?? undefined,
        circlePermitAmount,
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
    : useRelay
      ? !!(relay.data && relay.data.success)
      : !!(gasless.data && gasless.data.success);

  // PayPay 風 大型成功 overlay の payload (Phase 1.4)。従来は gasless / relay / standard 経路ごとに
  // 3 連で SuccessOverlay を出していたのを、各経路と byte 一致する payload 1 個に集約する。各
  // ガードは従来の `completed && <mode> && <data>` と同値 (completed は mode 別に success/data を
  // 既に要求するため、各 `completed && gasless.data` 等は data.success と一致)。relay は userOpHash/
  // blockNumber を省き (undefined)、standard は userOpHash を省く — いずれも従来の overlay 呼び出しと
  // 同じ。amountDisplay=fmt(totalCustomerOutflow)・merchantAddress=params.to・explorerBase は全経路
  // 共通で従来どおり。
  const successOverlayPayload: PaymentSuccessOverlayPayload | null =
    !isStandard && !useRelay && gasless.data && gasless.data.success
      ? {
          amountDisplay: fmt(totalCustomerOutflow),
          txHash: gasless.data.txHash,
          userOpHash: gasless.data.userOpHash,
          blockNumber: gasless.data.blockNumber,
          explorerBase,
          merchantAddress: params.to,
          orderNo: params.orderId, // 受注番号 (受け渡し照合用・order_id があるときのみ表示)
        }
      : useRelay && relay.data?.success && relay.data.txHash
        ? {
            amountDisplay: fmt(totalCustomerOutflow),
            txHash: relay.data.txHash,
            explorerBase,
            merchantAddress: params.to,
            orderNo: params.orderId,
          }
        : isStandard && standard.data
          ? {
              amountDisplay: fmt(totalCustomerOutflow),
              txHash: standard.data.merchantTxHash,
              blockNumber: standard.data.blockNumber,
              explorerBase,
              merchantAddress: params.to,
              orderNo: params.orderId,
            }
          : null;

  // 「署名安心 UX」(plans/sign-reassurance-ux.md・P2)。経路別に kind を出し分ける (計画 §3.3)。
  //   (a) relay free (forwarder 未設定): jpyc-relay-free フルパネル。preview は relay.mutate に
  //       渡す変数 (params.to / totalWei) と同一ソース。testnet 等 forwarder 無し chain 用。
  //   (a') relay recover (forwarder 設定済・本番): jpyc-relay-recover フルパネル (P4)。to=forwarder
  //       で customer は totalWei+fee をウォレットに出すため照合表で内訳を説明。preview は
  //       relay.mutate の変数 (params.to / totalWei / params.gas) と同一ソース。forwarder 無しなら
  //       build が null → free 経路へ倒れる。
  //   (b) standard: 通常の送金確認 1 行ヒント。
  //   (c) Circle (USDC gasless): usdc-permit。permitCap は circle quote の permitAmount を
  //       formatUnits (未取得なら省略)。checkout は split 非対応のため transferCount は出さない。
  // 署名内容は不変・表示のみ。Pimlico 7702 経路 (非 relay JPYC sponsorship 等) はスコープ外。
  const showRelayFree =
    useRelay &&
    jpycForwarderFor(chainId ?? deployment.chainId) === null &&
    totalWei > 0n;
  const recoverPreview =
    useRecover && totalWei > 0n
      ? buildJpycRecoverSignPreview({
          value: totalWei,
          merchant: params.to,
          decimals: deployment.decimals,
          displaySymbol: deployment.displaySymbol,
          chainId: chainId ?? deployment.chainId,
          gasMode: effectiveGas,
        })
      : null;
  const signReassurance: SignReassuranceProps | null = showRelayFree
    ? {
        kind: 'jpyc-relay-free',
        preview: buildJpycRelaySignPreview({
          value: totalWei,
          merchant: params.to,
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
      : isStandard
      ? { kind: 'standard' }
      : isCircle && totalWei > 0n
        ? {
            kind: 'usdc-permit',
            amountHuman: formatUnits(totalWei, deployment.decimals),
            symbol: deployment.displaySymbol,
            permitCapHuman:
              circlePermitAmount !== undefined
                ? formatUnits(circlePermitAmount, deployment.decimals)
                : undefined,
            awaiting: gasless.isPending,
          }
        : null;

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
            {/* fee=0 のとき手数料行は非表示 (Phase 1 alpha)。負担者でラベルを出し分ける:
                店舗が受取から吸収した (merchantReceives < 請求額) なら「(店舗負担)」を補足、
                顧客上乗せ (事前モバイルオーダーの顧客負担) なら補足なし。 */}
            {breakdown.feeAmount > 0n && (
              <Row
                label={
                  breakdown.merchantReceives < totalWei
                    ? t('feeRowMerchant')
                    : t('feeRow')
                }
                value={fmt(breakdown.feeAmount)}
              />
            )}
            {isStandard ? (
              <Row label={t('gasRowStandard')} value={t('gasRowStandardValue')} />
            ) : isMobileFee ? (
              /* モバイル注文 (gasless): ネットワーク手数料は利用料 (feeRow) に含むため別行を出さない
                 (relayGasEquiv=0 で「0 JPYC」表示になり紛らわしい)。standard 経路は上の分岐で
                 顧客がウォレットで gas を払うので従来どおり gas 行を表示する (ここには来ない)。 */
              null
            ) : useRecover ? (
              <Row
                label={isMerchantGas ? t('gasRowMerchant') : t('gasRow')}
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
            : isMobileFee
              ? t('gaslessHintMobile')
              : useRecover
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

      {/* 署名安心パネル/ヒント (支払いボタン直上)。経路別に kind を出し分ける (計画 §3.3)。
          完了後は出さない。表示専用で決済ロジックには触れない。 */}
      {!completed && signReassurance && (
        <SignReassurance {...signReassurance} />
      )}

      {/* Recover モードの手数料開示 (支払いボタン直上)。free モード / 非 recover では
          RecoverFeeNotice が null を返して何も描画しない。JPYC recover は店舗吸収固定
          (effectiveGas=merchant)。
          モバイル注文 (システム利用料) では出さない: recover の gas 額を算出してしまい
          店舗受取が「決済額 − 1%」でなく「決済額 − gas 相当 (約 2 JPYC)」になり不正確で、
          かつお客様には店舗受取の内訳は不要なため (利用料は上の feeRow が表示済み)。 */}
      {!completed && !isMobileFee && (
        <RecoverFeeNotice
          billAmount={useRecover && totalWei > 0n ? totalWei : null}
          chainId={deployment.chainId}
          gasMode={effectiveGas}
        />
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
                : !isStandard && !useRelay && !saData
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

      {/* B1 Layer A: relay の API レベル失敗は「通常決済へ切替」banner で出し汎用 error box を
          抑止する (relay error の二重表示防止)。それ以外の error は従来どおり赤ボックス。完了後は出さない。 */}
      {!completed &&
        (relayFallbackActive ? (
          <RelayFallbackBanner
            message={relayFallbackMessage}
            nativeToken={nativeToken}
            onSwitchToStandard={() => setModeOverride('standard')}
          />
        ) : (
          error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              <p className="font-semibold">{t('errorTitle')}</p>
              <p className="mt-1 break-words">{error}</p>
            </div>
          )
        ))}

      {/* B1 Layer B (preflight): relayer degraded は additive banner で出す (Layer A と違い汎用
          error box を抑止しない・pre-submit 検証エラー[店主受取0 等]を隠さない・Codex P1)。完了後は出さない。 */}
      {!completed && relayPreflightActive && (
        <RelayFallbackBanner
          message={t('relayDegradedPreflight')}
          nativeToken={nativeToken}
          onSwitchToStandard={() => setModeOverride('standard')}
        />
      )}

      {completed && (gasless.data || standard.data || relay.data) && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <p className="font-semibold">{t('successTitle')}</p>
          <p className="mt-1 text-xs">{t('successBody')}</p>
          <dl className="mt-3 space-y-1 text-xs">
            {!isStandard && !useRelay && gasless.data && (
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
            {/* relay は userOp/block を持たないため Tx Hash のみ表示 (Explorer は overlay 側)。 */}
            {useRelay && relay.data?.success && relay.data.txHash && (
              <ResultRow
                label={t('successTx')}
                value={relay.data.txHash}
                copyable
              />
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

          {/* 顧客向け電子レシート (支払い控え) を完了画面にも埋め込む。 */}
          <div className="mt-4">
            <PayerReceiptCompletion
              candidateIds={[
                standard.data?.merchantTxHash,
                gasless.data?.txHash,
                gasless.data?.userOpHash,
                relay.data?.txHash ?? undefined,
              ]}
            />
          </div>

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

      {/* relay pending: broadcast 済だが未確定。standard へ fallback させず「確認待ち」を表示
          (再送信は canSubmit の settledNoRetry で禁止)。txHash があれば Explorer で追跡。 */}
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
          success_url 指定時は overlay 表示中も 3 秒 countdown が並走する仕様。gasless / relay /
          standard の 3 連は共通 PaymentSuccessOverlay へ集約 (payload で mode 差を吸収・挙動不変)。 */}
      <PaymentSuccessOverlay
        dismissed={overlayDismissed}
        payload={successOverlayPayload}
        onDismiss={() => setOverlayDismissed(true)}
      />
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

