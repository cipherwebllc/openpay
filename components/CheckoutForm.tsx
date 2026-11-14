'use client';

// セキュリティ: 受注 notify の payload と success_url の query は顧客側で改ざん可能
// (Stripe の whsec_ 署名相当の保証はない)。受注 notify (/api/order/notify) は tx_hash を
// on-chain で再検証してから受注を確定し、success_url を受けるマーチャントも同じ責務を負う。
// 第三者 webhook (URL の `webhook=` が外部 origin を指す POST) は退役済み (2026-10 user 裁定 R1):
// #655 の CSP (connect-src) でブラウザがすべて遮断していたため送らず、値が残っていても無視する。
// `webhook=` は OpenPay 自身の受注 notify (同一 origin の `/api/order/notify?h=`) の搬送にだけ使う。

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits, type Address } from 'viem';
import { useAccount } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { SmartAccountFallbackBanner } from './SmartAccountFallbackBanner';
import { RelayFallbackBanner } from './RelayFallbackBanner';
import { isRemoteOrderCheckout, NotifyShopButton, type NotifyShopData } from './NotifyShopButton';
import { notifyShopData } from './checkout/notifyShopData';
import { RelayStatusBanners } from './checkout/RelayStatusBanners';
// 送信後の pending / unknown の枠 (First Load JS から外す lazy wrapper・RelayStatusBanners と 1 つを共有する)。
import { PaymentStatusPanel } from './checkout/paymentStatusPanelLazy';
import { WrongChainSwitch } from './checkout/WrongChainSwitch';
import { WalletBalance } from './checkout/WalletBalance';
import { CheckoutItemList } from './checkout/CheckoutItemList';
import { CheckoutAmountBreakdown } from './checkout/CheckoutAmountBreakdown';
import { CheckoutHeader } from './checkout/CheckoutHeader';
import { CheckoutCompletion } from './checkout/CheckoutCompletion';
import { shopContactLabel } from '@/lib/shopContact';
import { rememberOrderPayment, type RememberedOrderPayment } from '@/lib/orderConfirmation';
import { checkoutSettlementScreen, findRememberedOrderPayment } from '@/lib/orderPaidLookup';
import {
  PaymentSuccessOverlay,
  type PaymentSuccessOverlayPayload,
} from './PaymentSuccessOverlay';
import type { SignReassuranceProps } from './SignReassurance';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useGasQuote } from '@/hooks/useGasQuote';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import {
  ORDER_MEMO_STORAGE_PREFIX,
  isOwnOrderNotifyUrl,
  useCheckoutOrderNotify,
} from '@/hooks/useCheckoutOrderNotify';
import { usePaymentRoute } from '@/hooks/usePaymentRoute';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import type { PaymentRoute } from '@/lib/paymentRoute';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import {
  mobileOrderBreakdown,
  mobileOrderGasMode,
  type MobileOrderFeeKind,
} from '@/lib/mobileOrderFee';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
import {
  isFallbackSafeRelayError,
  isIntentStorageUnavailableError,
  isOrderBindingStorageUnavailableError,
} from '@/lib/relay/relayResponseError';
import { isUserRejection } from '@/lib/walletErrors';
import { useSwitchChainWithFeedback } from '@/hooks/useSwitchChainWithFeedback';
import { deriveCheckoutGuards } from '@/lib/paymentFlowGuards/checkout';
import { isForeignSettlement } from '@/lib/paymentFlowGuards/restoredSettlement';
import { generateStatusToken } from '@/lib/orderStatusToken';
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
import { blockExplorerUrl, chainForSlug, type ChainSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { primeChimeAudio } from '@/lib/successChime';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { circleErrorKey } from '@/lib/circleErrorKey';
import { isIncompatibleSmartAccountError } from '@/lib/accountDetection';
import { logger } from '@/lib/logger';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { useRelayGaslessSnapshot } from '@/hooks/useRelayGaslessSnapshot';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import {
  calcCheckoutPayable,
  calcCheckoutTotal,
  offOriginCallbackHosts,
  type CheckoutParams,
} from '@/lib/url';
import { useOrigin } from '@/hooks/useOrigin';
import { buildCheckoutLineItems } from '@/lib/checkoutLineItems';
import { formatTokenAmount, shortAddress } from '@/lib/format';
import {
  buildJpycRelaySignPreview,
  buildJpycRecoverSignPreview,
} from '@/lib/signPreview';
import { parseOwnOrderNotifyUrl } from '@/lib/order/ownNotifyUrl';
import type { CanonicalOrder } from '@/lib/orderBind';
import { matchesOrderDeliveryContext } from '@/lib/orderDeliveryContext';
import { checkoutIntentContextFingerprint, orderLinkContextFingerprint } from '@/lib/checkoutIntentContext';
import { RecoverFeeNotice } from './RecoverFeeNotice';

const SignReassurance = dynamic(
  () => import('./SignReassurance').then((m) => m.SignReassurance),
);

export function CheckoutForm({ params }: { params: CheckoutParams }) {
  const t = useTranslations('CheckoutForm');
  const tc = useTranslations('CircleErrors');
  const locale = useLocale();
  const boundOrderRef = useRef<CanonicalOrder | null>(null);
  const boundOrderPreparingRef = useRef(false);
  const [bindingStorageError, setBindingStorageError] = useState(false);
  const [bindingInputError, setBindingInputError] = useState(false);
  const router = useRouter();
  const [modeOverride, setModeOverride] = useState<'standard' | null>(null);
  const [orderAdmissionPending, setOrderAdmissionPending] = useState(false);
  const [orderAdmissionRejected, setOrderAdmissionRejected] = useState(false);
  const orderAdmissionInFlightRef = useRef(false);
  const attemptRouteRef = useRef<PaymentRoute | null>(null);

  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const paymasterMode = resolvePaymasterMode(deployment);
  // JPYC ガス無料化: JPYC ガスレスは recover を除き常に無徴収 (relay free / 非 relay
  // sponsorship free のいずれも OpenPay が gas を全額負担)。USDC は従来どおり。
  const isJpyc = deployment.symbol === 'jpyc';

  const { address, isConnected, chainId } = useAccount();
  // 切り替えの失敗を画面に知らせ、記録に残す (hooks/useSwitchChainWithFeedback.ts)。
  const { switchChain, isPending: isSwitching, failed: switchFailed } = useSwitchChainWithFeedback('checkout');
  // sessionStorage に broadcast 済み standard intent が残る場合、元 URL が gasless でも
  // standard の receipt 復元を本線に固定する。storage 読込中は下の readiness で全経路を止める。
  const standard = useStandardPayment();

  // F7: success_url / cancel_url のうち、現在の origin と host が異なる第三者ホスト。
  // これらは決済後 (または中止時) の遷移先になり得るため、支払い前に payer へ明示開示する
  // (block はしない — 正当な off-origin マーチャント redirect が存在する)。`webhook=` は第三者へ
  // 送らなくなった (退役) ので開示の対象から外す。origin 未確定 (SSR / hydrate 前) は空配列 =
  // 開示なし (false-positive 防止)。
  const origin = useOrigin();
  const offOriginHosts = useMemo(
    () =>
      origin
        ? offOriginCallbackHosts(
            [params.successUrl, params.cancelUrl],
            new URL(origin).host,
          )
        : [],
    [origin, params.successUrl, params.cancelUrl],
  );

  // 支払額 = 明細の合計 − レジの値引き (値引きが無ければ合計そのまま・plans/register-discount.md)。
  const totalWei = useMemo(
    () => calcCheckoutPayable(params, deployment.decimals),
    [params, deployment.decimals],
  );
  const mobileFeeKind: MobileOrderFeeKind | null =
    env.enableMobileOrderFee &&
    (params.feeKind === 'storefront' || params.feeKind === 'preorder')
      ? params.feeKind
      : null;
  const orderTotalValue = mobileFeeKind
    ? mobileOrderBreakdown(totalWei, mobileFeeKind, params.feePayer).customerPays : totalWei;
  const orderContext = useMemo(() => ({ merchant: params.to, chainId: deployment.chainId,
    tokenAddress: deployment.address, webhook: params.webhook, orderId: params.orderId, totalValue: orderTotalValue }),
  [params.to, deployment.chainId, deployment.address, params.webhook, params.orderId, orderTotalValue]);
  const relay = useJpycEip3009Payment(deployment, { restoreOrderDelivery: true, orderContext });
  const matchingDelivery = relay.orderDelivery && matchesOrderDeliveryContext(
    relay.orderDelivery.order, orderContext, typeof window === 'undefined' ? '' : window.location.origin, relay.orderDelivery.intent,
  ) ? relay.orderDelivery : null;
  // 決済経路の単一情報源 (Phase 1.1)。散在していた isStandard / useRelay / useRecover / isCircle を
  // この 1 値から導出する。引数は現行どおりに算出した値で、resolver に聞くのは hooks/usePaymentRoute.ts。判定の優先順位・短絡は
  // resolvePaymentRoute が現行ロジックをそのまま再現する (挙動不変)。
  //   - standardRequested: params.mode='standard' か SA fallback の override。
  //   - JPYC ガスレスを EIP-3009 relay に倒すか (flag ON + JPYC + relay 対応 chain)。OFF / 非対応は
  //     'pimlico-7702' で従来挙動 (Pimlico fallback)。relay は smart account / gas quote 不要で、顧客が
  //     署名するだけ・自前 relayer がガス負担 (memory:jpyc-eip3009)。checkout は split 非対応なので
  //     PaymentForm のような split ガードは要らない (disableRelay は false)。
  //   - recover: forwarder 設定済 chain は gas 相当額を JPYC 回収 (gasMode で顧客上乗せ/店主吸収)。
  //     未設定は free (OpenPay 負担)。
  //   - USDC ガスレスが Circle に解決される場合は surcharge 込み quote + permit allowance。
  const { route, isStandard, useRelay, useRecover, isCircle } = usePaymentRoute({
    deployment,
    walletChainId: chainId,
    standardRequested:
      params.mode === 'standard' ||
      modeOverride === 'standard' ||
      standard.hasAttempt,
    disableRelay: false,
    // submit gesture で選ばれた経路を attempt 単位で固定し、relay POST 中に degraded banner の
    // standard 切替が競合しても進行中の money-path を差し替えない。
    // 固定が無く、復元した relay の注文があるときは、その注文の経路 (relay) にする。どちらも無ければ null で、
    // hook が resolver に聞いて決めた経路になる。
    pinnedRoute: attemptRouteRef.current ??
      (matchingDelivery && relay.restoredIntent
        ? { kind: 'relay', recover: relay.restoredIntent.routeKind === 'recover' } : null),
  });
  const isErc20Paymaster = !isStandard && paymasterMode === 'erc20';
  // B1 Layer B: relay 経路でのみ relayer の事前 (preflight) 健全性を polling する。degraded なら
  // 署名 *前* に「通常決済へ切替」を先回り案内する (Layer A は submit 失敗 *後* の reactive な導線)。
  // fail-open (読込中/error は degraded:false) なので advisory に徹し決済実行には影響しない。
  const relayHealth = useRelayHealth({
    chainId: deployment.chainId,
    enabled: useRelay,
  });

  // 確定モデル (2026-06-12): JPYC recover 決済は店舗が常に手数料を吸収する固定 (gasMode=merchant)。
  // 旧 QR が gas=customer を載せていても無視し merchant に倒す (発行済 QR の audience は極小で
  // user-approved)。recover 以外は URL の gas をそのまま使う (USDC の負担者トグルは不変)。
  // money 計算は route 駆動の純関数 (lib/paymentMoney) に一元化済 (Phase 1.2・式は不変)。
  // モバイル注文システム利用料 (storefront/preorder)。flag ON + feeKind が storefront/preorder の
  // ときだけ経路非依存に 1%(店頭)/3%(事前) を分割する。負担者 (店舗負担=merchant / 顧客上乗せ=
  // customer) は mode/feePayer から確定し effectiveGasMode を上書きする (顧客上乗せ preorder では
  // recover でも customer が必要)。feeKind 無し・/pay・/tip・通常 checkout は従来動作のまま (一切不変)。
  const isMobileFee = mobileFeeKind !== null;
  // 課金 flag とは独立に、@handle 注文の元 storefront mode を署名前 admission へ渡す。
  // feeKind は MobileOrderView が常に付与し、課金自体は上の mobileFeeKind gate が決める。
  const orderAdmissionMode =
    params.storeHandle &&
    (params.feeKind === 'storefront' || params.feeKind === 'preorder')
      ? params.feeKind
      : null;
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
  const gasQuote = useGasQuote(deployment, !isStandard && !useRelay);
  // USDC ガスレスが Circle に解決される場合は surcharge 込み quote + permit allowance (route 由来)。
  const circleQuote = useGasQuoteCircle(deployment, !isStandard && isCircle);
  const activeQuote = isCircle ? circleQuote : gasQuote;
  const circlePermitAmount = isCircle ? circleQuote.data?.permitAmount : undefined;

  // relayGasEquiv (= recover 時の利用料) は totalWei 確定後に算出する
  // (CDX-3: 実スケジュール recoverFeeValue を使い、bps>0 で会計サマリと実 settle 額を一致させる)。
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
  // この会計が受注を OpenPay 自身の notify (`/api/order/notify?h=`・モバイル注文) へ送るか。完了時の受注通知と
  // relay の注文の束縛 (onSubmit) と同じ条件 (isOwnOrderNotifyUrl)。notify は JPYC だけを受け付け、受注の下限
  // (ORDER_DUST_FLOOR_WEI) も JPYC の単位なので JPYC に限る。origin 未確定 (hydrate 前) は false。
  const sendsOrderNotify =
    isJpyc && !!origin && !!params.webhook && isOwnOrderNotifyUrl(params.webhook, origin);

  // 再送封鎖・flow pending・送信可否は /checkout 専用の policy (注文受付と同一店舗 hold を含む) に置く
  // (R14・式は移動のみ)。admission の await 後は canSubmit でなく paymentReady を読み直す (onSubmit)。
  const {
    relayAmbiguous,
    gaslessAmbiguous,
    gaslessStoreUnavailable,
    gaslessResendBlocked,
    relayIpRateLimited,
    flowPending,
    gasQuoteReady,
    settledNoRetry,
    paymentReady,
    canSubmit,
    orderBelowDustFloor,
  } = deriveCheckoutGuards({
    isStandard,
    useRelay,
    standard,
    relay,
    gasless,
    orderAdmissionPending,
    activeQuote,
    isConnected,
    wrongChain,
    saData,
    breakdown,
    insufficientBalance,
    merchantUnderflow,
    sendsOrderNotify,
  });
  const standardUnknownTxHash = standard.isFeeUnknown
    ? standard.feeTxHash
    : standard.merchantTxHash;

  // 未接続時に最下部 CTA からウォレット選択セクションへ誘導するためのアンカー。
  const walletSectionRef = useRef<HTMLElement | null>(null);
  const paymentReadyRef = useRef(paymentReady);
  paymentReadyRef.current = paymentReady;

  // お客様がウォレットで署名を拒否した (自分で取り消した) のは失敗ではない。「ガスレス決済を完了
  // できませんでした」や通常決済への切替を出さずに送信前の画面へ戻し、Sentry にも送らない
  // (ConnectButton と同じ扱い)。拒否の件数は useJpycEip3009Payment が payment.sign_rejected (info)
  // で数えている。switchToStandard の二重払い防止は生の relay.error で判定する (拒否は fallback-safe
  // なので、取り消したあとも通常決済へ切り替えられる)。
  const relayError = relay.error && !isUserRejection(relay.error) ? relay.error : null;
  const flowError = relayAmbiguous || gaslessAmbiguous
    ? null
    : isStandard
    ? standard.isUnknown
      ? null
      : standard.error
    : useRelay
      ? relayError
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
  // 束縛した注文の slot を保存できずに止めた error は、汎用の文 (「通常モードをご利用ください」) を出さない。下の専用の
  // 黄色の枠 (orderBindingStorageUnavailable) だけで知らせる (user 裁定 Q8 = A・lib/relay/relayResponseError)。
  // Circle の経路 (USDC ガスレス) の error は、場面の符号 (circleCode) から locale の文を出す (lib/circleErrorKey.ts・第 10 回
  // レビュー PR-39c)。符号の無い error は今までどおり message をそのまま出す。
  const circleKey = circleErrorKey(flowError);
  const flowErrorMessage = useRelay
    ? isFallbackSafeRelayError(flowError) && !isOrderBindingStorageUnavailableError(flowError)
      ? t(relayErrorKey(flowError))
      : undefined
    : circleKey
      ? tc(circleKey)
      : flowError?.message;
  const error = orderAdmissionRejected
    ? t('orderNotAccepting')
    : isGasCongestedError(flowError)
      ? t('errorGasCongested')
      : (flowErrorMessage ??
        (isStandard || useRelay || saFallback ? undefined : saError?.message) ??
        (activeQuote.error ? t('errorGasQuote') : null) ??
        (merchantUnderflow
          ? t('errorMerchantUnderflow', { min: fmt(minimumAmountWei) })
          : null) ??
        (orderBelowDustFloor ? t('errorOrderMerchantBelowFloor') : null) ??
        (revertedNoFeedback ? t('errorReverted') : null));

  // B1 graceful degradation: relay が API レベルで失敗 (rate_limited 等の error code) したとき、
  // ガス代自己負担の「通常決済」へ 1 タップで切り替える導線を出す。on-chain revert
  // (relay.data.success===false) は別経路 (revertedNoFeedback)、response-unknown は再送封鎖で
  // 扱うため、ここでは fallback-safe error のみを条件にする。banner の中で friendly 文言を
  // 1 度だけ出し、下の汎用 error ブロックでは重複表示しない。復旧の枠を書けない端末で止めた error は切り替えを案内せず、
  // 汎用 error ブロックに出す (通常決済にも同じ穴がある・user 裁定 Q7-1・lib/relay/relayResponseError)。束縛した注文の slot を
  // 保存できずに止めた error も同じ理由で切り替えを案内せず、専用の黄色の枠だけを出す (user 裁定 Q8 = A)。
  const relayFallbackActive =
    useRelay &&
    !relay.isPending &&
    !relayAmbiguous &&
    isFallbackSafeRelayError(relayError) &&
    !isIntentStorageUnavailableError(relayError) &&
    !isOrderBindingStorageUnavailableError(relayError);
  // B1 Layer B (preflight): relay 経路で relayer が degraded、かつ顧客がまだ submit していない
  // (relay.error なし・relay.data なし) ときに、署名 *前* に同じ banner で「通常決済へ切替」を促す。
  // 優先順位: relay.error → Layer A (per-error 文言) / それ以外で preflight-degraded → Layer B
  // (固定の preflight 文言)。両方は出さない (relay.error が優先)。
  const relayPreflightActive =
    useRelay &&
    relayHealth.degraded &&
    !relay.isPending &&
    !relayAmbiguous &&
    !relayError &&
    !relay.data;
  // Layer A は汎用 error box を「置換」する (relay error の二重表示防止)、Layer B は「additive」
  // に出す (汎用 error box を抑止しない)。両者は !relayError で排他。
  const relayFallbackMessage = isFallbackSafeRelayError(relayError)
    ? t(relayErrorKey(relayError))
    : '';

  const [redirectIn, setRedirectIn] = useState<number | null>(null);
  // PayPay 風 大型成功 overlay。dismiss 後は inline 成功 panel + redirect countdown を表示。
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  // webhook/記録は「送金した瞬間の額」を報告する (成功描画時の live breakdown は
  // gas quote 再取得等で動きうるため、submit 時点の snapshot を真実とする)。
  // onSubmit が mutate へ渡すのと同源 (totalWei / breakdown) を固定する。
  const submitSnapshotRef = useRef<{
    totalWei: bigint;
    merchantReceives: bigint;
    feeAmount: bigint;
    customerPays: bigint;
  } | null>(null);
  // 遠隔の注文の確認の署名をしてもらうウォレット (支払いを送った時点の接続先)。
  const submittedPayerRef = useRef<Address | undefined>(undefined);
  // このタブで払った記録は、リンクが受け付ける全部のチェーンで探す (別のチェーンを選んで二重に払わせない)。
  // 記録があれば払うボタンを止める。何度でも使えるリンクは「新しい注文として払う」で別の注文として払える
  // (番号つきの注文は同じ注文なので払わせない・Codex P1)。
  const remoteOrder = isRemoteOrderCheckout(params);
  const [rememberedPayment, setRememberedPayment] = useState<{
    chain: ChainSlug;
    payment: RememberedOrderPayment;
  } | null>(null);
  const [newPurchase, setNewPurchase] = useState(false);
  useEffect(() => {
    if (!remoteOrder) return;
    setRememberedPayment(findRememberedOrderPayment(params, Date.now()));
  }, [remoteOrder, params]);
  const paidInThisTab = remoteOrder && rememberedPayment !== null && !newPurchase;

  // relay 成功/失敗/pending を既存の gasless 履歴経路に流す合成 snapshot。
  const relayHistoryGasless = useRelayGaslessSnapshot(
    relay,
    useRecover,
    deployment.chainId,
  );
  const checkoutContextKey = useMemo(
    () =>
      checkoutIntentContextFingerprint({
        params,
        chainId: deployment.chainId,
        tokenAddress: deployment.address,
        totalAtomic: totalWei.toString(),
      }),
    [
      deployment.address,
      deployment.chainId,
      params,
      totalWei,
    ],
  );
  const restoredStandardOrderAttempt = useMemo(() => {
    const submitted = standard.lastSubmittedParams;
    const sameAddress = (left: string, right: string) =>
      left.toLowerCase() === right.toLowerCase();
    if (
      !standard.restoredFromStorage ||
      submitted?.contextKey !== checkoutContextKey ||
      submitted.chainId !== deployment.chainId ||
      !sameAddress(submitted.tokenAddress, deployment.address) ||
      !sameAddress(submitted.merchant, params.to) ||
      !sameAddress(submitted.feeReceiver, env.feeReceiver) ||
      submitted.merchantAmount !== breakdown.merchantReceives ||
      submitted.feeAmount !== breakdown.feeAmount ||
      submitted.saleAmount !== totalWei
    ) {
      return null;
    }
    return {
      snapshot: {
        totalWei: submitted.saleAmount,
        merchantReceives: submitted.merchantAmount,
        feeAmount: submitted.feeAmount,
        customerPays:
          submitted.merchantAmount + submitted.feeAmount,
      },
      from: standard.lastSubmittedFrom,
    };
  }, [
    breakdown.feeAmount,
    breakdown.merchantReceives,
    checkoutContextKey,
    deployment.address,
    deployment.chainId,
    params.to,
    standard.lastSubmittedFrom,
    standard.lastSubmittedParams,
    standard.restoredFromStorage,
    totalWei,
  ]);
  // 注文リンクの支払いの指紋 (第 9 回レビュー G-1)。注文リンクの支払いにだけ復旧 intent へ残し、読み直した後の完了を
  // 「この注文リンク」の支払いにだけ結び付ける。会計の指紋 (checkoutContextKey) は ship を含まず、普通の /checkout と
  // 同じ明細の「何度でも使える」リンクで同じ値になるため、既存の照合の意味は変えずに別の指紋で区別する。
  const orderLinkKey = useMemo(
    () => (remoteOrder ? orderLinkContextFingerprint(checkoutContextKey, params) : null),
    [checkoutContextKey, params, remoteOrder],
  );
  // 読み直した画面で復元した通常決済の支払いが、この注文リンクのものか: 既存の照合 (restoredStandardOrderAttempt) に
  // 加え、注文リンクの指紋が一致するときだけ (指紋の無い復元 = 普通の /checkout や以前の保存は一致としない)。
  const restoredStandardOrderLinkAttempt =
    restoredStandardOrderAttempt !== null &&
    orderLinkKey !== null &&
    standard.lastSubmittedParams?.orderLinkKey === orderLinkKey
      ? restoredStandardOrderAttempt
      : null;
  // 読み直した画面で復元した relay の支払いが、この注文リンクのものか。注文の同一性は注文リンクの指紋 (明細・番号・
  // ship)・署名したチェーン・お店で確かめ、金額は保存した intent の実際の値を注文の合計と照らす。利用料は今の設定で
  // 計算し直さない (払った後に率やフロアが変わっても記録を失わない)。今のウォレットのチェーンで決まる経路 (route・
  // breakdown) にも依存させない (別のチェーンのまま読み直しても記録を残す)。経路は intent の routeKind で分ける:
  //   free: お店の受取 = 合計・利用料 0 (hook が '0' を入れる)。
  //   recover: お店の受取 + 利用料 = 合計・利用料 > 0。注文リンクにモバイル注文の利用料は無く recover は常にお店の負担
  //   (effectiveGasMode) なので、利用料は合計から引かれる形になる。forwarder は利用料 0 を revert し、フロアは 0 を
  //   採らないので、成立した recover の利用料は必ず 1 以上。お客様の上乗せの形 (受取 = 合計) は合計を超えて一致しない。
  const restoredRelayOrderIntent = useMemo(() => {
    const intent = relay.restoredIntent;
    if (!intent || orderLinkKey === null || intent.orderLinkKey !== orderLinkKey) return null;
    const merchantValue = BigInt(intent.merchantValue);
    const feeValue = BigInt(intent.feeValue);
    const amountMatches =
      intent.routeKind === 'recover'
        ? feeValue > 0n && merchantValue + feeValue === totalWei
        : feeValue === 0n && merchantValue === totalWei;
    if (
      intent.chainId !== deployment.chainId ||
      intent.merchant.toLowerCase() !== params.to.toLowerCase() ||
      !amountMatches
    ) {
      return null;
    }
    return intent;
  }, [deployment.chainId, orderLinkKey, params.to, relay.restoredIntent, totalWei]);
  const restoredCheckoutCompletion =
    // 通常決済: hook の restoredFromStorage は利用料の再送 (retryFee) で false に戻るので、復元した試みの印
    // (restoredAttempt・新しい mutate でだけ false) も見る (第 10 回レビュー H-U: 復元した別の支払いの利用料を再送した後の
    // 完了を、この画面の完了・履歴・払った記録にしない)。
    (isStandard && (standard.restoredFromStorage || standard.restoredAttempt)) ||
    (useRelay && relay.restoredIntent != null) ||
    // 確定した Pimlico の支払いが、この画面から最後に送った支払いと別の intent (第 10 回レビュー A-1)。
    (!isStandard && !useRelay && gasless.settledOtherIntent);
  // 復元した支払いの確定がこの会計の支払いかを判定する、この会計の形 (第 10 回レビュー H-S・判定は下の foreignSettlement)。
  const settlementScreen = useMemo(() => checkoutSettlementScreen(params), [params]);

  // ウォレットでの取り消しは失敗として数えない (Sentry の *.failed 通知を鳴らさない)。
  useEffect(() => {
    if (gasless.error && !isUserRejection(gasless.error))
      logger.error('checkout.failed', { error: gasless.error });
  }, [gasless.error]);

  useEffect(() => {
    if (standard.error && !isUserRejection(standard.error))
      logger.error('checkout.standard.failed', { error: standard.error });
  }, [standard.error]);

  useEffect(() => {
    if (saError) logger.error('checkout.smart-account.init-failed', { error: saError });
  }, [saError]);

  useEffect(() => {
    if (activeQuote.error) logger.error('checkout.gas-quote.failed', { error: activeQuote.error });
  }, [activeQuote.error]);

  useEffect(() => {
    if (relayError) logger.error('checkout.relay.failed', { error: relayError });
  }, [relayError]);

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

  // 受注通知 (完了・前の会計・束縛した注文・通常決済の部分) の状態と effect は hooks/useCheckoutOrderNotify.ts にある。
  // effect は hook を呼んだ位置に並ぶので、移す前に 4 つの effect があったこの位置 (completion の直後) で呼ぶ。
  // 引数は同じ名前の shorthand だけで渡す (似た型の別の値と取り違えない)。
  const {
    statusToken,
    orderNotifyFailed,
    directNotifyRetryable,
    retryDirectNotify,
    boundNotifyRetryable,
    boundNotifyAcknowledged,
    previousOrderNotice,
    setBoundNotifyAcknowledged,
    setBoundNotifyRetry,
  } = useCheckoutOrderNotify({
    params,
    completion,
    relay,
    standard,
    address,
    chainSlug,
    deployment,
    isStandard,
    useRelay,
    matchingDelivery,
    restoredCheckoutCompletion,
    restoredStandardOrderAttempt,
    submitSnapshotRef,
    boundOrderRef,
    setRedirectIn,
    setBindingStorageError,
  });

  // 支払いを送ったウォレット (第 9 回レビュー A-4)。履歴と控えの支払者・注文の確認の署名をするウォレット (notifyPayer)
  // の両方に使う。確定を待つ間に拡張機能で別のウォレットへ切り替えても、切り替えた先にしない (控えは pending →
  // confirmed の昇格しか受けないので、後から直らない)。通常決済は hook が記録した送り主、relay は hook が署名に使った
  // from (admission・注文の束縛の読み込みの await の間に切り替えると、クリックしたときの接続先と実際の送金元がずれる
  // ため、実際の送金元を優先する)、それ以外は onSubmit で固定した submittedPayerRef。
  const paidFrom =
    (isStandard ? standard.lastSubmittedFrom : useRelay ? relay.lastSignedFrom : undefined) ??
    submittedPayerRef.current;
  // この画面でまだ送っていない間は、今の接続先のまま (従来どおり)。
  const historyCustomer = paidFrom ?? address;

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
      customer: historyCustomer,
      feeReceiver: env.feeReceiver,
      feeAmount: breakdown.feeAmount,
      saleAmount: totalWei,
      networkFeeEquivalent,
      // 店舗側履歴の storeName は従来どおり空 (会計 CSV の取引先 = 顧客のまま)。店名は控えにだけ出す。
      storeName: '',
      receiptMerchantName: params.storeName ?? null,
      note: params.description ?? params.orderId ?? '',
      productName: params.items.map((it) => it.name).join(', '),
      memo: params.description ?? null,
      taxRate: params.taxRate ?? null,
      taxCategory: params.taxCategory ?? null,
      receiptNo: params.receiptNo ?? null,
      invoiceNo: params.invoiceNo ?? null,
      ...(params.orderId ? { orderId: params.orderId } : {}),
      // 売上明細 (値引きは税率ごと → 明細の順に按分して行に固定・税額は値引き後の行額から)。
      lineItems: buildCheckoutLineItems({
        items: params.items,
        discount: params.discount,
        token: params.token,
        decimals: deployment.decimals,
        taxRate: params.taxRate,
        taxCategory: params.taxCategory,
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
      params.discount,
      params.taxRate,
      params.taxCategory,
      params.receiptNo,
      params.storeName,
      params.invoiceNo,
      isStandard,
      breakdown.merchantReceives,
      breakdown.feeAmount,
      totalWei,
      networkFeeEquivalent,
      historyCustomer,
      locale,
    ],
  );
  // 永続 metadata に items/order/callback を追加せず、reload 復元の結果は既存 pending 記録の
  // status 昇格だけに限定する。現在 URL の会計 context から新しい履歴・控えを作る波及を断つ。
  const gaslessForHistory =
    restoredCheckoutCompletion && useRelay
      ? { error: null }
      : useRelay
        ? relayHistoryGasless
        : gasless;
  const standardForHistory =
    restoredCheckoutCompletion && isStandard
      ? { phase: 'idle', error: null }
      : standard;
  usePaymentHistory(
    historyCtx,
    gaslessForHistory,
    standardForHistory,
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
    if (!params.successUrl || !completion || restoredCheckoutCompletion || orderNotifyFailed ||
      (boundOrderRef.current && !boundNotifyAcknowledged)) return;
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

  async function onSubmit() {
    if (!canSubmit || paidInThisTab) return;
    if (params.storeHandle && orderAdmissionMode) {
      // 同一 gesture の二重 click が React の再描画前に抜け、admission 後に二重署名へ
      // 波及するのを ref で同期的に遮断する。
      if (orderAdmissionInFlightRef.current) return;
      orderAdmissionInFlightRef.current = true;
      setOrderAdmissionPending(true);
      setOrderAdmissionRejected(false);
      // admission の await 後では iOS の user gesture が失われるため、音声だけ先に解錠する。
      primeChimeAudio();
      let admitted = false;
      try {
        const response = await fetch('/api/order/admission', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            handle: params.storeHandle,
            merchant: params.to,
            mode: orderAdmissionMode,
            ...(params.pickupAt === undefined
              ? {}
              : { pickupAt: params.pickupAt }),
            // URL 発行時点の手数料負担者。server が最新 storefront と突合し、店舗が
            // feePayer を切り替えていれば署名前に 409 で止める (notify の
            // 「手数料未収」誤検出 → 二重徴収を防ぐ)。URL に無ければ送らない (従来動作)。
            ...(params.feePayer === undefined
              ? {}
              : { feePayer: params.feePayer }),
            // 明細と URL の値引き。server が明細の小計に店舗の値引き (公開設定) を当てた額と突合し、
            // 値引きが変わっていれば署名前に 409 で止める (plans/discount-common.md)。
            items: params.items.map(({ name, qty, price }) => ({ name, qty, price })),
            ...(params.discount ? { discount: params.discount } : {}),
          }),
        });
        const body = (await response.json().catch(() => null)) as {
          ok?: unknown;
        } | null;
        admitted = response.ok && body?.ok === true;
      } catch {
        admitted = false;
      } finally {
        orderAdmissionInFlightRef.current = false;
        setOrderAdmissionPending(false);
      }
      if (!admitted) {
        // 最新 storefront を確認できない状態から不可逆な wallet 署名へ進む波及を断つ。
        setOrderAdmissionRejected(true);
        return;
      }
      // admission 待機中に接続・chain・残高等が変わっていれば、stale な submit を止める。
      if (!paymentReadyRef.current) return;
    }
    let order: CanonicalOrder | undefined;
    boundOrderRef.current = null;
    setBindingInputError(false);
    setBindingStorageError(false);
    setBoundNotifyAcknowledged(false);
    if (useRelay && params.webhook) {
      // The lazy binding chunk introduces an await before mutate; block repeated clicks during
      // that gap so a slow chunk cannot produce multiple authorizations for one submit gesture.
      if (boundOrderPreparingRef.current) return;
      boundOrderPreparingRef.current = true;
      try {
        // 自社の notify の URL なら `h` がちょうど 1 つを求めて注文を束ねる。自社でない URL は束ねずに払う。
        // ほかの所との方針の差は lib/order/ownNotifyUrl.ts の冒頭の表。
        const webhook = parseOwnOrderNotifyUrl(params.webhook, window.location.origin);
        if (webhook.kind === 'unreadable') {
          // 読めない URL は、束ねずに払うのではなく止める (移す前は new URL の例外が下の catch の else に落ちていた)。
          setBindingStorageError(true);
          return;
        }
        if (webhook.kind === 'own') {
          if (webhook.handles.length !== 1) throw new Error('invalid_handle');
          const orderId = params.orderId || generateStatusToken().slice(0, 16);
          // Unlike advisory standard metadata, a bound memo must be read before signing or stop.
          const customerMemo = window.sessionStorage.getItem(`${ORDER_MEMO_STORAGE_PREFIX}${orderId}`) ?? '';
          const { canonicalOrder } = await import('@/lib/orderBind');
          // A slow chunk must not carry a disconnected/switched wallet into signing.
          if (!paymentReadyRef.current) return;
          order = canonicalOrder({ chainId: deployment.chainId, tokenAddress: deployment.address,
            merchant: params.to, handle: webhook.handles[0], orderId, items: params.items,
            description: params.description, pickupAt: params.pickupAt, customerMemo,
            statusToken: env.enableOrderPickup ? generateStatusToken() : '' });
          boundOrderRef.current = order;
        }
      } catch (error) {
        // Storage/invalid own-origin context must not broadcast an order with a missing opening.
        if (error instanceof Error && (error.message === 'invalid_handle' || error.message === 'order_binding_mismatch')) {
          setBindingInputError(true);
        } else setBindingStorageError(true);
        return;
      } finally {
        boundOrderPreparingRef.current = false;
      }
    }
    setBindingStorageError(false);
    attemptRouteRef.current = route;
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
    // 遠隔の注文の確認の署名は、この支払いを送ったウォレットでしてもらう (完了までに切り替えても変わらない)。
    submittedPayerRef.current = address;
    // 完了画面のチャイムを iOS でも鳴らせるよう、この gesture 内で AudioContext を解錠。
    if (!orderAdmissionMode) primeChimeAudio();
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
        contextKey: checkoutContextKey,
        // 注文リンクの支払いの指紋を保存する intent にだけ残す (読み直した後の完了を同じ注文リンクに結び付ける・
        // 第 9 回レビュー G-1)。送金の中身には関わらない。
        ...(orderLinkKey ? { orderLinkKey } : {}),
      });
    } else if (useRelay) {
      // JPYC EIP-3009 relay: 顧客が transferWithAuthorization に署名 → 自前 relayer が gas 負担で
      // submit。fee=0・gas は OpenPay 肩代わり (free) or JPYC 回収 (recover・hook 内で分割)。
      // 全額 (totalWei) をそのまま relay に渡す (recover の控除は hook 側)。
      relay.mutate({
        merchant: params.to,
        value: totalWei,
        ...(order ? { order } : {}),
        gasMode: effectiveGas,
        // モバイル注文 (storefront/preorder) のときだけ feeKind を載せる (server が定数表から % を
        // 再計算・on-chain 強制)。
        ...(mobileFeeKind ? { feeKind: mobileFeeKind } : {}),
        // 注文リンクの支払いの指紋を復旧 intent にだけ残す (読み直した後の完了を同じ注文リンクに結び付ける・第 9 回
        // レビュー G-1)。束縛した注文 (order) は自分の slot で復旧するので付けない。relay POST には載らない。
        ...(orderLinkKey && !order ? { orderLinkKey } : {}),
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

  function switchToStandard() {
    // fallback-safe な pre-broadcast error 以外では attempt 固定を解かない。特に POST 中と
    // ambiguity latch 中は standard への切替が二重払いへ波及するため、handler 側でも拒否する。
    if (
      relay.isPending ||
      relayAmbiguous ||
      (attemptRouteRef.current?.kind === 'relay' &&
        !isFallbackSafeRelayError(relay.error))
    ) {
      return;
    }
    attemptRouteRef.current = null;
    setModeOverride('standard');
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
  // 遠隔の注文 (注文リンクや外部の /checkout リンク) なら、払ったことをお客様自身の LINE やメールでお店に知らせるボタンを出す。
  const notifyShop = isRemoteOrderCheckout(params);
  // 受け付けるチェーンが複数のリンク: 支払いを始めるまでは「別のチェーンで払う」でチェーンを選ぶ画面に戻れる。
  // 始めたら (送信中・完了・結果不明・前の支払いの記録あり・ウォレットのチェーンの切り替え中) 戻さない
  // (同じ注文を別のチェーンで二重に払わせない・plans/order-link-multichain.md)。
  const chainSwitchLocked =
    completed ||
    flowPending ||
    settledNoRetry ||
    restoredCheckoutCompletion ||
    standard.phase !== 'idle' ||
    isSwitching ||
    paidInThisTab;
  const canPayOnOtherChain = Boolean(params.chains && params.chains.length >= 2) && !chainSwitchLocked;
  const payOnOtherChain = () => {
    const search = new URLSearchParams(window.location.search);
    search.delete('chain');
    router.replace(`?${search.toString()}`, { scroll: false });
  };
  const successOverlayPayload: PaymentSuccessOverlayPayload | null =
    restoredCheckoutCompletion
      ? null
      : !isStandard && !useRelay && gasless.data && gasless.data.success
      ? {
          amountDisplay: fmt(totalCustomerOutflow),
          txHash: gasless.data.txHash,
          userOpHash: gasless.data.userOpHash,
          blockNumber: gasless.data.blockNumber,
          explorerBase,
          merchantAddress: params.to,
          orderNo: params.orderId, // 受付番号 (受け渡し照合用・order_id があるときのみ表示)
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
  // 注文を送る / お店に知らせる の中身。払ったウォレットは支払いを送った時点の接続先 (通常決済は hook が記録した
  // 送り主・relay は hook が署名に使った from) で、完了を見た時点の接続先ではない (途中で切り替えたウォレットに署名させない)。
  // 履歴と控えの支払者と同じ値 (上の paidFrom・第 9 回レビュー A-4)。
  const notifyPayer = paidFrom;
  // 中身はチェーンを選ぶ画面と同じ関数で作る (第 9 回レビュー D-9)。金額はお客様が払う額 (breakdown.customerPays)。
  const notifyFor = (txHash: string, payer: Address | undefined, chain: ChainSlug = chainSlug): NotifyShopData =>
    notifyShopData({ params, customerPays: totalCustomerOutflow, deployment, txHash, payer, chain });
  const notifyData: NotifyShopData | undefined =
    notifyShop && successOverlayPayload ? notifyFor(successOverlayPayload.txHash, notifyPayer) : undefined;
  // 読み直した画面で復元した支払いが完了した (receipt / relay の結果が届いた): 大きな完了画面と受注通知は出さないまま
  // (上の successOverlayPayload)、この注文リンクの支払いと確かめられたときだけ「注文を送る」を出し、払った記録を残す
  // (第 9 回レビュー G-1: 記録が無いと、もう一度読み直したときに同じ注文をまた払えてしまう)。別の会計の復元は出さない・
  // 残さない。払ったウォレットは復元した支払いの送り主 (通常決済は hook が記録した送り主・relay は署名した人)。
  // relay は今の経路 (useRelay) を見ない: 経路は接続中のチェーンで決まり、別のチェーンのまま読み直しても hook は保存した
  // intent を復旧して成功で保存を消すため、ここで経路を要求すると記録が残らない。このマウントの完了 (notifyData) が
  // あるときは出さない。
  const restoredCompletionNotify: NotifyShopData | undefined =
    !notifyShop || notifyData
      ? undefined
      : isStandard && standard.data && restoredStandardOrderLinkAttempt
        ? notifyFor(standard.data.merchantTxHash, restoredStandardOrderLinkAttempt.from)
        : relay.data?.success && relay.data.txHash && restoredRelayOrderIntent
          ? notifyFor(relay.data.txHash, restoredRelayOrderIntent.from)
          : undefined;
  // 復元した支払いの確定が、この会計の支払いでないと証明できたか (第 10 回レビュー H-S)。完了の欄の題と本文だけを
  // 差し替える (お礼を出さず「この画面の支払いではありません」と「読み込み直す」を出す)。completed・再送の止め・受注通知・
  // 大きな完了画面・success_url・払った記録・履歴の条件は restoredCheckoutCompletion のままで、ここでは変えない。
  // この mount で送った支払いは判定しない。比べられない欄は一致 (lib/paymentFlowGuards/restoredSettlement)。
  const foreignSettlement =
    restoredCheckoutCompletion &&
    // G-1 の欄を出す確定 (restoredCompletionNotify = 成功した確定が、この注文リンクの会計の鍵・chain・お店・額と一致) は、
    // 判定を呼ばずに一致とする。G-1 の欄と同じ値を見るので、欄を出さない確定 (一致した記録の結果がまだ無い・別の経路の
    // 記録) はこの守りに入らない。何の波及を断つか: 判定の入力 (token の表など) が env でずれても、この会計と一致した確定に
    // 「この画面の支払いではありません」を出すこと。
    // 守るのは restoredCompletionNotify から出る欄だけ。下の restoredNotifyData は、このタブで払った記録 (rememberedPayment)
    // からも「注文を送る」を出すので、「前に払ったこの会計 B の『注文を送る』」と「いま確定した別の支払い A の W1」は並んで
    // 出うる (A と B は別の支払いで、どちらの表示も事実)。
    restoredCompletionNotify === undefined &&
    isForeignSettlement(
      settlementScreen,
      isStandard
        ? { kind: 'standard', record: standard.lastSubmittedParams }
        : useRelay
          // 注文に束縛した記録 (matchingDelivery) は、hook が今の会計と照らして復元したもの = 常に一致。
          ? { kind: 'relay', bound: matchingDelivery !== null, record: relay.restoredIntent }
          : { kind: 'gasless', record: gasless.variables },
    );
  // 読み直した画面: この会計 (同じ URL の中身) をこのタブで払った記録があれば、「注文を送る」を出す
  // (lib/orderConfirmation.ts の rememberOrderPayment)。完了画面を見ている間は出さない。
  const restoredNotifyData: NotifyShopData | undefined =
    restoredCompletionNotify ??
    (notifyShop && !notifyData && rememberedPayment
      ? notifyFor(rememberedPayment.payment.txHash, rememberedPayment.payment.payer, rememberedPayment.chain)
      : undefined);
  // 何度でも使えるリンク (番号なし・ship=ask) は、同じ商品をもう一度注文できる。
  const canPayAgainAsNewOrder = params.ship === 'ask' && !params.orderId;
  const liveNotifyTx = notifyData?.txHash;
  const liveNotifyPayer = notifyData?.payer;
  useEffect(() => {
    if (!liveNotifyTx) return;
    rememberOrderPayment(checkoutContextKey, {
      txHash: liveNotifyTx.toLowerCase(),
      ...(liveNotifyPayer ? { payer: liveNotifyPayer } : {}),
      paidAt: Date.now(),
    });
  }, [checkoutContextKey, liveNotifyTx, liveNotifyPayer]);
  // 復元した支払いの完了も同じ記録に残す (次に読み直したときに払うボタンを止め、「注文を送る」を出すため)。
  const restoredCompletionTx = restoredCompletionNotify?.txHash;
  const restoredCompletionPayer = restoredCompletionNotify?.payer;
  useEffect(() => {
    if (!restoredCompletionTx) return;
    rememberOrderPayment(checkoutContextKey, {
      txHash: restoredCompletionTx.toLowerCase(),
      ...(restoredCompletionPayer ? { payer: restoredCompletionPayer } : {}),
      paidAt: Date.now(),
    });
  }, [checkoutContextKey, restoredCompletionTx, restoredCompletionPayer]);

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
          ...(mobileFeeKind ? { feeKind: mobileFeeKind } : {}),
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
      {/* 会計の頭の部分 (見出し・店名と注記・受付番号・説明・ship=ask の案内・支払先の行・「別のチェーンで払う」)。表示だけの
          部品で、アドレスの短縮表示・チェーン名・通貨・どの文言を出すかの判定と、「別のチェーンで払う」を出すか・押したときの処理は
          ここで決めて渡す (第 9 回レビュー F-04)。条件と分岐は切り出し前の JSX から 1 つも変えずに写した (ship=ask の案内の
          `a && (…)` は `a ? … : null` に)。 */}
      <CheckoutHeader
        storeName={params.storeName}
        title={params.orderId ? t('orderHeading', { id: params.orderId }) : t('checkoutTitle')}
        description={params.description}
        // 何度でも使える注文リンク (ship=ask) の、払う前の案内。遠隔の注文 (notifyShop) のときだけ出し、送り先があれば
        // 送り先を入れる。
        shipAskNote={
          notifyShop && params.ship === 'ask'
            ? (params.contact
              ? t('shipAskNoteWithContact', { dest: shopContactLabel(params.contact) })
              : t('shipAskNote'))
            : null
        }
        payToAddress={shortAddress(params.to)}
        chainName={requiredChain.name}
        tokenSymbol={deployment.displaySymbol}
        modeBadge={isStandard ? t('modeBadgeStandard') : t('modeBadgeGasless')}
        canPayOnOtherChain={canPayOnOtherChain}
        onPayOnOtherChain={payOnOtherChain}
      />

      {/* 読み直した画面: このタブで払った会計なら、注文を送る / お店に知らせる をここに出す (同じ注文をもう一度払わせない)。 */}
      {restoredNotifyData && (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
          <p className="text-sm font-semibold">{t('notifyRestoredTitle')}</p>
          <p className="mt-1 break-all text-xs">{t('notifyRestoredBody', { tx: shortAddress(restoredNotifyData.txHash) })}</p>
          <div className="mt-3">
            <NotifyShopButton {...restoredNotifyData} tone="panel" />
          </div>
          {paidInThisTab && canPayAgainAsNewOrder && (
            <button
              type="button"
              onClick={() => setNewPurchase(true)}
              className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-emerald-800 underline underline-offset-4"
            >
              {t('payAgainAsNewOrder')}
            </button>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
        {/* 商品の明細 (見出しと品目の行)。表示だけの部品で、行の額 (品目ごとの小計) の計算と表記はここで決めて渡す
            (第 9 回レビュー F-04)。 */}
        <CheckoutItemList
          lines={params.items.map((it) => {
            const lineTotalWei = calcCheckoutTotal([it], deployment.decimals);
            return { name: it.name, qty: it.qty, amountText: fmt(lineTotalWei) };
          })}
        />
        {/* 合計の内訳 (小計・値引き・手数料・ネットワーク手数料・お支払い額の表と、その下の説明・承認の確認のリンク)。
            表示だけの部品で、額の計算と表記・どの行と文言を出すかの経路の判定はここで決めて、行のモデルと説明の文字列で渡す
            (第 9 回レビュー F-04)。条件と分岐は切り出し前の JSX から 1 つも変えずに写した (breakdownRow(…) の中身を行のモデルに・
            `a && breakdownRow(…)` は `a ? … : null` に)。 */}
        <CheckoutAmountBreakdown
          // レジの値引き: 小計 (値引き前) → 値引き の 2 行。以降の手数料・お支払い額は値引き後の額。
          subtotal={
            params.discount
              ? (() => {
                const subtotalWei = calcCheckoutTotal(params.items, deployment.decimals);
                return {
                  row: { label: t('subtotalRow'), value: fmt(subtotalWei) },
                  discountRow: { label: t('discountRow'), value: `−${fmt(subtotalWei - totalWei)}` },
                };
              })()
              : { row: { label: t('subtotalRow'), value: fmt(totalWei) }, discountRow: null }
          }
          // fee=0 のとき手数料行は非表示 (Phase 1 alpha)。負担者でラベルを出し分ける:
          // 店舗が受取から吸収した (merchantReceives < 請求額) なら「(店舗負担)」を補足、
          // 顧客上乗せ (事前モバイルオーダーの顧客負担) なら補足なし。
          feeRow={
            breakdown.feeAmount > 0n
              ? {
                label:
                  breakdown.merchantReceives < totalWei
                    ? t('feeRowMerchant')
                    : t('feeRow'),
                value: fmt(breakdown.feeAmount),
              }
              : null
          }
          gasRow={
            isStandard
              ? { label: t('gasRowStandard'), value: t('gasRowStandardValue') }
              : isMobileFee
                /* モバイル注文 (gasless): ネットワーク手数料は利用料 (feeRow) に含むため別行を出さない
                   (relayGasEquiv=0 で「0 JPYC」表示になり紛らわしい)。standard 経路は上の分岐で
                   顧客がウォレットで gas を払うので従来どおり gas 行を表示する (ここには来ない)。 */
                ? null
                : (
                  useRecover
                    ? {
                      label: isMerchantGas ? t('gasRowMerchant') : t('gasRow'),
                      tooltip: t('gasInfoJpycRecover'),
                      value: fmt(relayGasEquiv),
                    }
                    : useRelay || isJpyc
                      // JPYC ガスレス (relay free / 非 relay sponsorship free) は無徴収。中立ラベル。
                      ? {
                        label: t('gasRowFree'),
                        tooltip: t('gasInfoJpycRelay'),
                        value: t('gasRowRelayFree'),
                      }
                      : {
                        label: isMerchantGas ? t('gasRowMerchant') : t('gasRow'),
                        tooltip: isCircle
                          ? t('gasInfoUsdcCircle', { nativeToken })
                          : isErc20Paymaster
                            ? t('gasInfoUsdc', { nativeToken })
                            : t('gasInfoJpyc', { nativeToken }),
                        value:
                          gasAmount !== undefined
                            ? t('gasRowValue', { amount: fmt(gasAmount) })
                            : t('gasRowPending'),
                      }
                )
          }
          totalRow={{
            label: isStandard
              ? t('totalRowStandard', { nativeToken })
              : isMerchantGas
                ? t('totalRowMerchantGas')
                : t('totalRow'),
            value: fmt(totalCustomerOutflow),
            strong: true,
          }}
          hint={
            isStandard
              ? params.chain === 'arc'
                ? t('standardArcHint')
                : t('standardHint', { nativeToken })
              : isMobileFee
                ? t('gaslessHintMobile')
                : useRecover
                  ? t('gaslessHintJpycRecover')
                  : useRelay || isJpyc
                    ? t('gaslessHintJpycRelay')
                    : isErc20Paymaster
                      ? t('gaslessHintUsdc')
                      : t('gaslessHintJpyc')
          }
          approvalCheckUrl={approvalCheckUrl}
        />
      </section>

      {/* F7: off-origin コールバック開示 (支払い前・payer 向け)。success_url/cancel_url が
          第三者ホストを指すとき、決済後 (または中止時) に移る先を明示する (情報提供のみ・決済は妨げない)。 */}
      {!completed && offOriginHosts.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          <p>{t('offOriginCallbackNote', { host: offOriginHosts.join('、') })}</p>
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
          onSwitchToStandard={switchToStandard}
        />
      )}

      {!completed && (
        <section
          ref={walletSectionRef}
          className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('walletSection')}
          </p>
          <ConnectButton />

          {/* チェーンの切り替えのボタンと切り替え失敗の知らせ。表示だけの部品で、出す条件と切り替え先はここで決めて
              渡す (第 9 回レビュー F-04)。 */}
          {isConnected && wrongChain && (
            <WrongChainSwitch
              isSwitching={isSwitching}
              switchFailed={switchFailed}
              chainName={requiredChain.name}
              onSwitch={() => switchChain({ chainId: requiredChain.id })}
            />
          )}

          {/* 残高の行と残高不足の案内。表示だけの部品で、出す条件と額の表記はここで決めて渡す (null なら出さない・
              第 9 回レビュー F-04)。 */}
          <WalletBalance
            balanceText={isConnected && !wrongChain && balance !== undefined ? fmt(balance) : null}
            requiredAmountText={insufficientBalance ? fmt(totalCustomerOutflow) : null}
            token={params.token}
          />

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

      {/* このタブで払った会計: 払うボタンを止めた理由を出し、上の欄 (NotifyShopButton) を指す。ボタンの名前は書かない:
          名前は状態で変わる (署名の前は「注文を送る」/「お店に知らせる」・署名の後や JPYC 以外は「LINE で送る」「送る」
          「文をコピー」等) ので、名前を書くと見つからない場合がある (第 9 回レビュー D-2)。 */}
      {!completed && paidInThisTab && (
        <p className="text-center text-sm text-slate-700">{t('paidInThisTabNote')}</p>
      )}

      {!completed && (
        <button
          type="button"
          // 未接続時: ラベルは「ウォレットを接続」なのに disabled で押せない矛盾を解消 —
          // タップで上のウォレット選択セクションへスクロールする (送信は canSubmit ガードの
          // まま・onSubmit へは接続後しか到達しない = 決済フロー不変)。
          onClick={
            !isConnected
              ? () =>
                  walletSectionRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                  })
              : onSubmit
          }
          disabled={isConnected && (!canSubmit || paidInThisTab)}
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

      {/* standard receipt RPC が読めない間は broadcast 済み tx の成否が不明。
          main Pay / fee retry は出さず、同じ hash の receipt 再照会のみ許可する。 */}
      {!completed && isStandard && standard.isUnknown && (
        <PaymentStatusPanel
          title={t('standardUnknownTitle')}
          body={t('standardUnknownBody')}
          titleWithIcon
          showSpinner
          identifier={standardUnknownTxHash}
          explorerHref={
            standardUnknownTxHash && explorerBase
              ? `${explorerBase}/tx/${standardUnknownTxHash}`
              : undefined
          }
          explorerLabel={t('pendingExplorerLink')}
          actionLabel={t('standardReceiptRetryButton')}
          onAction={() => standard.retryReceipt()}
        />
      )}

      {/* Pimlico receipt RPC が不確定な間は新しい UserOperation を作らず、保持した
          userOpHash の receipt 再照会だけを許可する。文言は relay unknown と共通。 */}
      {!completed && gaslessAmbiguous && (
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

      {/* 支払い記録を保存できない端末では gasless だけを止める (通常送信は使える)。
          「支払い確認中」とは別文言 — 送信済みかもしれない状態ではないため。
          確認中の支払いを送り直す前に保存できないとき (gaslessResendBlocked) は上の「確認中」の欄と並んで出る。
          確認中は通常送信も閉じているので、本文だけを「ブラウザの設定か別のブラウザ」の案内から「送り直せません」に替える。 */}
      {!completed && gaslessStoreUnavailable && (
        <PaymentStatusPanel
          title={t('pendingStoreUnavailableTitle')}
          body={t(gaslessResendBlocked ? 'pendingStoreUnavailableResendBody' : 'pendingStoreUnavailableBody')}
          titleWithIcon
        />
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
            onSwitchToStandard={switchToStandard}
          />
        ) : (
          error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              <p className="font-semibold">{t('errorTitle')}</p>
              <p className="mt-1 break-words">{error}</p>
            </div>
          )
        ))}

      {/* relay の状態の案内 (B1 Layer B の先回り・送信結果の確認中・IP の混雑)。表示だけの部品で、出す条件と
          ボタンで呼ぶ処理はここで決めて渡す (第 9 回レビュー F-04)。完了後は出さない。 */}
      {!completed && (
        <RelayStatusBanners
          relayPreflightActive={relayPreflightActive}
          nativeToken={nativeToken}
          onSwitchToStandard={switchToStandard}
          relayAmbiguous={relayAmbiguous}
          relayIpRateLimited={relayIpRateLimited}
          relay={relay}
        />
      )}

      {relay.previousPaymentPending && (
        <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {t(relay.previousPaymentSameMerchant
            ? relay.orderPaymentHold ? 'previousPaymentConfirming' : 'previousPaymentUnconfirmed'
            : 'previousPaymentConfirmingOther')}
        </p>
      )}
      {previousOrderNotice && !(previousOrderNotice === 'pending' && relay.previousPaymentSameMerchant) && (
        <p role="status" className="rounded-lg bg-slate-50 p-3 text-xs text-slate-800">
          {t(previousOrderNotice === 'staff' ? 'previousOrderNotifyStaff' : 'previousOrderNotifyPending')}
        </p>
      )}
      {(bindingStorageError || relay.error?.message === 'order_binding_storage_unavailable') && !relay.data?.success && (
        <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {t('orderBindingStorageUnavailable')}
        </p>
      )}
      {bindingInputError && (
        <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {t('urlInvalidTitle')}
        </p>
      )}
      {relay.orderDeliveryLoadError && useRelay && params.webhook && origin && isOwnOrderNotifyUrl(params.webhook, origin) && (
        <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {t('orderBindingRestoreUnavailable')}
        </p>
      )}
      {/* 「注文登録を再試行」は 1 つだけ描く。束縛した注文 (経路 C) と完了の通知 (経路 A・束縛した注文では走らない) は
          状態も押したときの処理も別で、両方が立ったら経路 C を先にする。 */}
      {(boundNotifyRetryable || directNotifyRetryable) && (
        <button
          type="button"
          className="rounded-xl border border-amber-400 p-3 text-sm font-semibold"
          onClick={boundNotifyRetryable ? () => setBoundNotifyRetry((v) => v + 1) : retryDirectNotify}
        >
          {t('retryOrderNotify')}
        </button>
      )}
      {orderNotifyFailed && (
        <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {t('orderNotifyTooOld')}
        </p>
      )}

      {/* 支払い完了の枠 (見出し・結果の行・受付番号・お店に知らせる・注文状況を見る・電子レシート・success_url への移動の
          案内・ホームへ戻る)。表示だけの部品で、経路ごとにどの行を出すか・受付番号の出どころ・リンクと移動の案内を出すかと
          文言・ホームへ戻るを出すかと、押したときの処理はここで決めて、出すなら値・出さないなら null で渡す (第 9 回レビュー
          F-04)。条件と分岐は切り出し前の JSX から 1 つも変えずに写した (`a && (…)` は `a ? 値 : null` に)。値は枠を出すときだけ
          (このガードの内側で) 作る。 */}
      {completed && (gasless.data || standard.data || relay.data) && (
        <CheckoutCompletion
          foreign={foreignSettlement}
          gasless={
            !isStandard && !useRelay && gasless.data
              ? {
                userOpHash: gasless.data.userOpHash,
                txHash: gasless.data.txHash,
                blockNumber: gasless.data.blockNumber.toString(),
              }
              : null
          }
          // relay は userOp/block を持たないため Tx Hash のみ表示 (Explorer は overlay 側)。
          relayTxHash={useRelay && relay.data?.success && relay.data.txHash ? relay.data.txHash : null}
          standard={
            isStandard && standard.data
              ? {
                merchantTxHash: standard.data.merchantTxHash,
                feeTxHash: standard.data.feeTxHash ? standard.data.feeTxHash : null,
                blockNumber: standard.data.blockNumber.toString(),
              }
              : null
          }
          orderId={
            (boundOrderRef.current ?? matchingDelivery?.order)?.orderId || (!restoredCheckoutCompletion && params.orderId)
              ? (boundOrderRef.current ?? matchingDelivery?.order)?.orderId ?? params.orderId!
              : null
          }
          notifyData={notifyData}
          // お渡し準備完了通知 (flag ENABLE_ORDER_PICKUP): 顧客が注文状況を追えるリンク。flag OFF / 非 mobile-order
          // (webhook 無) では statusToken が null ゆえ非表示。click は user gesture ＝ ここで AudioContext を解錠
          // (iOS 自動再生対策)。
          orderStatusHref={
            env.enableOrderPickup && statusToken && !orderNotifyFailed
              ? `/${locale}/order/status?t=${statusToken}`
              : null
          }
          onOrderStatusClick={() => primeChimeAudio()}
          receiptCandidateIds={[
            standard.data?.merchantTxHash,
            gasless.data?.txHash,
            gasless.data?.userOpHash,
            relay.data?.txHash ?? undefined,
          ]}
          redirectNotice={
            !restoredCheckoutCompletion && params.successUrl && !orderNotifyFailed &&
              (!boundOrderRef.current || boundNotifyAcknowledged)
              ? (redirectIn !== null && redirectIn > 0
                ? t('redirectingIn', { sec: redirectIn })
                : t('redirectingNow'))
              : null
          }
          onRedirectNow={doRedirect}
          showReturnHome={restoredCheckoutCompletion || !params.successUrl}
          onReturnHome={() => router.push('/')}
        />
      )}

      {/* relay pending: broadcast 済だが未確定。standard へ fallback させず「確認待ち」を表示
          (再送信は canSubmit の settledNoRetry で禁止)。txHash があれば Explorer で追跡。 */}
      {useRelay && !relayAmbiguous && relay.data?.pending && (
        <PaymentStatusPanel
          title={t('pendingTitle')}
          body={t('pendingBody')}
          identifier={relay.data.txHash ?? undefined}
          explorerHref={
            relay.data.txHash && explorerBase
              ? `${explorerBase}/tx/${relay.data.txHash}`
              : undefined
          }
          explorerLabel={t('pendingExplorerLink')}
        />
      )}

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

      {/* PayPay 風 大型成功 overlay。dismiss 後は inline panel + redirect countdown を表示。
          success_url 指定時は overlay 表示中も 3 秒 countdown が並走する仕様。gasless / relay /
          standard の 3 連は共通 PaymentSuccessOverlay へ集約 (payload で mode 差を吸収・挙動不変)。 */}
      <PaymentSuccessOverlay
        dismissed={overlayDismissed || orderNotifyFailed}
        payload={successOverlayPayload}
        notify={notifyData}
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
