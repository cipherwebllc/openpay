import {
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import type {
  GaslessGuardState,
  RelayGuardState,
  SubmitReadinessInput,
} from './types';

// /checkout (CheckoutForm) の送信可否 policy (R14)。CheckoutForm から式を変えずに移したもの。
// Pay / Tip と 1 つの述語にまとめない (意図的に異なる):
// - @handle 注文の admission 受付中 (orderAdmissionPending) は flowPending と canSubmit だけを閉じ、
//   paymentReady には含めない。onSubmit は admission の await 後に paymentReady (ref) を読み直して
//   stale な署名を止めるため、自分の受付中フラグで自分を止めない。
// - 同一店舗の未解決の支払い (relay.orderPaymentHold・A2c) は paymentReady ごと閉じる。
// - cross-chain / Arc の回復 scan は持たない (Checkout は対象外)。

export type CheckoutGuardInput = SubmitReadinessInput & {
  isStandard: boolean;
  useRelay: boolean;
  standard: {
    isRestoring: boolean;
    isPending: boolean;
    isUnknown: boolean;
    isFeeError: boolean;
    hasActiveIntent: boolean;
    data: unknown;
  };
  relay: RelayGuardState & { orderPaymentHold: boolean };
  gasless: GaslessGuardState;
  orderAdmissionPending: boolean;
  merchantUnderflow: boolean;
};

export function deriveCheckoutGuards({
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
}: CheckoutGuardInput) {
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
    !relay.orderPaymentHold &&
    gasQuoteReady &&
    !merchantUnderflow &&
    !settledNoRetry &&
    // gasless 経路のみ封鎖 (standard へ切り替えれば支払える)。
    !gaslessStoreUnavailable;
  const canSubmit = paymentReady && !orderAdmissionPending;
  return {
    relayAmbiguous,
    gaslessAmbiguous,
    gaslessStoreUnavailable,
    relayIpRateLimited,
    flowPending,
    gasQuoteReady,
    settledNoRetry,
    paymentReady,
    canSubmit,
  };
}
