// forwarder 経由の JPYC ガス回収 (recover モード) のオーケストレーション (依存注入)。
// 顧客が receiveWithAuthorization(to=forwarder, value=mv+fv, nonce=commit) に 1 署名 → server が
// 検証 (recover==from / feeValue==server権威額 / merchantValue>0 / total上限 / 残高 / rate-limit /
// authorizationState) → relayer が forwarder.settle を呼ぶ → poll。gas 相当額 (feeValue) を JPYC で
// 即時回収する (memory:gasless-legal-jp の「立替+回収」)。pending は broadcast 後の未確定で、
// client を standard へ fallback させない (二重支払い防止)。
//
// gasEquiv (feeValue) は server 権威の固定額 (開示バッファ)。client 値は信用せず一致を要求する
// (Codex review: client が feeValue=0 や任意 feeReceiver を要求するのを防ぐ)。
//
// 検証 (broadcast 前の純チェック) は verifyForwarderSettle に分離し、recover relay (recoverViaForwarder
// → /settle) と x402 facilitator (/verify) が **同一の検証実装** を共用する (money-path 検証の二重実装を
// 避ける)。broadcast 側 (rate-limit / authState / idempotency / budget / submit / poll) は
// recoverViaForwarder の責務。

import { getAddress, type Address, type Hex } from 'viem';
import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import {
  encodeSettleCalldata,
  recoverReceiveWithAuthorizationSigner,
} from '@/lib/relay/forwarderSettle';
import type { RelayResult, RelayTaskOutcome } from '@/lib/relay/jpycRelay';
import type {
  BudgetCheckResult,
  GasBudgetRefundToken,
  SubfloorBudgetRefundToken,
} from '@/lib/relay/relayGuards';

export type ForwarderRecoverInput = {
  chainId: number;
  params: ForwarderSettleParams;
  signature: Hex;
  rateLimitKeys: string[];
};

export type ForwarderRecoverDeps = {
  nowSec: () => number;
  // server 権威の gas 相当額 (固定の開示バッファ)。client 値は信用せず一致要求。
  expectedFeeValue: bigint;
  // total (merchantValue + feeValue) の上限。
  maxValue: bigint;
  // 署名有効窓の最大 (validBefore - now がこれを超える far-future を弾く)。
  maxValidityWindowSec: number;
  jpycAddressFor: (chainId: number) => Address | null;
  forwarderFor: (chainId: number) => Address | null;
  feeReceiverFor: (chainId: number) => Address | null;
  getBalance: (chainId: number, token: Address, owner: Address) => Promise<bigint>;
  checkRateLimit: (keys: string[]) => Promise<boolean>;
  // (任意) ガスフロア未満 settle 専用の払い元日次 limiter。署名検証・冪等性・通常 rate-limit
  // の後、共有日次予算より前で評価し、低回収 settle の濫用を通常 relay 枠へ波及させない。
  checkSubfloorPayerRateLimit?: (
    chainId: number,
    payer: Address,
  ) => Promise<boolean>;
  // (任意) ガスフロア未満 settle 専用の日次予算。既存 checkGasBudget と同じ
  // consumed/refundToken 契約だが counter は別名前空間。専用枠で止めた request は共有
  // relay:budget: を消費しない。
  checkSubfloorBudget?: (
    chainId: number,
  ) => Promise<BudgetCheckResult<SubfloorBudgetRefundToken>>;
  // (任意) 専用日次枠の refund。check が返した token を、tx 未 broadcast が確実な失敗でのみ渡す。
  refundSubfloorBudget?: (refundToken: SubfloorBudgetRefundToken) => Promise<void>;
  // (任意) 日次グローバル予算 (circuit breaker)。Sybil による relayer POL 枯渇 griefing を chain
  // 日次の relay 件数上限で止める。返り値:
  //   allowed  = 予算内で relay を許可するか (fail-open: KV 障害でも true)。
  //   consumed = カウンタを実際に INCR して 1 枠を消費したか (KV INCR 失敗の fail-open allow では
  //              false)。consumed=true なら、INCR した UTC 日付込み refundToken も返す。
  //              consumed=false の枠は refundGasBudget (DECR) してはならない (INCR していない枠を
  //              DECR するとカウンタが負に振れ余剰許容枠を与える・CDX-5)。fail-open (KV 障害は許可)。
  checkGasBudget?: (
    chainId: number,
  ) => Promise<BudgetCheckResult<GasBudgetRefundToken>>;
  // (任意) checkGasBudget で実際に消費した (consumed=true) 日次枠を 1 戻す。tx が 1 件も broadcast
  // されなかったことが確実な失敗 ((a) submit throw / (b) poll 'error') でのみ呼び、RPC 不安定日に
  // 正当決済が daily_budget_exceeded で 503 になるのを防ぐ。check が返した token でのみ呼ぶ。
  // jpycRelay (free 経路) の refundGasBudget 契約とセマンティクス完全一致 (fail-quiet・自分でログ)。
  refundGasBudget?: (refundToken: GasBudgetRefundToken) => Promise<void>;
  checkAuthorizationUsed?: (
    chainId: number,
    token: Address,
    from: Address,
    nonce: Hex,
  ) => Promise<boolean>;
  // (任意) 冪等性: 同一 (chainId,from,nonce) を 1 回だけ claim。'duplicate' なら再 broadcast せず
  // pending (記録済 txHash を同梱)。KV 設定済で応答不確定→duplicate(fail-safe)・未設定のみ first。
  // 最終防壁は on-chain _authorizationStates。
  claimIdempotency?: (
    chainId: number,
    from: Address,
    nonce: Hex,
  ) => Promise<{ status: 'first' } | { status: 'duplicate'; txHash: Hex | null }>;
  // (任意) broadcast 済 txHash を記録 (response-loss 後の重複 POST が explorer 追跡できるように)。
  recordRelayHash?: (
    chainId: number,
    from: Address,
    nonce: Hex,
    txHash: Hex,
  ) => Promise<void>;
  // (任意) claim 解放。broadcast 前の relay_error 時に呼び false tombstone を防ぐ。
  releaseIdempotency?: (chainId: number, from: Address, nonce: Hex) => Promise<void>;
  submit: (chainId: number, target: Address, data: Hex) => Promise<{ taskId: string }>;
  pollTask: (taskId: string) => Promise<RelayTaskOutcome>;
};

// verifyForwarderSettle が必要とする deps の部分集合 (broadcast/guard 系を含まない純検証用)。
// recover relay は full ForwarderRecoverDeps を渡し (= これを満たす)、x402 facilitator /verify は
// この軽量サブセットだけ組んで呼ぶ。
export type ForwarderVerifyDeps = Pick<
  ForwarderRecoverDeps,
  | 'nowSec'
  | 'expectedFeeValue'
  | 'maxValue'
  | 'maxValidityWindowSec'
  | 'jpycAddressFor'
  | 'forwarderFor'
  | 'feeReceiverFor'
  | 'getBalance'
>;

export type ForwarderVerifyResult =
  | { ok: false; result: RelayResult }
  | { ok: true; jpyc: Address; forwarder: Address; nonce: Hex };

const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

function rejected(httpStatus: number, reason: string): RelayResult {
  return { kind: 'rejected', httpStatus, reason };
}

// broadcast 前の **純検証** (server 権威 feeValue 照合 / 各種境界 / 署名 recover==from / 残高)。
// 副作用は getBalance / 署名 recover の read のみ (rate-limit / authState / idempotency / budget /
// broadcast は呼び元 = recoverViaForwarder の責務)。返り値: ok=false なら rejected RelayResult、
// ok=true なら解決済の jpyc/forwarder/nonce (broadcast 可)。
export async function verifyForwarderSettle(
  input: ForwarderRecoverInput,
  deps: ForwarderVerifyDeps,
): Promise<ForwarderVerifyResult> {
  const { chainId, params, signature } = input;

  const jpyc = deps.jpycAddressFor(chainId);
  const forwarder = deps.forwarderFor(chainId);
  const feeReceiver = deps.feeReceiverFor(chainId);
  if (!jpyc || !forwarder || !feeReceiver) {
    return { ok: false, result: rejected(400, 'unsupported_chain') };
  }

  // server 権威の値検証 (client を信用しない)。
  if (getAddress(params.feeReceiver) !== getAddress(feeReceiver)) {
    return { ok: false, result: rejected(400, 'fee_receiver_mismatch') };
  }
  if (params.feeValue !== deps.expectedFeeValue) {
    return { ok: false, result: rejected(400, 'fee_value_mismatch') };
  }
  // 防御層 (CDX-2): expectedFeeValue が 0 の構成 (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC=0 等の誤設定) は、
  // Eip3009Forwarder.settle が feeValue==0 で ZeroValue revert するため、broadcast すれば必ず revert
  // する tx を出して relayer の gas を捨てる (false flow)。submit 前に弾く。フロアは relayGasFeeValue が
  // 1 wei 以上を保証する (forwarderConfig) ため通常は到達しないが、二重に塞ぐ。
  if (deps.expectedFeeValue === 0n) {
    return { ok: false, result: rejected(400, 'fee_misconfigured') };
  }
  if (params.merchantValue <= 0n) {
    return { ok: false, result: rejected(400, 'invalid_merchant_value') };
  }
  if (getAddress(params.merchant) === ZERO_ADDRESS) {
    return { ok: false, result: rejected(400, 'zero_merchant') };
  }
  if (getAddress(params.merchant) === getAddress(feeReceiver)) {
    return { ok: false, result: rejected(400, 'merchant_is_fee_receiver') };
  }
  // merchant == forwarder は merchantValue を contract に閉じ込める (回収不能・Codex P2)。
  // 契約側にもガードがあるが、既 deploy 済 forwarder (Amoy) 保護 + defense-in-depth で server も弾く。
  if (getAddress(params.merchant) === getAddress(forwarder)) {
    return { ok: false, result: rejected(400, 'merchant_is_forwarder') };
  }
  if (params.intentSalt.toLowerCase() === ZERO_BYTES32) {
    return { ok: false, result: rejected(400, 'zero_salt') };
  }
  const total = params.merchantValue + params.feeValue;
  if (total > deps.maxValue) {
    return { ok: false, result: rejected(400, 'value_exceeds_max') };
  }

  // 期限・有効窓。
  const now = BigInt(deps.nowSec());
  if (params.validAfter > now) {
    return { ok: false, result: rejected(400, 'not_yet_valid') };
  }
  if (params.validBefore <= now) {
    return { ok: false, result: rejected(400, 'expired') };
  }
  if (params.validBefore - now > BigInt(deps.maxValidityWindowSec)) {
    return { ok: false, result: rejected(400, 'validity_too_far') };
  }

  // 署名 recover == from。
  let signer: Address;
  try {
    signer = await recoverReceiveWithAuthorizationSigner(
      params,
      chainId,
      jpyc,
      forwarder,
      signature,
    );
  } catch {
    return { ok: false, result: rejected(400, 'signature_invalid') };
  }
  if (getAddress(signer) !== getAddress(params.from)) {
    return { ok: false, result: rejected(400, 'signature_mismatch') };
  }

  // 残高照会は submit より前の read。RPC 例外を構造化して外側の redelivery owner が pending
  // claim を解放できるようにし、署名の有効期限より長い false tombstone へ波及するのを断つ。
  let balance: bigint;
  try {
    balance = await deps.getBalance(chainId, jpyc, params.from);
  } catch {
    return {
      ok: false,
      result: rejected(503, 'preflight_unavailable'),
    };
  }
  if (balance < total) {
    return { ok: false, result: rejected(400, 'insufficient_balance') };
  }

  // nonce (forwarder commitment = EIP-3009 nonce)。authState / idempotency が使う。
  const nonce = buildForwarderNonce(params, chainId, forwarder);
  return { ok: true, jpyc, forwarder, nonce };
}

export async function recoverViaForwarder(
  input: ForwarderRecoverInput,
  deps: ForwarderRecoverDeps,
): Promise<RelayResult> {
  // 純検証 (server 権威 feeValue 照合 / 境界 / 署名 / 残高) は共有 verifyForwarderSettle に委譲。
  const verified = await verifyForwarderSettle(input, deps);
  if (!verified.ok) return verified.result;
  const { jpyc, forwarder, nonce } = verified;
  const { chainId, params, signature } = input;

  // authorizationState 既使用 → pending (guaranteed-revert 回避 + 二重支払い防止)。
  // + 冪等性: 同一 authorization の重複 POST も pending (再 broadcast せず gas 浪費防止)。
  // nonce は両者共通 (forwarder commitment = EIP-3009 nonce)。
  if (deps.checkAuthorizationUsed) {
    try {
      if (await deps.checkAuthorizationUsed(chainId, jpyc, params.from, nonce)) {
        return { kind: 'pending' };
      }
    } catch {
      // idempotency claim / budget / submit のいずれよりも前の read だけを正規化する。ここで
      // structured reject にすることで redelivery marker を安全に解放し、RPC 復旧後の再試行を許す。
      return rejected(503, 'preflight_unavailable');
    }
  }
  let idemClaimed = false;
  if (deps.claimIdempotency) {
    const claim = await deps.claimIdempotency(chainId, params.from, nonce);
    if (claim.status === 'duplicate') {
      return { kind: 'pending', txHash: claim.txHash ?? undefined };
    }
    idemClaimed = true;
  }
  const releaseClaim = async () => {
    if (idemClaimed) await deps.releaseIdempotency?.(chainId, params.from, nonce);
  };
  const recordHash = async (txHash: Hex) => {
    if (idemClaimed) await deps.recordRelayHash?.(chainId, params.from, nonce, txHash);
  };

  // rate-limit (副作用: KV sliding-window)。重複ガードの後に置くことで retry / double-click の
  // 正当な重複 POST を pending で吸収し、rate-limit 枠を浪費しない。reject 時は claim を解放。
  if (!(await deps.checkRateLimit(input.rateLimitKeys))) {
    await releaseClaim();
    return rejected(429, 'rate_limited');
  }

  // ガスフロア未満 settle だけに配線される専用 payer limiter。署名済み params.from を鍵にし、
  // 同じ資金元からの低回収連打が専用日次枠と、その先の共有日次枠を枯らす波及を断つ。
  if (
    deps.checkSubfloorPayerRateLimit &&
    !(await deps.checkSubfloorPayerRateLimit(chainId, params.from))
  ) {
    await releaseClaim();
    return rejected(429, 'rate_limited');
  }

  // ガスフロア未満 settle 専用の日次予算。Sybil で payer limiter を迂回されても、この chain 単位
  // counter が共有 relay:budget: より先に止め、通常決済 / CSV パス / x402 への枯渇波及を断つ。
  let subfloorBudgetRefundToken: SubfloorBudgetRefundToken | null = null;
  if (deps.checkSubfloorBudget) {
    const budget = await deps.checkSubfloorBudget(chainId);
    if (!budget.allowed) {
      await releaseClaim();
      return rejected(503, 'daily_budget_exceeded');
    }
    subfloorBudgetRefundToken = budget.refundToken;
  }
  const refundSubfloor = async () => {
    if (subfloorBudgetRefundToken) {
      await deps.refundSubfloorBudget?.(subfloorBudgetRefundToken);
    }
  };

  // 日次グローバル予算 (Sybil circuit breaker)。重複/既使用ガードの後・submit 直前に置く
  // (replay/duplicate が予算枠を消費する DoS を防ぐ・Codex P1)。超過は submit せず reject。
  let gasBudgetRefundToken: GasBudgetRefundToken | null = null;
  if (deps.checkGasBudget) {
    const budget = await deps.checkGasBudget(chainId);
    if (!budget.allowed) {
      await releaseClaim();
      // 共有枠で止まり tx は未送信なので、先に消費した専用枠だけを戻す。
      await refundSubfloor();
      return rejected(503, 'daily_budget_exceeded');
    }
    // 実際に INCR した UTC 日付込み token だけを refund 対象にする。fail-open (token=null) や
    // 日跨ぎ後の再計算で別日の counter を DECR し、余剰枠を与える波及を断つ。
    gasBudgetRefundToken = budget.refundToken;
  }
  // tx が 1 件も broadcast されなかったことが確実な失敗でのみ予算枠を 1 戻す (RPC 不安定日に
  // 正当決済が daily_budget_exceeded で 503 になるのを防ぐ)。checkGasBudget を通過した場合のみ。
  // jpycRelay (free 経路) の refundBudget と同一セマンティクス。
  const refundBudget = async () => {
    if (gasBudgetRefundToken) {
      await deps.refundGasBudget?.(gasBudgetRefundToken);
    }
    await refundSubfloor();
  };

  // submit (relayer → forwarder.settle) + poll。submit が throw = broadcast 前 → relay_error。
  const data = encodeSettleCalldata(params, signature);
  let taskId: string;
  try {
    taskId = (await deps.submit(chainId, forwarder, data)).taskId;
  } catch (e) {
    await releaseClaim(); // broadcast 前失敗 → claim 解放
    await refundBudget(); // tx 未送信が確実 → 予算枠を戻す
    return {
      kind: 'relay_error',
      detail: `submit_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // broadcast 直後に hash を記録 (self-host は taskId=txHash)。poll 前に落ちても重複 POST が
  // explorer 追跡できる。Gelato (UUID) は除外。
  if (/^0x[0-9a-fA-F]{64}$/.test(taskId)) await recordHash(taskId as Hex);

  // broadcast 後は success/reverted/pending のみ (二重支払い回避は pollTask の責務)。
  const outcome = await deps.pollTask(taskId);
  if (outcome.state === 'success') {
    await recordHash(outcome.txHash);
    return { kind: 'success', txHash: outcome.txHash };
  }
  if (outcome.state === 'reverted') {
    if (outcome.txHash) await recordHash(outcome.txHash);
    return { kind: 'reverted', txHash: outcome.txHash };
  }
  if (outcome.state === 'pending') {
    if (outcome.txHash) await recordHash(outcome.txHash);
    return { kind: 'pending', txHash: outcome.txHash };
  }
  // poll 'error' = 未送信が確実な失敗のみ (timeout 等の不確定は pollTask で 'pending' に倒す)。
  // → relay_error で fallback 可 + claim 解放 + 予算枠を戻す (tx 未送信が確実なので消費した枠を回収)。
  await releaseClaim();
  await refundBudget();
  return { kind: 'relay_error', detail: outcome.detail };
}
