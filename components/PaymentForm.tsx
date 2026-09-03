'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits, parseUnits } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { PayStepStrip } from './PayStepStrip';
import { PayEmptyLanding } from './PayEmptyLanding';
import { InfoTooltip } from './InfoTooltip';
import { OnrampCta } from './OnrampCta';
import { Row } from './Row';
import { SmartAccountFallbackBanner } from './SmartAccountFallbackBanner';
import { RelayFallbackBanner } from './RelayFallbackBanner';
import { AlertCircle } from 'lucide-react';
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
const PayerReceiptCompletion = dynamic(
  () =>
    import('./PayerReceiptCompletion').then((m) => m.PayerReceiptCompletion),
  { ssr: false },
);
const PaymentStatusPanel = dynamic(
  () =>
    import('./PaymentStatusPanel').then((m) => m.PaymentStatusPanel),
  { ssr: false },
);
const PaymentResultPanel = dynamic(
  () =>
    import('./PaymentResultPanel').then((m) => m.PaymentResultPanel),
  { ssr: false },
);
const SignReassurance = dynamic(
  () => import('./SignReassurance').then((m) => m.SignReassurance),
);
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
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
import {
  isFallbackSafeRelayError,
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
import { type GasMode } from '@/lib/fee';
import {
  effectiveGasMode,
  isMerchantGasAbsorb,
  effectivePayMode,
  effectiveGasAmount as deriveEffectiveGasAmount,
  paymentBreakdown,
  paymentSplitBreakdown,
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
import {
  usePaymentHistory,
  type AppendPaymentHistoryCtx,
} from '@/hooks/usePaymentHistory';
import { useRelayGaslessSnapshot } from '@/hooks/useRelayGaslessSnapshot';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import type { ExecuteResult } from '@/hooks/useCrossChainPayment';
import { resolvePaymasterMode } from '@/lib/pimlico';
import {
  counterpartSymbol,
  DEFAULT_CHAIN_FOR_SYMBOL,
  deploymentForSlug,
  displaySymbolFor,
} from '@/lib/tokens';
import {
  DECIMAL_PATTERN,
  exceedsTokenPrecision,
  parsePayParams,
  type PayParams,
} from '@/lib/url';
import { formatRemaining, isExpired, secondsRemaining } from '@/lib/fx';
import { formatTokenAmount, shortAddress } from '@/lib/format';
import {
  buildJpycRelaySignPreview,
  buildJpycRecoverSignPreview,
} from '@/lib/signPreview';
import { appendPayerReceipt, buildPayerReceipt } from '@/lib/payerReceipt';
import { RecoverFeeNotice } from './RecoverFeeNotice';

type PaymentAttemptSnapshot = {
  amountDisplay: string;
  amountHuman: string;
  historyCtx: AppendPaymentHistoryCtx;
};

function snapshotHistoryCtx(
  ctx: AppendPaymentHistoryCtx,
): AppendPaymentHistoryCtx {
  return {
    ...ctx,
    // 入力変更で再生成される明細参照が attempt の履歴・控えへ波及しないよう、
    // line item も値として固定する。
    lineItems: ctx.lineItems?.map((item) => ({ ...item })) ?? null,
  };
}

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
  const locale = useLocale();
  const [modeOverride, setModeOverride] = useState<'standard' | null>(null);
  const attemptRouteRef = useRef<PaymentRoute | null>(null);
  // parsePayParams は chain を常に解決するが、型上は optional。安全側で default に倒す。
  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const paymasterMode = resolvePaymasterMode(deployment);

  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  // sessionStorage に broadcast 済み standard intent が残る場合、元 URL が gasless でも
  // standard の receipt 復元を本線に固定する。storage 読込中は下の readiness で全経路を止める。
  const standard = useStandardPayment();

  // Phase 1 relay は単発 transfer のみ。split 指定時は従来の 7702 経路へ倒す (split 対応は Phase 2)。
  const hasSplit = !!params.split && params.split.length > 0;

  // 決済経路の単一情報源 (Phase 1.1)。散在していた isStandard / useRelay / useRecover / isCircle を
  // この 1 値から導出する。引数は現行どおりに算出した解決済み値で、判定の優先順位・短絡は
  // resolvePaymentRoute が現行ロジックをそのまま再現する (挙動不変)。CheckoutForm と同型だが、
  // PaymentForm は split 決済に対応するため disableRelay=hasSplit を渡す (現行 useRelay の
  // `!hasSplit` ガード相当。split は Phase 1 relay 非対応なので非 relay 経路へ倒す)。
  //   - isStandard: params.mode='standard' か SA fallback の override。
  //   - JPYC ガスレスを EIP-3009 relay に倒すか (flag ON + JPYC + relay 対応 chain)。OFF / 非対応 /
  //     split は 'pimlico-7702' 同等で従来挙動 (Pimlico fallback)。relay は smart account / gas quote
  //     不要で、顧客が署名するだけ・自前 relayer がガス負担 (memory:jpyc-eip3009)。
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
    disableRelay: hasSplit,
  });
  // submit gesture で選ばれた経路を attempt 単位で固定する。relay POST と degraded banner の
  // click が競合しても、進行中 attempt が standard へ差し替わる窓を作らない。
  const route = attemptRouteRef.current ?? resolvedRoute;
  const isStandard = isStandardRoute(route);
  const isErc20Paymaster = !isStandard && paymasterMode === 'erc20';
  const useRelay = isRelayRoute(route);
  const relay = useJpycEip3009Payment(deployment);
  // B1 Layer B: relay 経路でのみ relayer の事前 (preflight) 健全性を polling する。degraded なら
  // 署名 *前* に「通常決済へ切替」を先回り案内する (Layer A は submit 失敗 *後* の reactive な導線)。
  // fail-open (読込中/error は degraded:false) なので advisory に徹し決済実行には影響しない。
  const relayHealth = useRelayHealth({
    chainId: deployment.chainId,
    enabled: useRelay,
  });

  // recover: relay かつ forwarder 設定済 chain (gas 相当額を JPYC 回収)。relayGasEquiv (= recover 時の
  // 利用料) は amountWei 確定後に算出する (CDX-3: 実スケジュール recoverFeeValue を使い、bps>0 で
  // 会計サマリと実 settle 額を一致させる)。
  const useRecover = isRecoverRoute(route);

  // 確定モデル (2026-06-12): JPYC recover 決済は店舗が常に手数料を吸収する固定 (gasMode=merchant)。
  // 旧 QR が gas=customer を載せていても無視し merchant に倒す (発行済 QR の audience は極小で
  // user-approved)。recover 以外は URL の gas をそのまま使う (USDC の負担者トグルは不変)。
  // money 計算は route 駆動の純関数 (lib/paymentMoney) に一元化済 (Phase 1.2・式は不変)。
  const effectiveGas: GasMode = effectiveGasMode(route, params.gas);

  // Smart Account は gasless (非 relay) のみ必要 — standard / relay では enabled=false で skip。
  const { data: saData, error: saError } = useSmartAccount(
    deployment,
    !isStandard && !useRelay,
  );

  // 全フックを常に call し、mode で送信先を分岐 (条件付きフックは禁止)。relay 経路は
  // smart account / gas quote 不要なので enabled=false で skip する。
  const gasless = useBatchPayment(deployment, !isStandard && !useRelay);
  const gasQuote = useGasQuote(deployment, !isStandard && !useRelay);
  // USDC ガスレスが Circle Paymaster に解決される場合は surcharge 込みの quote +
  // permit allowance を Circle 専用フックから取る (route 由来。provider は flag/allowlist/fee で決まる)。
  const isCircle = isCircleRoute(route);
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
  const [crossChainLocked, setCrossChainLocked] = useState(false);
  const [crossChainResult, setCrossChainResult] = useState<ExecuteResult>();
  const directAttemptSnapshotRef = useRef<PaymentAttemptSnapshot | null>(null);
  const crossChainAttemptSnapshotRef =
    useRef<PaymentAttemptSnapshot | null>(null);

  // 動的 QR の UI 上の期限目安。exp 付き QR (FX 換算で生成) のみカウントダウン +
  // この正規 /pay 画面内で block する。exp は未署名なのでサーバ強制の有効期限ではない。
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
  const anchorDisplay = displaySymbolFor(counterpartSymbol(params.token));

  // 画面上の期限目安を過ぎた QR に顧客が遭遇したことを 1 度だけ観測
  // (logger.warn → Sentry alertable)。
  // 3 分窓が摩擦を生んでいないか / 店主の再生成運用が回っているかの運用シグナル。
  const expiryLoggedRef = useRef(false);
  useEffect(() => {
    if (expired && !expiryLoggedRef.current) {
      expiryLoggedRef.current = true;
      logger.warn('pay.qr_expired', {
        chainId: deployment.chainId,
        asset: params.token,
      });
    }
  }, [expired, deployment.chainId, params.token]);

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

  // recover 時に回収する利用料 (= 実 settle で feeReceiver へ分割される額)。CDX-3: 実スケジュール
  // recoverFeeValue(billAmount, effectiveGas) を使う。billAmount は relay.mutate に渡す amountWei、
  // effectiveGas は recover で強制される 'merchant'。これにより会計サマリ・merchant net・履歴
  // スナップショットが実 settle 額と一致する。bps=0 では floor (= 2 JPYC) になり従来挙動と完全一致。
  // free (非 recover) は 0n。
  const relayGasEquiv = useRecover
    ? recoverFeeValue(amountWei, effectiveGas, deployment.chainId)
    : 0n;

  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  const isMerchantGas = isMerchantGasAbsorb(route, effectiveGas);
  // 「店主がガスを負担」表示が実態に合うのは、実際に gas コストが発生する経路のみ
  // (recover relay、または非 relay の paymaster 見積)。free relay (OpenPay 全額負担)
  // では gas コストが無く merchant が負担するものが無いため、旧 gas=merchant QR でも
  // 負担者バナーを出さない。会計上の金額計算 (isMerchantGas) は不変。
  // JPYC ガス無料化 (2026-06-05): JPYC のガスレスは recover (forwarder 設定) を除き
  // 常に無料 (OpenPay が gas を全額負担し誰からも徴収しない)。relay free 経路だけでなく、
  // 非 relay の Pimlico sponsorship 経路 (split など) も同様に無徴収とし、決済額は全額が
  // 店主へ届く。USDC は従来どおり (顧客が paymaster に gas を支払う)。
  const isJpyc = deployment.symbol === 'jpyc';
  // 「店主がガスを負担」表示が実態に合うのは、実際に gas コストが店主に転嫁される経路
  // のみ (USDC で gas=merchant、または JPYC recover)。JPYC の無料経路 (relay free /
  // sponsorship free) では gas コストが無いため、旧 gas=merchant QR でも負担者バナーを
  // 出さない。会計金額計算は effectiveGasAmount=0 で自然に「控除なし」になる。
  const merchantGasActive = isMerchantGas && !(isJpyc && !useRecover);

  // gas 見積 (gasless mode のみ):
  //   ERC20 Paymaster (USDC): paymaster が顧客 USDC から actualGas を別途徴収。
  //   Sponsorship (JPYC): Pimlico が POL gas を立替、運営が全額負担 (無徴収)。
  //   standard mode: 顧客 wallet が gas を自前で算定・支払うため OpenPay 側で見積らない。
  const gasAmount = !isStandard ? activeQuote.data?.gasAmount : undefined;
  // breakdown/会計に使う gas 相当額: relay は固定の回収額 (recover=fee / free=0)、
  // JPYC 非 relay (sponsorship) は無徴収のため 0、USDC は paymaster quote。
  //
  // 【不変条件: USDC erc20/circle の gas=merchant は二重徴収ではない】
  // merchant 着金から gas 見積を控除するが、その控除分は顧客の手元に残り、
  // 顧客がそれで paymaster の実 gas pull を賄う (= 控除は顧客への前補填)。
  // ネットで 顧客支出 = amount・店主受領 = amount − gas となり、
  // JPYC recover (控除分を feeReceiver へ送って立替者を補償) と等価。
  // gasMode の約束 (店主吸収: 顧客は請求額のみ・店主は amount−gas) は USDC でも成立。
  // 残る差は gas 見積と実 pull 額の僅差のみ (standard tier で有界)。
  // money 計算は route 駆動の純関数 (lib/paymentMoney) に一元化済 (Phase 1.2・式は不変)。
  const effectiveGasAmount: bigint | undefined = deriveEffectiveGasAmount(
    route,
    { isJpyc, relayGasEquiv, gasAmount },
  );

  const effectiveMode = effectivePayMode(route, params.mode);
  const breakdown = useMemo(
    () =>
      paymentBreakdown({
        totalWei: amountWei,
        token: params.token,
        payMode: effectiveMode,
        gasMode: effectiveGas,
        effectiveGasAmount,
      }),
    [amountWei, params.token, effectiveMode, effectiveGas, effectiveGasAmount],
  );

  // standard mode では split は無視 (シンプルな EOA 直列 transfer に限定)。
  // gas 軸は calcBreakdown と同じ effectiveGasAmount を使う (JPYC は無料経路で 0 のため
  // 受取人の按分・顧客 outflow が gas で目減りしない。raw gasAmount を使うと JPYC split で
  // gasReimbursement=0 と矛盾し受取人が過少配分になる)。
  const splitBreakdown = useMemo(() => {
    if (isStandard || !params.split || params.split.length === 0) return null;
    // split は非 standard かつ relay 抑止 (disableRelay=hasSplit) のため、effectiveMode=params.mode・
    // effectiveGas=params.gas??'customer' と一致する。byte 単位の同一性のため現行どおり params.mode /
    // params.gas をそのまま渡す (calcSplitBreakdown の gasMode 既定 'customer' が undefined を吸収)。
    return paymentSplitBreakdown({
      totalWei: amountWei,
      token: params.token,
      primary: params.to,
      splits: params.split,
      payMode: params.mode,
      gasMode: params.gas,
      effectiveGasAmount,
    });
  }, [
    isStandard,
    amountWei,
    params.token,
    params.to,
    params.split,
    params.mode,
    params.gas,
    effectiveGasAmount,
  ]);

  // 顧客支払額: calcBreakdown が gasMode を考慮済 (customer なら +gas、merchant なら amount のまま)
  const totalCustomerOutflow = splitBreakdown
    ? splitBreakdown.customerPays
    : breakdown.customerPays;

  // JPYC ガス無料化: JPYC は recover (forwarder) 以外 gas を一切徴収しないため、JPYC の
  // gasReimbursement は常に 0 (OpenPay が全額負担)。mainnet USDC は erc20 で 0 (paymaster が
  // 顧客から直接徴収)。残るのは testnet の USDC sponsorship fallback (非商用・非 JPYC) のみで、
  // ここは従来どおり gas 相当を回収する。circle は二重徴収回避で 0。
  const gasReimbursement = gasReimbursementValue(route, {
    isJpyc,
    paymasterMode,
    gasAmount,
  });

  // 記録用ネットワーク手数料相当額 (会計分離・on-chain transfer とは別)。非 circle の
  // gasless 経路は gas 見積を計上する: JPYC sponsorship は立替回収 (= feeReceiver へ送る
  // gasReimbursement と同額)、USDC erc20 は paymaster が顧客 USDC から直接徴収する gas。
  // circle は receipt 由来の circlePaymasterNetUsdc を検証ステータス付きで使うため null、
  // standard は OpenPay が gas に touch しないため null。
  const networkFeeEquivalent = networkFeeEquivalentValue(
    route,
    effectiveGasAmount,
  );

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
  const minimumAmountWei = deriveMinimumAmountWei({
    feeAmount: breakdown.feeAmount,
    isMerchantGas,
    effectiveGasAmount,
  });

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
  const directFlowPending = standard.isRestoring || relay.isRestoring
    ? true
    : relayAmbiguous || gaslessAmbiguous
    ? true
    : isStandard
      ? standard.isPending
      : useRelay
        ? relay.isPending
        : gasless.isPending;
  const flowPending = directFlowPending || crossChainLocked;
  // relay は gas quote も smart account も不要なので readiness は常に満たす。
  const gasQuoteReady = isStandard || useRelay || activeQuote.data !== undefined;
  // 送金が確定 (または broadcast 済で確定しうる) 後の再送信を禁止。再送すると同一
  // 受取人へ 2 件目の on-chain 送金 = 二重支払いになる。revert (送金未成立) は安全
  // なので再試行を許す。standard の fee-error は merchant transfer が確定済なので
  // main ボタンは禁止し、fee の再送は専用 retryFee ボタンのみに限定する。
  const directSettledNoRetry =
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
  const settledNoRetry = directSettledNoRetry || !!crossChainResult;
  // 未接続時に最下部 CTA からウォレット選択セクションへ誘導するためのアンカー。
  const walletSectionRef = useRef<HTMLElement | null>(null);

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
    !settledNoRetry &&
    // gasless 経路のみ封鎖 (standard へ切り替えれば支払える)。
    !gaslessStoreUnavailable &&
    // 正規 /pay UI では期限目安超過後の支払いをブロック (固定レートが陳腐化しているため)。
    // 未署名 exp のため、これは敵対的な支払者へサーバ強制できる防御ではない。
    !expired &&
    // exp 付き QR は now 計測 (effect 後) まで送信不可 = 計測前 (expired=false) の
    // 初回フレームで既期限切れ QR が送信される窓を塞ぐ。
    (params.expiresAt === undefined || timeMeasured);

  // gas congested は gasless モード固有の早期 abort。i18n された案内文に
  // 差し替え (standard モードは paymaster を経由しないため対象外)。
  // gasQuote の失敗は Pimlico RPC エラーで生表示するとユーザに技術詳細が
  // 漏れるため、i18n 化した friendly メッセージに置き換える (詳細は logger 経由で Sentry へ)。
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
    ? isFallbackSafeRelayError(flowError)
      ? t(relayErrorKey(flowError))
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

  // B1 graceful degradation (Layer A): relay が API レベルで失敗 (rate_limited 等の error code) した
  // とき、ガス代自己負担の「通常決済」へ 1 タップで切り替える導線を出す。on-chain revert
  // (relay.data.success===false) は別経路 (revertedNoFeedback)、response-unknown は再送封鎖で
  // 扱うため、ここでは fallback-safe error のみを条件にする。banner の中で friendly 文言を
  // 1 度だけ出し、下の汎用 error ブロックでは重複表示しない。
  const relayFallbackActive =
    useRelay &&
    !relay.isPending &&
    !relayAmbiguous &&
    isFallbackSafeRelayError(relay.error);
  // B1 Layer B (preflight): relay 経路で relayer が degraded、かつ顧客がまだ submit していない
  // (relay.error なし・relay.data なし) ときに、署名 *前* に「通常決済へ切替」を先回りで促す。
  // Layer A (relay.error) とは独立に評価する (両方 true にはならない・!relay.error が排他)。
  const relayPreflightActive =
    useRelay &&
    relayHealth.degraded &&
    !relay.isPending &&
    !relayAmbiguous &&
    !relay.error &&
    !relay.data;
  // Layer A の banner 文言 (per-error friendly)。Layer A は汎用 error box を「置換」する (同じ relay
  // error が二重表示になるのを防ぐ) が、Layer B は「additive」に出す (汎用 error box を抑止しない)。
  const relayFallbackMessage = isFallbackSafeRelayError(relay.error)
    ? t(relayErrorKey(relay.error))
    : '';

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
  // v5: 記帳補助メタ (店舗名/商品名/メモ/税/管理番号) は QR の URL params (store/pname/
  // memo/tax/taxcat/rcpt) に乗るので決済側の履歴に記録できる。productName があれば
  // 単一明細 (qty 1・単価=支払額) を組み立てて lineItems に入れる (複数明細は checkout)。
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
      saleAmount: amountWei,
      networkFeeEquivalent,
      storeName: params.storeName ?? '',
      note: '',
      // 異通貨建て (FX 換算 QR) の anchor。priceRefAmount/fxRate が URL に在るときのみ記録。
      // anchorSymbol は settled token (params.token) の counterpart (= 価格を建てた側)。
      anchorAmount: params.priceRefAmount ?? null,
      anchorSymbol: params.priceRefAmount
        ? counterpartSymbol(params.token)
        : null,
      fxRateUsdcJpy: params.fxRate ?? null,
      // v5 記帳補助メタ (任意項目 QR のみ非 null)。
      productName: params.productName ?? null,
      memo: params.memo ?? null,
      taxRate: params.taxRate ?? null,
      taxCategory: params.taxCategory ?? null,
      receiptNo: params.receiptNo ?? null,
      lineItems: params.productName
        ? [
            {
              name: params.productName,
              quantity: 1,
              unitPrice: amountStr || '',
              amount: amountStr || '',
              taxRate: params.taxRate ?? null,
              taxCategory: params.taxCategory ?? null,
              memo: params.memo ?? null,
            },
          ]
        : null,
      // 顧客向け電子レシート (PayerReceipt) の発生元 / 表示 locale。
      sourceRoute: '/pay',
      locale,
    }),
    [
      deployment.chainId,
      deployment.address,
      chainSlug,
      params.token,
      effectiveGas,
      params.to,
      isStandard,
      breakdown.merchantReceives,
      breakdown.feeAmount,
      amountWei,
      amountStr,
      networkFeeEquivalent,
      address,
      params.priceRefAmount,
      params.fxRate,
      params.storeName,
      params.productName,
      params.memo,
      params.taxRate,
      params.taxCategory,
      params.receiptNo,
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
    relay.restoredIntent
      ? relay.restoredIntent.routeKind === 'recover'
      : useRecover,
    relay.restoredIntent?.chainId ?? deployment.chainId,
  );
  const restoredRelayPayment =
    useRelay && relay.restoredIntent != null;
  const restoredStandardPayment =
    isStandard && standard.restoredFromStorage;
  // 永続化を許可された on-chain metadata だけでは元の product/memo/receipt 文脈を再構成できない。
  // 復元済み hash を現在の /pay URL の履歴・控えへ誤帰属させる波及を断ち、hash の成功表示だけ残す。
  const gaslessForHistory =
    restoredRelayPayment
      ? { error: null }
      : useRelay
        ? relayHistoryGasless
        : gasless;
  const standardForHistory = restoredStandardPayment
    ? { phase: 'idle', error: null }
    : standard;
  usePaymentHistory(
    directAttemptSnapshotRef.current?.historyCtx ?? historyCtx,
    gaslessForHistory,
    standardForHistory,
  );

  const onCrossChainAttemptStart = useCallback(
    (attemptAmount: bigint) => {
      const amountHuman = formatUnits(attemptAmount, deployment.decimals);
      const attemptHistoryCtx = snapshotHistoryCtx({
        ...historyCtx,
        merchantAmount: attemptAmount,
        feeAmount: 0n,
        saleAmount: attemptAmount,
        networkFeeEquivalent: null,
        lineItems: historyCtx.lineItems?.map((item) => ({
          ...item,
          unitPrice: amountHuman,
          amount: amountHuman,
        })) ?? null,
      });
      crossChainAttemptSnapshotRef.current = {
        amountDisplay: formatTokenAmount(attemptAmount, deployment),
        amountHuman,
        historyCtx: attemptHistoryCtx,
      };
      setCrossChainLocked(true);
    },
    [deployment, historyCtx],
  );
  const onCrossChainExecutingChange = useCallback((executing: boolean) => {
    setCrossChainLocked(executing);
  }, []);
  const onCrossChainSuccess = useCallback(
    (result: ExecuteResult) => {
      setCrossChainResult(result);
      setCrossChainLocked(false);
      const snapshot = crossChainAttemptSnapshotRef.current;
      if (!snapshot) return;
      const ctx = snapshot.historyCtx;
      // localStorage 控えの失敗を成立済み cross-chain 決済へ波及させない処理は、
      // appendPayerReceipt 内の既存 no-throw storage 境界に委ねる。
      appendPayerReceipt(
        buildPayerReceipt({
          txHash: result.mintTxHash,
          chainId: result.destChainId,
          asset: params.token,
          tokenAddress: deployment.address,
          amount: snapshot.amountHuman,
          merchantAddress: params.to,
          merchantName: params.storeName ?? null,
          payerAddress: address,
          paymentMode: 'cross-chain',
          gasMode: 'customer',
          lineItems: ctx.lineItems,
          subtotalAmount: snapshot.amountHuman,
          totalAmount: snapshot.amountHuman,
          memo: params.memo ?? null,
          receiptNo: params.receiptNo ?? null,
          anchorAmount: ctx.anchorAmount,
          anchorSymbol: ctx.anchorSymbol
            ? displaySymbolFor(ctx.anchorSymbol)
            : null,
          fxRate: ctx.fxRateUsdcJpy,
          sourceRoute: '/pay',
          locale,
        }),
      );
    },
    [
      address,
      deployment.address,
      locale,
      params.memo,
      params.receiptNo,
      params.storeName,
      params.to,
      params.token,
    ],
  );

  function onSubmit() {
    if (!canSubmit) return;
    attemptRouteRef.current = route;
    directAttemptSnapshotRef.current = {
      amountDisplay: fmt(totalCustomerOutflow),
      amountHuman: formatUnits(amountWei, deployment.decimals),
      historyCtx: snapshotHistoryCtx(historyCtx),
    };
    // 完了画面のチャイムを iOS でも鳴らせるよう、この gesture 内で AudioContext を解錠。
    primeChimeAudio();
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
        // 店舗売上 gross は商品小計。顧客上乗せ手数料を merchantAmount に加算しない。
        saleAmount: amountWei,
      });
    } else if (useRelay) {
      // JPYC EIP-3009 relay: 顧客が transferWithAuthorization に署名 → Gelato が gas 負担で submit。
      // fee=0・gas は OpenPay 肩代わりなので、全額 (amountWei) をそのまま merchant へ単発送金。
      relay.mutate({
        merchant: params.to,
        value: amountWei,
        gasMode: effectiveGas,
      });
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

  function switchToStandard() {
    // 進行中/曖昧な relay attempt から standard へ切り替わると二重払いになりうる。
    // fallback-safe な pre-broadcast error のときだけ固定を解き、従来の切替を許可する。
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

  // 「署名安心 UX」(plans/sign-reassurance-ux.md・P1+P2)。経路別に kind を出し分ける
  // (計画 §3.3 経路別コピーマトリクス・署名内容は不変・表示のみ)。Pimlico 7702 経路 (split の
  // 非 relay JPYC など) はスコープ外なので出さない (計画 §2)。
  //   (a) relay free (forwarder 未設定): jpyc-relay-free フルパネル。preview は relay.mutate
  //       ({ merchant: params.to, value: amountWei }) と同一変数から導出し、ウォレットに出る
  //       生の数字 (value) と OpenPay 表示の乖離をゼロにする。testnet 等 forwarder 無し chain 用。
  //   (a') relay recover (forwarder 設定済・本番 Polygon/Kaia): jpyc-relay-recover フルパネル (P4)。
  //       to=forwarder (決済コントラクト)・customer は value+fee をウォレットに出すため、照合表で
  //       内訳を説明する。preview は relay.mutate の変数 (params.to / amountWei / params.gas) と
  //       同一ソース。forwarder 無しなら build が null → free 経路へ倒れる。
  //   (b) standard: 通常の送金確認 1 行ヒント。
  //   (c) Circle (USDC gasless): usdc-permit。permitCap は circle quote の permitAmount を
  //       formatUnits (未取得なら省略)。split があれば transferCount を渡す。
  const showRelayFree =
    useRelay &&
    jpycForwarderFor(chainId ?? deployment.chainId) === null &&
    amountWei > 0n;
  const recoverPreview =
    useRecover && amountWei > 0n
      ? buildJpycRecoverSignPreview({
          value: amountWei,
          merchant: params.to,
          storeName: params.storeName,
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
          value: amountWei,
          merchant: params.to,
          storeName: params.storeName,
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
      : isCircle && amountWei > 0n
        ? {
            kind: 'usdc-permit',
            amountHuman: formatUnits(amountWei, deployment.decimals),
            symbol: deployment.displaySymbol,
            permitCapHuman:
              circlePermitAmount !== undefined
                ? formatUnits(circlePermitAmount, deployment.decimals)
                : undefined,
            // split の追加受取人 + primary を 1 permit で行うので transferCount = 1 + extras。
            transferCount: hasSplit ? 1 + (params.split?.length ?? 0) : undefined,
            awaiting: gasless.isPending,
          }
        : null;

  // Recover モードの手数料開示に渡す請求額。recover でなければ null で非表示。
  const recoverBillAmount = useRecover && amountWei > 0n ? amountWei : null;

  // PayPay 風 大型成功 overlay の payload (Phase 1.4)。従来は gasless / relay / standard 経路ごとに
  // 3 連で SuccessOverlay を出していたのを、各経路と byte 一致する payload 1 個に集約する。各ガードは
  // 従来の overlay 呼び出しと完全同一 (relay は userOpHash/blockNumber を省き、standard は userOpHash を
  // 省く = undefined)。金額は submit gesture で固定した attempt snapshot だけを読む。未成功または
  // snapshot 不在のときは null とし、成功時の live 入力を控えとして表示しない。
  const directAttemptAmountDisplay =
    directAttemptSnapshotRef.current?.amountDisplay;
  const crossChainAttemptAmountDisplay =
    crossChainAttemptSnapshotRef.current?.amountDisplay;
  const successOverlayPayload: PaymentSuccessOverlayPayload | null =
    crossChainResult && crossChainAttemptAmountDisplay
      ? {
          amountDisplay: crossChainAttemptAmountDisplay,
          txHash: crossChainResult.mintTxHash,
          explorerBase: blockExplorerUrl(crossChainResult.destChainId),
          merchantAddress: params.to,
        }
      : !isStandard &&
          !useRelay &&
          gasless.data &&
          gasless.data.success &&
          directAttemptAmountDisplay
      ? {
          amountDisplay: directAttemptAmountDisplay,
          txHash: gasless.data.txHash,
          userOpHash: gasless.data.userOpHash,
          blockNumber: gasless.data.blockNumber,
          explorerBase,
          merchantAddress: params.to,
        }
      : useRelay &&
          relay.data &&
          relay.data.success &&
          relay.data.txHash &&
          directAttemptAmountDisplay
        ? {
            amountDisplay: directAttemptAmountDisplay,
            txHash: relay.data.txHash,
            explorerBase,
            merchantAddress: params.to,
          }
        : isStandard && standard.data && directAttemptAmountDisplay
          ? {
              amountDisplay: directAttemptAmountDisplay,
              txHash: standard.data.merchantTxHash,
              blockNumber: standard.data.blockNumber,
              explorerBase,
              merchantAddress: params.to,
            }
          : null;

  return (
    <div className="space-y-6">
      <header className="rounded-3xl bg-gradient-to-br from-brand to-brand-dark p-6 text-white shadow-lift">
        <p className="text-sm uppercase tracking-wider opacity-80">
          {t('title')}
        </p>
        <p className="mt-1 text-xs opacity-70">{requiredChain.name}</p>
        <div className="mt-4">
          <p className="text-xs opacity-80">{t('amountHeader')}</p>
          {isFixed ? (
            <p className="mt-1 text-4xl font-bold tracking-tight">
              {fixedAmount} {deployment.displaySymbol}
            </p>
          ) : (
            <div className="mt-2">
              <input
                type="text"
                inputMode="decimal"
                value={inputAmount}
                disabled={flowPending || settledNoRetry}
                onChange={(e) =>
                  setInputAmount(e.target.value.replace(/[^\d.]/g, ''))
                }
                placeholder={deployment.symbol === 'jpyc' ? '1000' : '10.00'}
                className="w-full rounded-lg bg-white/15 px-3 py-2 text-2xl font-bold text-white placeholder:text-white/50 focus:bg-white/20 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
              />
              <p className="mt-1 text-xs opacity-70">
                {t('amountInputHint', { symbol: deployment.displaySymbol })}
              </p>
            </div>
          )}
        </div>
      </header>

      <RecoverFeeNotice
        billAmount={recoverBillAmount}
        chainId={deployment.chainId}
        gasMode={effectiveGas}
      />

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

      {/* UI 上の期限目安超過: この画面では支払いをブロックし、再生成を促す。
          未署名 exp のためサーバ強制ではない旨は expiredBody で明示する。 */}
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
          onSwitchToStandard={switchToStandard}
        />
      )}

      <section className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-card">
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
          ) : useRelay || isJpyc ? (
            // JPYC ガスレス (relay free / 非 relay sponsorship free) は無徴収。
            // 顧客負担ではないため中立ラベル (gasRowFree)。
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
        {merchantGasActive && !isStandard && (
          <p className="mt-3 text-xs text-emerald-700">
            {t('merchantGasHint')}
          </p>
        )}
        <p className="mt-4 text-xs text-slate-500">
          {isStandard
            ? t('standardBatchHint')
            : useRecover
              ? t('gaslessBatchHintJpycRecover')
              : useRelay || isJpyc
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

      {/* 初回向け 3 ステップ視覚ガイド (未接続時のみ・「アプリ/登録不要」)。 */}
      {!isConnected && <PayStepStrip />}

      <section
          ref={walletSectionRef}
          className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
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
            {balance !== undefined && totalCustomerOutflow > balance && (
              <p className="mt-0.5 font-semibold">
                {t('insufficientShortfall', {
                  amount: fmt(totalCustomerOutflow - balance),
                })}
              </p>
            )}
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
            // この UI の期限目安超過時は代替 cross-chain 経路 (CrossChainHint 内の独自 Pay) も封じる。
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
            executionDisabled={directFlowPending || directSettledNoRetry}
            onAttemptStart={onCrossChainAttemptStart}
            onExecutingChange={onCrossChainExecutingChange}
            onSuccess={onCrossChainSuccess}
          />
        )}
      </section>

      {/* 署名安心パネル/ヒント (Pay ボタン直上)。経路別に kind を出し分ける (計画 §3.3)。
          relay free=フルパネル / standard=1 行ヒント / Circle USDC=usdc-permit。recover と
          Pimlico 7702 はスコープ外で出さない。署名/確認待ち中は待機表示に置換する。
          表示専用で決済ロジックには触れない。 */}
      {signReassurance && <SignReassurance {...signReassurance} />}

      <button
        type="button"
        // 未接続時 (期限切れ除く): 押せない「ウォレットを接続」を解消し、タップで
        // ウォレット選択へスクロール (#266 CheckoutForm と同型・決済フロー不変)。
        onClick={
          !expired && !isConnected
            ? () =>
                  walletSectionRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                  })
            : onSubmit
        }
        disabled={(expired || isConnected) && !canSubmit}
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

      {/* standard receipt RPC が読めない間は broadcast 済み tx の成否が不明。
          main Pay / fee retry は出さず、同じ hash の receipt 再照会のみ許可する。 */}
      {isStandard && standard.isUnknown && (
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

      {/* 支払い記録を保存できない端末では gasless だけを止める (通常送信は使える)。
          「支払い確認中」とは別文言 — 送信済みかもしれない状態ではないため。 */}
      {gaslessStoreUnavailable && (
        <PaymentStatusPanel
          title={t('pendingStoreUnavailableTitle')}
          body={t('pendingStoreUnavailableBody')}
          titleWithIcon
        />
      )}

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

      {/* B1 Layer A: relay の API レベル失敗 (rate_limited 等) は「通常決済へ切替」banner で出し、
          下の汎用 error box は抑止する (同じ relay error の二重表示を防ぐ)。それ以外の error は
          従来どおり赤ボックス。 */}
      {relayFallbackActive ? (
        <RelayFallbackBanner
          message={relayFallbackMessage}
          nativeToken={nativeToken}
          onSwitchToStandard={switchToStandard}
        />
      ) : (
        error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p className="flex items-center gap-1.5 font-semibold">
              <AlertCircle className="h-4 w-4 flex-none" aria-hidden />
              {t('errorTitle')}
            </p>
            <p className="mt-1 break-words">{error}</p>
          </div>
        )
      )}

      {/* B1 Layer B (preflight): relayer が degraded なときは署名 *前* に additive banner を出す。
          Layer A と違い汎用 error box を抑止しない (金額精度/店主受取0 など pre-submit 検証エラーを
          隠さない・Codex P1)。relay.error / relay.data があるときは出さない (排他は変数側で担保)。 */}
      {relayPreflightActive && (
        <RelayFallbackBanner
          message={t('relayDegradedPreflight')}
          nativeToken={nativeToken}
          onSwitchToStandard={switchToStandard}
        />
      )}

      {/* ambiguity latch 中は同一 payload の再確認だけを許可し、standard fallback / 新署名を封鎖。 */}
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

      {/* relay IP rate limit: idem 確認前の 429 なので main Pay / standard fallback / 再署名を
          封鎖し、保持済みの同一署名 payload の再 POST だけを許可する。 */}
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

      {crossChainResult && (
        <>
          <PaymentResultPanel
            title={t('successTitle')}
            rows={[
              {
                label: t('successTx'),
                value: crossChainResult.mintTxHash,
                copyable: true,
              },
            ]}
          />
          <PayerReceiptCompletion
            candidateIds={[crossChainResult.mintTxHash]}
          />
        </>
      )}

      {!isStandard && !useRelay && gasless.data && gasless.data.success && (
        <>
          <PaymentResultPanel
            title={t('successTitle')}
            rows={[
              { label: t('successUserOp'), value: gasless.data.userOpHash, copyable: true },
              { label: t('successTx'), value: gasless.data.txHash, copyable: true },
              { label: t('successBlock'), value: gasless.data.blockNumber.toString() },
            ]}
          />
          <PayerReceiptCompletion
            candidateIds={[gasless.data.txHash, gasless.data.userOpHash]}
          />
        </>
      )}

      {/* relay は userOp/block を持たないため Tx Hash のみ表示 (Explorer link は overlay 側)。 */}
      {useRelay && relay.data && relay.data.success && relay.data.txHash && (
        <>
          <PaymentResultPanel
            title={t('successTitle')}
            rows={[{ label: t('successTx'), value: relay.data.txHash, copyable: true }]}
          />
          <PayerReceiptCompletion candidateIds={[relay.data.txHash]} />
        </>
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

      {isStandard && standard.data && (
        <>
          <PaymentResultPanel
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
          <PayerReceiptCompletion candidateIds={[standard.data.merchantTxHash]} />
        </>
      )}

      {/* PayPay 風 大型成功 overlay。dismiss するまで全画面で「決済完了」+ 金額 + 時刻表示。
          gasless / relay / standard の 3 連は共通 PaymentSuccessOverlay へ集約 (payload で mode 差を
          吸収・挙動不変)。 */}
      <PaymentSuccessOverlay
        dismissed={overlayDismissed}
        payload={successOverlayPayload}
        onDismiss={() => setOverlayDismissed(true)}
      />
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
