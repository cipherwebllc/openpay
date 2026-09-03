'use client';

// セキュリティ: webhook payload と success_url の query は顧客側で改ざん可能
// (Stripe の whsec_ 署名相当の保証はない)。マーチャントは tx_hash を必ず
// on-chain で再検証してから注文を確定する責務を負う。

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
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
import type { SignReassuranceProps } from './SignReassurance';
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
  type PaymentRoute,
} from '@/lib/paymentRoute';
import { recoverFeeValue, recoverPercentValue } from '@/lib/relay/recoverFee';
import {
  feeSplit,
  mobileOrderBreakdown,
  mobileOrderGasMode,
  type MobileOrderFeeKind,
} from '@/lib/mobileOrderFee';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
import {
  isFallbackSafeRelayError,
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import { generateStatusToken } from '@/lib/orderStatusToken';
import { isOrderTokenLike } from '@/lib/orderToken';
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
import { redactUrlForTelemetry } from '@/lib/telemetryRedaction';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { useRelayGaslessSnapshot } from '@/hooks/useRelayGaslessSnapshot';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import {
  calcCheckoutTotal,
  offOriginCallbackHosts,
  type CheckoutParams,
} from '@/lib/url';
import { useOrigin } from '@/hooks/useOrigin';
import { taxAmountDecimal, taxDisplayDecimals } from '@/lib/tax';
import { formatTokenAmount, shortAddress } from '@/lib/format';
import {
  buildJpycRelaySignPreview,
  buildJpycRecoverSignPreview,
} from '@/lib/signPreview';
import { checkoutIntentContextFingerprint } from '@/lib/checkoutIntentContext';
import { RecoverFeeNotice } from './RecoverFeeNotice';

// 送信後の pending / unknown と同一 payload の復旧時だけ必要な UI を First Load JS
// から外す。状態判定・再送封鎖・retry handler の選択は親に残す。
const PaymentStatusPanel = dynamic(
  () =>
    import('./PaymentStatusPanel').then((m) => m.PaymentStatusPanel),
  { ssr: false },
);
const SignReassurance = dynamic(
  () => import('./SignReassurance').then((m) => m.SignReassurance),
);

const SUCCESS_REDIRECT_DELAY_MS = 3000;
const ORDER_MEMO_STORAGE_PREFIX = 'openpay:order-memo:';
const ORDER_STATUS_TOKEN_STORAGE_PREFIX = 'openpay:order-status-token:';
const ORDER_NOTIFY_PROCESSING_RETRY_MS = [
  250, 1_000, 4_000, 15_000, 60_000, 60_000,
] as const;

function orderStatusTokenForMerchantTx(merchantTxHash: string): string {
  const key = `${ORDER_STATUS_TOKEN_STORAGE_PREFIX}${merchantTxHash.toLowerCase()}`;
  try {
    const stored = window.sessionStorage.getItem(key);
    if (isOrderTokenLike(stored)) return stored;
    const generated = generateStatusToken();
    window.sessionStorage.setItem(key, generated);
    return generated;
  } catch {
    // status token の sessionStorage 障害を受注通知へ波及させない。同一 mount は呼出側の ref で固定する。
    return generateStatusToken();
  }
}

async function postCheckoutWebhook(
  url: string,
  init: RequestInit,
  retryOrderProcessing: boolean,
): Promise<Response> {
  let response = await fetch(url, init);
  if (!retryOrderProcessing) return response;
  for (const delayMs of ORDER_NOTIFY_PROCESSING_RETRY_MS) {
    if (response.status !== 409) return response;
    // 直前 mount の order claim が処理中でも、fee 成功通知まで 409 で失われ受注/未収状態が
    // 固着する波及を断つ。既存 route の 409 契約は変えず、同じ byte の notify だけを再試行する。
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await fetch(url, init);
  }
  return response;
}

export function CheckoutForm({ params }: { params: CheckoutParams }) {
  const t = useTranslations('CheckoutForm');
  const locale = useLocale();
  // 顧客向け「注文状況」トークン (お渡し準備完了通知・flag ENABLE_ORDER_PICKUP)。決済成功時に
  // 1 度だけ生成し、webhook payload (notify がポインタ保存) と完了画面の「注文状況を見る」リンクで
  // 使う。flag OFF では生成せず null = payload 無変化・リンク非表示 (byte-identical)。
  const [statusToken, setStatusToken] = useState<string | null>(null);
  const statusTokenRef = useRef<string | null>(null);
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
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  // sessionStorage に broadcast 済み standard intent が残る場合、元 URL が gasless でも
  // standard の receipt 復元を本線に固定する。storage 読込中は下の readiness で全経路を止める。
  const standard = useStandardPayment();

  // F7: webhook / success_url / cancel_url のうち、現在の origin と host が異なる第三者ホスト。
  // これらは決済者データの POST 先 / 決済後の遷移先になり得るため、支払い前に payer へ明示開示する
  // (block はしない — 正当な off-origin マーチャント webhook / redirect が存在する)。origin 未確定
  // (SSR / hydrate 前) は空配列 = 開示なし (false-positive 防止)。
  const origin = useOrigin();
  const offOriginHosts = useMemo(
    () =>
      origin
        ? offOriginCallbackHosts(
            [params.webhook, params.successUrl, params.cancelUrl],
            new URL(origin).host,
          )
        : [],
    [origin, params.webhook, params.successUrl, params.cancelUrl],
  );

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
  const resolvedRoute = resolvePaymentRoute({
    isStandard:
      params.mode === 'standard' ||
      modeOverride === 'standard' ||
      standard.hasAttempt,
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
  // submit gesture で選ばれた経路を attempt 単位で固定し、relay POST 中に degraded banner の
  // standard 切替が競合しても進行中の money-path を差し替えない。
  const route = attemptRouteRef.current ?? resolvedRoute;
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

  // relay 送信中に preflight の切替操作と競合して route が standard へ変わっていても、
  // response-unknown / IP 制限の再送封鎖を外さないため current route とは独立に判定する。
  const relayResponseUnknown = isRelayResponseUnknownError(relay.error);
  const relayAmbiguous = relay.recoveryState != null || relayResponseUnknown;
  // Pimlico は broadcast 後の receipt 取得失敗を relay と同じ unknown として保持する。
  // current route が後から変わってもラッチを外さず、2 本目の UserOperation 送信を防ぐ。
  const gaslessAmbiguous = gasless.isUnknown;
  // pending record store (localStorage) が読めず未解決 UserOp の有無を判定できない状態。
  // broadcast 済みとは言い切れないので ambiguous とは別扱いにし、gasless 経路だけを塞ぐ
  // (standard は localStorage に依存しないため、この fail-closed を波及させない)。
  const gaslessStoreUnavailable =
    !isStandard && !useRelay && gasless.pendingStoreUnavailable;
  const relayIpRateLimited = isRelayIpRateLimitedError(relay.error)
    ? relay.error
    : null;
  const paymentFlowPending = standard.isRestoring || relay.isRestoring
    ? true
    : relayAmbiguous || gaslessAmbiguous
    ? true
    : isStandard
      ? standard.isPending
      : useRelay
        ? relay.isPending
        : gasless.isPending;
  const flowPending = orderAdmissionPending || paymentFlowPending;
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
    relayAmbiguous ||
    gaslessAmbiguous ||
    !!relayIpRateLimited ||
    (!isStandard && !useRelay && !!gasless.data?.success) ||
    (useRelay &&
      !!relay.data &&
      (relay.data.success || !!relay.data.pending)) ||
    relay.hasActiveIntent ||
    standard.hasActiveIntent ||
    (isStandard && (!!standard.data || standard.isFeeError || standard.isUnknown));
  const standardUnknownTxHash = standard.isFeeUnknown
    ? standard.feeTxHash
    : standard.merchantTxHash;

  // 未接続時に最下部 CTA からウォレット選択セクションへ誘導するためのアンカー。
  const walletSectionRef = useRef<HTMLElement | null>(null);

  const paymentReady =
    isConnected &&
    !wrongChain &&
    (isStandard || useRelay || !!saData) &&
    // PaymentForm と揃える明示ガード。現状は totalWei>0 (有効 items) 不変で merchantUnderflow
    // が拾うが、空 batch (merchant 受取 0) 送信を構造的にも塞ぐ defense-in-depth。
    breakdown.merchantReceives > 0n &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !paymentFlowPending &&
    gasQuoteReady &&
    !merchantUnderflow &&
    !settledNoRetry &&
    // gasless 経路のみ封鎖 (standard へ切り替えれば支払える)。
    !gaslessStoreUnavailable;
  const canSubmit = paymentReady && !orderAdmissionPending;
  const paymentReadyRef = useRef(paymentReady);
  paymentReadyRef.current = paymentReady;

  const flowError = relayAmbiguous || gaslessAmbiguous
    ? null
    : isStandard
    ? standard.isUnknown
      ? null
      : standard.error
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
    ? isFallbackSafeRelayError(flowError)
      ? t(relayErrorKey(flowError))
      : undefined
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
        (revertedNoFeedback ? t('errorReverted') : null));

  // B1 graceful degradation: relay が API レベルで失敗 (rate_limited 等の error code) したとき、
  // ガス代自己負担の「通常決済」へ 1 タップで切り替える導線を出す。on-chain revert
  // (relay.data.success===false) は別経路 (revertedNoFeedback)、response-unknown は再送封鎖で
  // 扱うため、ここでは fallback-safe error のみを条件にする。banner の中で friendly 文言を
  // 1 度だけ出し、下の汎用 error ブロックでは重複表示しない。
  const relayFallbackActive =
    useRelay &&
    !relay.isPending &&
    !relayAmbiguous &&
    isFallbackSafeRelayError(relay.error);
  // B1 Layer B (preflight): relay 経路で relayer が degraded、かつ顧客がまだ submit していない
  // (relay.error なし・relay.data なし) ときに、署名 *前* に同じ banner で「通常決済へ切替」を促す。
  // 優先順位: relay.error → Layer A (per-error 文言) / それ以外で preflight-degraded → Layer B
  // (固定の preflight 文言)。両方は出さない (relay.error が優先)。
  const relayPreflightActive =
    useRelay &&
    relayHealth.degraded &&
    !relay.isPending &&
    !relayAmbiguous &&
    !relay.error &&
    !relay.data;
  // Layer A は汎用 error box を「置換」する (relay error の二重表示防止)、Layer B は「additive」
  // に出す (汎用 error box を抑止しない)。両者は !relay.error で排他。
  const relayFallbackMessage = isFallbackSafeRelayError(relay.error)
    ? t(relayErrorKey(relay.error))
    : '';

  const [redirectIn, setRedirectIn] = useState<number | null>(null);
  // PayPay 風 大型成功 overlay。dismiss 後は inline 成功 panel + redirect countdown を表示。
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  // R: gasQuote refetch (30s) で breakdown が再計算 → notification effect が再実行
  //    される。同一 tx hash の重複 webhook を防ぐため key 単位の dedup gate を使う。
  const notifiedKeyRef = useRef<string | null>(null);
  const partialOrderNotifiedKeyRef = useRef<string | null>(null);
  const partialOrderNotifyPromiseRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);

  // webhook/記録は「送金した瞬間の額」を報告する (成功描画時の live breakdown は
  // gas quote 再取得等で動きうるため、submit 時点の snapshot を真実とする)。
  // onSubmit が mutate へ渡すのと同源 (totalWei / breakdown) を固定する。
  const submitSnapshotRef = useRef<{
    totalWei: bigint;
    merchantReceives: bigint;
    feeAmount: bigint;
    customerPays: bigint;
  } | null>(null);

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
  const restoredCheckoutCompletion =
    (isStandard && standard.restoredFromStorage) ||
    (useRelay && relay.restoredIntent != null);

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
    const snapshot = submitSnapshotRef.current;
    // 許可済みの on-chain intent metadata だけでは元の items/order/callback を再構成できない。
    // reload 復元を現在 URL の受注通知・redirect へ誤帰属させる波及を断ち、same-mount だけを通知する。
    if (!snapshot || restoredCheckoutCompletion) return;
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
      // hash は fetch と並行に開始し、失敗 telemetry が必要な場合だけ await する。
      const webhookTelemetry = redactUrlForTelemetry(params.webhook);
      // お渡し準備完了通知 (flag ENABLE_ORDER_PICKUP): status トークンを 1 度だけ生成し payload に同梱。
      // notify が order:sv:<token> ポインタを保存し、顧客の /order/status?t= がそれを逆引きする。
      // webhook が OpenPay 自身の受注 notify (= モバイル注文・MobileOrderView が同一 origin の
      // `/api/order/notify?h=` を指す) のときだけ生成する。URL を parse し **same-origin かつ pathname
      // 完全一致**で判定する: substring 一致だと第三者 URL (`https://shop/hook?next=/api/order/notify`
      // 等) に statusToken を漏らしうる (Codex)。不正 URL は false。
      let isOrderNotifyWebhook = false;
      try {
        const wh = new URL(params.webhook);
        isOrderNotifyWebhook =
          wh.origin === window.location.origin && wh.pathname === '/api/order/notify';
      } catch {
        isOrderNotifyWebhook = false; // 不正 URL = notify ではない
      }
      const statusTokenForOrder =
        env.enableOrderPickup && isOrderNotifyWebhook
          ? (statusTokenRef.current ??
            (completion.mode === 'standard'
              ? orderStatusTokenForMerchantTx(completion.key)
              : generateStatusToken()))
          : null;
      if (statusTokenForOrder) {
        statusTokenRef.current = statusTokenForOrder;
        setStatusToken(statusTokenForOrder);
      }
      let customerMemo: string | undefined;
      if (isOrderNotifyWebhook && params.orderId) {
        try {
          customerMemo =
            window.sessionStorage.getItem(
              `${ORDER_MEMO_STORAGE_PREFIX}${params.orderId}`,
            ) || undefined;
        } catch {
          // sessionStorage 障害を webhook/決済完了処理へ波及させない (メモは advisory)。
        }
      }
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
        // status トークン (flag ON 時のみ)。notify がポインタ保存に使う。flag OFF では key ごと不在。
        ...(statusTokenForOrder ? { statusToken: statusTokenForOrder } : {}),
        // 受取予定時刻 (任意・Phase 4・preorder)。受注に素通し保存され厨房/ホールが表示 (advisory)。
        ...(params.pickupAt !== undefined ? { pickupAt: params.pickupAt } : {}),
        // 同一 origin の受注 notify に限り、URL に載せず sessionStorage から任意メモを渡す。
        ...(customerMemo ? { customerMemo } : {}),
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
      const sendWebhook = () =>
        postCheckoutWebhook(
          params.webhook!,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            mode: 'cors',
            keepalive: true,
          },
          isOrderNotifyWebhook,
        )
          .then(async (res) => {
            if (!res.ok) {
              const redacted = await webhookTelemetry;
              logger.warn('checkout.webhook.non_ok', {
                status: res.status,
                statusText: res.statusText,
                webhookOrigin: redacted.origin,
                webhookHash: redacted.hash,
              });
            }
          })
          .catch(async (err) => {
            const redacted = await webhookTelemetry;
            logger.warn('checkout.webhook.failed', {
              error: err,
              webhookOrigin: redacted.origin,
              webhookHash: redacted.hash,
            });
          });
      const partial =
        completion.mode === 'standard' &&
        partialOrderNotifyPromiseRef.current?.key === completion.key
          ? partialOrderNotifyPromiseRef.current.promise
          : null;
      // merchant 確定通知の KV claim が処理中のまま通常成功通知と競合し、後者が 409 で失われる
      // 波及を断つ。部分通知の成否にかかわらず完了後に従来 payload を同じ byte で送る。
      if (partial) {
        void partial.then(sendWebhook, sendWebhook);
      } else {
        void sendWebhook();
      }
      if (customerMemo && params.orderId) {
        try {
          window.sessionStorage.removeItem(
            `${ORDER_MEMO_STORAGE_PREFIX}${params.orderId}`,
          );
        } catch {
          // 送信済みメモの後片付け失敗を決済完了処理へ波及させない。
        }
      }
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
    params.pickupAt,
    params.webhook,
    params.successUrl,
    address,
    deployment.chainId,
    deployment.decimals,
    restoredCheckoutCompletion,
  ]);

  // standard の merchant leg が確定した時点で、独立 fee leg の wallet 操作を待たず受注を届ける。
  // 第三者 webhook の成功契約は広げず、OpenPay 自身の same-origin `/api/order/notify` だけを
  // additive に発火し、後続 fee 成功は従来の通常成功 payload で未収状態を解消する。
  useEffect(() => {
    const submitted = standard.lastSubmittedParams;
    const submittedFeeAmount =
      submitted?.feeAmount ?? submitSnapshotRef.current?.feeAmount;
    if (
      !isStandard ||
      submittedFeeAmount === undefined ||
      submittedFeeAmount <= 0n ||
      (!!standard.data && !standard.restoredFromStorage) ||
      !standard.merchantTxHash ||
      standard.merchantBlockNumber === undefined ||
      !params.webhook
    ) {
      return;
    }
    const mountedSnapshot = submitSnapshotRef.current;
    const attempt = mountedSnapshot
      ? { snapshot: mountedSnapshot, from: address }
      : restoredStandardOrderAttempt;
    // fingerprint が一致しない復元 hash を現在 URL の items/orderId へ通知する波及を断つ。
    if (!attempt) return;
    const { snapshot } = attempt;

    let isOrderNotifyWebhook = false;
    try {
      const webhook = new URL(params.webhook);
      isOrderNotifyWebhook =
        webhook.origin === window.location.origin &&
        webhook.pathname === '/api/order/notify' &&
        (mountedSnapshot !== null ||
          (!!params.storeHandle &&
            webhook.searchParams.getAll('h').length === 1 &&
            webhook.searchParams.get('h')?.toLowerCase() ===
              params.storeHandle.toLowerCase()));
    } catch {
      isOrderNotifyWebhook = false;
    }
    if (!isOrderNotifyWebhook) return;
    const partialNotifyKey =
      `${standard.merchantTxHash}:${standard.feeTxHash ?? 'awaiting'}`;
    if (partialOrderNotifiedKeyRef.current === partialNotifyKey) return;
    // fee hash の broadcast 後にも同じ受注を additive に通知し、直後の close/reload で
    // server reconciliation が hash を知らないまま未収へ固着する波及を断つ。
    partialOrderNotifiedKeyRef.current = partialNotifyKey;

    const statusTokenForOrder = env.enableOrderPickup
      ? (statusTokenRef.current ??
        orderStatusTokenForMerchantTx(standard.merchantTxHash))
      : null;
    if (statusTokenForOrder) {
      statusTokenRef.current = statusTokenForOrder;
      setStatusToken(statusTokenForOrder);
    }

    let customerMemo: string | undefined;
    if (params.orderId) {
      try {
        customerMemo =
          window.sessionStorage.getItem(
            `${ORDER_MEMO_STORAGE_PREFIX}${params.orderId}`,
          ) || undefined;
      } catch {
        // sessionStorage 障害を受注通知へ波及させない (メモは advisory)。
      }
    }

    logger.info('checkout.order.delivered_fee_uncollected', {
      merchantTxHash: standard.merchantTxHash,
      feeTxHash: standard.feeTxHash,
      merchant: params.to,
      orderId: params.orderId,
      token: params.token,
      chain: chainSlug,
    });

    const webhookTelemetry = redactUrlForTelemetry(params.webhook);
    const payload = {
      type: 'openpay.checkout.success',
      mode: 'standard',
      merchant: params.to,
      from: attempt.from,
      token: params.token,
      chain: chainSlug,
      chainId: deployment.chainId,
      amount: formatUnits(snapshot.totalWei, deployment.decimals),
      items: params.items,
      merchantAmount: snapshot.merchantReceives.toString(),
      feeAmount: snapshot.feeAmount.toString(),
      customerPays: snapshot.customerPays.toString(),
      orderId: params.orderId,
      description: params.description,
      ...(statusTokenForOrder ? { statusToken: statusTokenForOrder } : {}),
      ...(params.pickupAt !== undefined ? { pickupAt: params.pickupAt } : {}),
      ...(customerMemo ? { customerMemo } : {}),
      merchantTxHash: standard.merchantTxHash,
      ...(standard.feeTxHash ? { feeTxHash: standard.feeTxHash } : {}),
      blockNumber: standard.merchantBlockNumber.toString(),
      feeUncollected: true,
      ts: Date.now(),
    };
    const request = postCheckoutWebhook(
      params.webhook,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        mode: 'cors',
        keepalive: true,
      },
      true,
    )
      .then(async (res) => {
        if (!res.ok) {
          const redacted = await webhookTelemetry;
          logger.warn('checkout.webhook.non_ok', {
            status: res.status,
            statusText: res.statusText,
            webhookOrigin: redacted.origin,
            webhookHash: redacted.hash,
          });
        }
      })
      .catch(async (err) => {
        const redacted = await webhookTelemetry;
        logger.warn('checkout.webhook.failed', {
          error: err,
          webhookOrigin: redacted.origin,
          webhookHash: redacted.hash,
        });
      });
    partialOrderNotifyPromiseRef.current = {
      key: standard.merchantTxHash,
      promise: request,
    };

    if (customerMemo && params.orderId) {
      try {
        window.sessionStorage.removeItem(
          `${ORDER_MEMO_STORAGE_PREFIX}${params.orderId}`,
        );
      } catch {
        // 送信済みメモの後片付け失敗を受注通知へ波及させない。
      }
    }
  }, [
    address,
    chainSlug,
    deployment.chainId,
    deployment.decimals,
    isStandard,
    params.description,
    params.items,
    params.orderId,
    params.pickupAt,
    params.storeHandle,
    params.to,
    params.token,
    params.webhook,
    restoredStandardOrderAttempt,
    standard.feeTxHash,
    standard.data,
    standard.lastSubmittedParams,
    standard.merchantBlockNumber,
    standard.merchantTxHash,
    standard.restoredFromStorage,
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
      ...(params.orderId ? { orderId: params.orderId } : {}),
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
    if (!params.successUrl || !completion || restoredCheckoutCompletion) return;
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
    if (!canSubmit) return;
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
        // レジ standard fee であることの印。送金自体は従来どおり plain transfer のままで、
        // 2 tx 確定後に fee txHash を server 通知して用途束縛 claim を作らせるだけ (付帯処理)。
        ...(isRegisterStandardFee ? { registerFee: true as const } : {}),
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

      {/* F7: off-origin コールバック開示 (支払い前・payer 向け)。webhook/success_url/cancel_url が
          第三者ホストを指すとき、決済後に通知/遷移する先を明示する (情報提供のみ・決済は妨げない)。 */}
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
          disabled={isConnected && !canSubmit}
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
          「支払い確認中」とは別文言 — 送信済みかもしれない状態ではないため。 */}
      {!completed && gaslessStoreUnavailable && (
        <PaymentStatusPanel
          title={t('pendingStoreUnavailableTitle')}
          body={t('pendingStoreUnavailableBody')}
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

      {/* B1 Layer B (preflight): relayer degraded は additive banner で出す (Layer A と違い汎用
          error box を抑止しない・pre-submit 検証エラー[店主受取0 等]を隠さない・Codex P1)。完了後は出さない。 */}
      {!completed && relayPreflightActive && (
        <RelayFallbackBanner
          message={t('relayDegradedPreflight')}
          nativeToken={nativeToken}
          onSwitchToStandard={switchToStandard}
        />
      )}

      {/* ambiguity latch 中は同一 payload の再確認だけを許可し、standard fallback / 新署名を封鎖。 */}
      {!completed && relayAmbiguous && (
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

      {/* relay IP rate limit: idem 確認前の 429 なので main Pay / standard fallback / 再署名を
          封鎖し、保持済みの同一署名 payload の再 POST だけを許可する。 */}
      {!completed && relayIpRateLimited && !relayAmbiguous && (
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
            {!restoredCheckoutCompletion && params.orderId && (
              <ResultRow label={t('orderIdLabel')} value={params.orderId} />
            )}
          </dl>

          {/* お渡し準備完了通知 (flag ENABLE_ORDER_PICKUP): 顧客が注文状況を追えるリンク。
              click は user gesture ＝ ここで AudioContext を解錠 (iOS 自動再生対策)。flag OFF / 非
              mobile-order (webhook 無) では statusToken が null ゆえ非表示。 */}
          {env.enableOrderPickup && statusToken && (
            <Link
              href={`/${locale}/order/status?t=${statusToken}`}
              prefetch={false}
              onClick={() => primeChimeAudio()}
              className="mt-4 flex items-center justify-center rounded-xl border border-brand/30 bg-brand/5 px-4 py-3 text-sm font-semibold text-brand transition hover:bg-brand/10"
            >
              {t('viewOrderStatus')}
            </Link>
          )}

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

          {!restoredCheckoutCompletion && params.successUrl && (
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
          {(restoredCheckoutCompletion || !params.successUrl) && (
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
