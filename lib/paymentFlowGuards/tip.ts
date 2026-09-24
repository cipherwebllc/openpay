import {
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import type {
  GaslessGuardState,
  RelayGuardState,
  SubmitReadinessInput,
} from './types';

// /tip (TipForm) の送信可否 policy (R14)。TipForm から式を変えずに移したもの。
// Pay / Checkout と 1 つの述語にまとめない (意図的に異なる):
// - relay の復元中・曖昧応答だけは current route と独立に封鎖し (同一タブの sessionStorage 復元)、
//   standard / gasless の ambiguity・復元ロックは選択中の route に限る。
// - 復元された standard 成功 (このフォームの送信でないもの) は次のチップを妨げない。
// - standard (Arc) は dynamic import の engine 到達 (standardReady) を待ち、preview では送らない。
//   standard の状態は TipStandardEngine から受け取る形だけに依存する (engine を import しない)。

export type TipGuardInput = SubmitReadinessInput & {
  isStandard: boolean;
  useRelay: boolean;
  standard: {
    isRestoring: boolean;
    isPending: boolean;
    isUnknown: boolean;
    isFeeError: boolean;
    isSuccess: boolean;
    hasActiveIntent: boolean;
  };
  relay: RelayGuardState;
  gasless: GaslessGuardState;
  ownsStandardAttempt: boolean;
  crossChainLocked: boolean;
  crossChainResult: unknown;
  params: { token: string; chain?: string };
  address: string | undefined;
  preview: boolean;
  arcScannedScope: string;
  arcRecoveryScope: string;
  standardReady: boolean;
};

export function deriveTipGuards({
  isStandard,
  useRelay,
  standard,
  relay,
  gasless,
  ownsStandardAttempt,
  crossChainLocked,
  crossChainResult,
  params,
  address,
  preview,
  arcScannedScope,
  arcRecoveryScope,
  activeQuote,
  isConnected,
  wrongChain,
  saData,
  standardReady,
  breakdown,
  insufficientBalance,
}: TipGuardInput) {
  const relayResponseUnknown = isRelayResponseUnknownError(relay.error);
  const relayAmbiguous = relay.recoveryState != null || relayResponseUnknown;
  // Pimlico は broadcast 後の receipt 取得失敗を relay と同じ unknown として保持する。
  // latch 中は新しい UserOperation ではなく、保持済み hash の receipt 再照会だけを許可する。
  const gaslessAmbiguous = !isStandard && !useRelay && gasless.isUnknown;
  // pending record store (localStorage) が読めず未解決 UserOp の有無を判定できない状態。
  // broadcast 済みとは言い切れないので ambiguous とは別扱いにし、gasless 経路だけを塞ぐ
  // (relay は localStorage に依存しないため、この fail-closed を波及させない)。
  const gaslessStoreUnavailable = !isStandard && !useRelay && gasless.pendingStoreUnavailable;
  const relayIpRateLimited = isRelayIpRateLimitedError(relay.error)
    ? relay.error
    : null;
  // relay intent は sessionStorage に保存され、同一タブの TipForm で復元される。
  // 別タブ・NativeTipForm は対象外。方法切替で未解決の送金が二重払いへ波及しないよう、
  // 復元中・曖昧応答の封鎖を current route から独立させる。
  const directFlowPending = relay.isRestoring || relayAmbiguous
    ? true
    : isStandard
      ? standard.isRestoring || standard.isPending || standard.isUnknown
      : useRelay
        ? relay.isPending
        : gasless.isPending || gaslessAmbiguous;
  const arcRecoveryScanning = params.token === 'usdc' && params.chain === 'arc' && !!address && !preview && arcScannedScope !== arcRecoveryScope;
  const flowPending = directFlowPending || crossChainLocked || arcRecoveryScanning;

  // relay は gas quote / smart account 不要なので readiness 即満たす。circle は permitAmount を含む
  // activeQuote(circleQuote) 確定まで待つ (未算定で送信すると useBatchPayment が throw)。
  const gasQuoteReady = isStandard || useRelay || activeQuote.data !== undefined;
  // 送金が確定 (または broadcast 済で確定しうる) 後の再送信を禁止。再送すると同一受取人へ
  // 2 件目の on-chain 送金 = 二重支払いになる。revert (送金未成立) は安全なので再試行を許す
  // 復元された standard 成功は今回のチップではないため、新規送信を妨げない。
  const directSettledNoRetry =
    relayAmbiguous || relay.hasActiveIntent ||
    (isStandard && (standard.hasActiveIntent || standard.isUnknown || standard.isFeeError || (ownsStandardAttempt && standard.isSuccess))) ||
    (!isStandard && !useRelay && (gaslessAmbiguous || !!gasless.data?.success)) ||
    (useRelay &&
      (!!relayIpRateLimited ||
        (!!relay.data && (relay.data.success || !!relay.data.pending))));
  const settledNoRetry = directSettledNoRetry || !!crossChainResult;

  const canSubmit =
    !preview &&
    isConnected &&
    !wrongChain &&
    (isStandard ? standardReady : useRelay || !!saData) &&
    // creator 受取 > 0 を要求 (custom amount 未入力だと gas 分で customerPays が
    // 正になり得るが、tip 額 0 の空 batch は無意味)。hook 側でも calls.length===0
    // を弾くが、UI でも button を無効化して金額入力を促す。
    breakdown.merchantReceives > 0n &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !flowPending &&
    gasQuoteReady &&
    !settledNoRetry &&
    // gasless 経路のみ封鎖 (relay へ切り替えれば支払える)。
    !gaslessStoreUnavailable;
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
