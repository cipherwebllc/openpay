// recover (forwarder.settle) の検証 + broadcast オーケストレーションを両 route で共有する層。
// relayFreeAuthorization (free 経路の共有・relayProvider.ts) の **recover 版**。決済 relay
// (app/api/relay/jpyc handleRecover) と x402 facilitator (/api/facilitator/settle) が共通で使う。
// 呼び元が差し替えるのは:
//   - expectedFeeValue : 料率モデル (recover=recoverFeeValue/mobileOrderFeeValue / x402=x402FeeValue)
//   - callerFeeFloorValue : sub-floor 判定基準 (recover/mobile=relay gas floor / x402=x402 fee floor)
//   - forwarderFor     : a1-aware (recover relay = jpycForwarderFor) か raw (facilitator =
//                        configuredJpycForwarderFor) か
//   - idemPrefix       : 冪等名前空間 ('relay:idem:' / 'x402fac:idem:')
// 検証本体 (server 権威 feeValue 照合 / 署名 recover / 残高 / nonce 未使用 / 冪等 / 予算 / submit+poll) は
// 既存の recoverViaForwarder を不変のまま再利用する。verifyForwarderHealth で submit 前に forwarder を
// 肯定的に検証する。
//
// **挙動不変**: 決済 route の既存テストが無改変で green であることが受け入れ条件。self-host 前提
// (recover は forwarder.settle を自前 EOA で submit する) は呼び元 route が PROVIDER==='self-host' で保証する。

import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  MAX_VALUE,
  RELAY_LOW_BALANCE_ALERT_WEI,
  relayMaxGasCostWei,
  jpycAddressFor,
  getBalance,
  readAuthorizationUsed,
  selfHostIoFor,
} from './relayProvider';
import { submitSelfHost, pollSelfHost } from './selfHostRelayer';
import {
  checkRateLimit,
  checkSubfloorPayerRateLimit,
  checkSubfloorBudget,
  refundSubfloorBudget,
  checkGasBudget,
  refundGasBudget,
  makeRecoverIdempotency,
} from './relayGuards';
import { recoverViaForwarder, type ForwarderRecoverDeps } from './forwarderRecover';
import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from './forwarderIntent';
import { verifyForwarderHealth } from './forwarderHealth';
import type { RelayResult } from './jpycRelay';

// 署名有効窓の最大 (validBefore - now がこれを超える far-future を弾く)。両 route 共通。
export const MAX_VALIDITY_WINDOW_SEC = 20 * 60;

// 回収先 (= OpenPay fee receiver)。forwarder の immutable feeReceiver と一致必須 (health check で照合)。
// 両 route + handleFree (isFeePayment 判定) の単一情報源。
export function feeReceiverFor(_chainId: number): Address | null {
  return isAddress(env.feeReceiver) ? getAddress(env.feeReceiver) : null;
}

export type SettleViaForwarderInput = {
  chainId: number;
  // feeReceiver は呼び元が server 権威でセット済 (= feeReceiverFor(chainId))。
  params: ForwarderSettleParams;
  signature: Hex;
  rateLimitKeys: string[];
  // 料率モデルを呼び元が注入 (recoverViaForwarder が feeValue===expectedFeeValue を強制する)。
  expectedFeeValue: bigint;
  // 呼び元の料金体系における正規 floor。recover/mobile は relay gas floor、x402 は x402 fee floor。
  callerFeeFloorValue: bigint;
  // a1-aware (recover relay) か raw (facilitator) かを呼び元が選ぶ。
  forwarderFor: (chainId: number) => Address | null;
  // route 別の冪等名前空間 ('relay:idem:' / 'x402fac:idem:')。rate-limit / 日次予算は relayGuards 内で
  // 共有キー。recover の入口跨ぎ共有 claim (relay:recover:idem:) は makeRecoverIdempotency が重ねる。
  idemPrefix: string;
};

export async function settleViaForwarder(
  input: SettleViaForwarderInput,
): Promise<RelayResult> {
  const {
    chainId,
    params,
    signature,
    rateLimitKeys,
    expectedFeeValue,
    callerFeeFloorValue,
    forwarderFor,
    idemPrefix,
  } = input;

  const jpyc = jpycAddressFor(chainId);
  const forwarder = forwarderFor(chainId);
  const feeReceiver = feeReceiverFor(chainId);

  // submit 前に forwarder を on-chain で **肯定的に** 検証する (EOA/別 token/別 feeReceiver の no-op
  // SUCCESS を排除)。検証成功 (null) のときだけ submit へ進み、無効 or 検証不能 (非 null) は 503
  // relay_not_configured に倒す (client が standard へ綺麗にフォールバック)。RPC flake 中の検証不能は
  // キャッシュされないので RPC 回復後に自動で recover へ戻る (verifyForwarderHealth の説明参照)。
  if (jpyc && forwarder && feeReceiver) {
    const invalid = await verifyForwarderHealth(chainId, forwarder, jpyc, feeReceiver);
    if (invalid) {
      return { kind: 'rejected', httpStatus: 503, reason: 'relay_not_configured' };
    }
  }

  const io = selfHostIoFor(chainId);
  // A7: route 別 claim (idemPrefix・従来) に加え、入口非依存の共有 claim を重ねる。recover の
  // nonce は決定論的コミットメントなので、決済 relay と x402 facilitator の両入口へ同じ
  // authorization を並行 POST しても broadcast は 1 本に収束する (2 本目は従来の重複と同じ
  // pending 応答で返る = wire に新しいエラーコードを足さない)。
  const { claimIdempotency, recordRelayHash, releaseIdempotency } =
    makeRecoverIdempotency(idemPrefix);
  // server 権威で算出済みの回収額を、同じ caller の料金体系に属する floor と比較する。recover 用
  // gas floor を x402 に流用して正規小口 x402 が専用 cap を枯らし、他 payer の settle を止める
  // 波及を断つ。mobile/recover 側は従来どおり relay gas floor を caller から渡す。
  const isSubfloorSettle = expectedFeeValue < callerFeeFloorValue;

  // collision/fatal 時の authState 再確認用 (P0/P1)。recover の nonce は commitment nonce。
  const isAuthorizationUsed =
    jpyc && forwarder
      ? () =>
          readAuthorizationUsed(
            chainId,
            jpyc,
            params.from,
            buildForwarderNonce(params, chainId, forwarder),
          )
      : undefined;

  const deps: ForwarderRecoverDeps = {
    nowSec: () => Math.floor(Date.now() / 1000),
    expectedFeeValue,
    maxValue: MAX_VALUE,
    maxValidityWindowSec: MAX_VALIDITY_WINDOW_SEC,
    jpycAddressFor,
    forwarderFor,
    feeReceiverFor,
    getBalance,
    checkRateLimit,
    // sub-floor でない既存 settle には依存自体を渡さず、従来の制御フローを保つ。
    ...(isSubfloorSettle
      ? {
          checkSubfloorPayerRateLimit,
          checkSubfloorBudget,
          refundSubfloorBudget,
        }
      : {}),
    // refund (未 broadcast 失敗の予算返却) を配線。tx が 1 件も broadcast されなかったことが確実な
    // 失敗 (submit throw / poll 'error') でのみ DECR で 1 戻す (RPC 不安定日の誤 503 を防ぐ)。fail-quiet。
    checkGasBudget,
    refundGasBudget,
    checkAuthorizationUsed: readAuthorizationUsed,
    claimIdempotency,
    recordRelayHash,
    releaseIdempotency,
    submit: (_c, target, data) =>
      submitSelfHost(io, target, data, {
        maxGasCostWei: relayMaxGasCostWei(chainId),
        isAuthorizationUsed,
        lowBalanceWei: RELAY_LOW_BALANCE_ALERT_WEI,
        onLowBalance: (b) =>
          logger.warn('relay.relayer.balance_low', {
            chainId,
            balanceWei: b.toString(),
          }),
      }),
    pollTask: (taskId) => pollSelfHost(io, taskId),
  };

  return recoverViaForwarder(
    { chainId, params, signature, rateLimitKeys },
    deps,
  );
}
