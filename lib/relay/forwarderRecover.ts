// forwarder 経由の JPYC ガス回収 (recover モード) のオーケストレーション (依存注入)。
// 顧客が receiveWithAuthorization(to=forwarder, value=mv+fv, nonce=commit) に 1 署名 → server が
// 検証 (recover==from / feeValue==server権威額 / merchantValue>0 / total上限 / 残高 / rate-limit /
// authorizationState) → relayer が forwarder.settle を呼ぶ → poll。gas 相当額 (feeValue) を JPYC で
// 即時回収する (memory:gasless-legal-jp の「立替+回収」)。pending は broadcast 後の未確定で、
// client を standard へ fallback させない (二重支払い防止)。
//
// gasEquiv (feeValue) は server 権威の固定額 (開示バッファ)。client 値は信用せず一致を要求する
// (Codex review: client が feeValue=0 や任意 feeReceiver を要求するのを防ぐ)。

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
  // (任意) 日次グローバル予算 (circuit breaker)。Sybil による relayer POL 枯渇 griefing を chain
  // 日次の relay 件数上限で止める。true=予算内 (許可)。fail-open (KV 障害は許可)。
  checkGasBudget?: (chainId: number) => Promise<boolean>;
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

const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex;

function rejected(httpStatus: number, reason: string): RelayResult {
  return { kind: 'rejected', httpStatus, reason };
}

export async function recoverViaForwarder(
  input: ForwarderRecoverInput,
  deps: ForwarderRecoverDeps,
): Promise<RelayResult> {
  const { chainId, params, signature } = input;

  const jpyc = deps.jpycAddressFor(chainId);
  const forwarder = deps.forwarderFor(chainId);
  const feeReceiver = deps.feeReceiverFor(chainId);
  if (!jpyc || !forwarder || !feeReceiver) {
    return rejected(400, 'unsupported_chain');
  }

  // server 権威の値検証 (client を信用しない)。
  if (getAddress(params.feeReceiver) !== getAddress(feeReceiver)) {
    return rejected(400, 'fee_receiver_mismatch');
  }
  if (params.feeValue !== deps.expectedFeeValue) {
    return rejected(400, 'fee_value_mismatch');
  }
  if (params.merchantValue <= 0n) return rejected(400, 'invalid_merchant_value');
  if (getAddress(params.merchant) === getAddress(feeReceiver)) {
    return rejected(400, 'merchant_is_fee_receiver');
  }
  // merchant == forwarder は merchantValue を contract に閉じ込める (回収不能・Codex P2)。
  // 契約側にもガードがあるが、既 deploy 済 forwarder (Amoy) 保護 + defense-in-depth で server も弾く。
  if (getAddress(params.merchant) === getAddress(forwarder)) {
    return rejected(400, 'merchant_is_forwarder');
  }
  if (params.intentSalt.toLowerCase() === ZERO_BYTES32) {
    return rejected(400, 'zero_salt');
  }
  const total = params.merchantValue + params.feeValue;
  if (total > deps.maxValue) return rejected(400, 'value_exceeds_max');

  // 期限・有効窓。
  const now = BigInt(deps.nowSec());
  if (params.validAfter > now) return rejected(400, 'not_yet_valid');
  if (params.validBefore <= now) return rejected(400, 'expired');
  if (params.validBefore - now > BigInt(deps.maxValidityWindowSec)) {
    return rejected(400, 'validity_too_far');
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
    return rejected(400, 'signature_invalid');
  }
  if (getAddress(signer) !== getAddress(params.from)) {
    return rejected(400, 'signature_mismatch');
  }

  // 残高 ≥ total (revert する tx を relay しない)。
  const balance = await deps.getBalance(chainId, jpyc, params.from);
  if (balance < total) return rejected(400, 'insufficient_balance');

  // rate-limit。
  if (!(await deps.checkRateLimit(input.rateLimitKeys))) {
    return rejected(429, 'rate_limited');
  }

  // authorizationState 既使用 → pending (guaranteed-revert 回避 + 二重支払い防止)。
  // + 冪等性: 同一 authorization の重複 POST も pending (再 broadcast せず gas 浪費防止)。
  // nonce は両者共通 (forwarder commitment = EIP-3009 nonce)。
  const nonce = buildForwarderNonce(params, chainId, forwarder);
  if (deps.checkAuthorizationUsed) {
    if (await deps.checkAuthorizationUsed(chainId, jpyc, params.from, nonce)) {
      return { kind: 'pending' };
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

  // 日次グローバル予算 (Sybil circuit breaker)。重複/既使用ガードの後・submit 直前に置く
  // (replay/duplicate が予算枠を消費する DoS を防ぐ・Codex P1)。超過は submit せず reject。
  if (deps.checkGasBudget) {
    if (!(await deps.checkGasBudget(chainId))) {
      await releaseClaim();
      return rejected(503, 'daily_budget_exceeded');
    }
  }

  // submit (relayer → forwarder.settle) + poll。submit が throw = broadcast 前 → relay_error。
  const data = encodeSettleCalldata(params, signature);
  let taskId: string;
  try {
    taskId = (await deps.submit(chainId, forwarder, data)).taskId;
  } catch (e) {
    await releaseClaim(); // broadcast 前失敗 → claim 解放
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
  // → relay_error で fallback 可 + claim 解放。
  await releaseClaim();
  return { kind: 'relay_error', detail: outcome.detail };
}
