import {
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import type {
  GaslessGuardState,
  RelayGuardState,
  SubmitReadinessInput,
} from './types';

// /pay (PaymentForm) の送信可否 policy (R14)。PaymentForm から式を変えずに移したもの。
// Checkout / Tip と 1 つの述語にまとめない (意図的に異なる):
// - relay / gasless の曖昧応答・復元中・IP 制限の封鎖を current route と独立に全経路へ効かせる
//   (preflight の切替と競合して route が変わっても二重払いへ波及させない)。
// - 動的 QR の FX 期限 (expired / 時刻計測前) で送信を止める (Pay だけ)。
// - cross-chain 実行中/完了と Arc の回復 scan 完了前は直接送金を止める。

export type PayGuardInput = SubmitReadinessInput & {
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
  relay: RelayGuardState;
  gasless: GaslessGuardState;
  crossChainLocked: boolean;
  crossChainResult: unknown;
  params: { token: string; chain?: string; expiresAt?: number };
  address: string | undefined;
  arcScannedScope: string;
  arcRecoveryScope: string;
  merchantUnderflow: boolean;
  expired: boolean;
  timeMeasured: boolean;
};

export function derivePayGuards({
  isStandard,
  useRelay,
  standard,
  relay,
  gasless,
  crossChainLocked,
  crossChainResult,
  params,
  address,
  arcScannedScope,
  arcRecoveryScope,
  activeQuote,
  isConnected,
  wrongChain,
  saData,
  breakdown,
  insufficientBalance,
  merchantUnderflow,
  expired,
  timeMeasured,
}: PayGuardInput) {
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
  // Arc の mount scan 完了前に直接送金が開始される波及を断つ (dynamic child の読込中も)。
  const arcRecoveryScanning = params.token === 'usdc' && params.chain === 'arc' && !!address && arcScannedScope !== arcRecoveryScope;
  const flowPending = directFlowPending || crossChainLocked || arcRecoveryScanning;
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
  const settledNoRetry = directSettledNoRetry || !!crossChainResult;

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
  return {
    relayAmbiguous,
    gaslessAmbiguous,
    gaslessStoreUnavailable,
    relayIpRateLimited,
    directFlowPending,
    flowPending,
    gasQuoteReady,
    directSettledNoRetry,
    settledNoRetry,
    canSubmit,
  };
}
