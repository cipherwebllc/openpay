// JPYC EIP-3009 relay のオーケストレーション (依存注入で I/O を外出しした純ロジック)。
// /api/relay/jpyc route が実依存 (viem balanceOf / Gelato REST fetch / KV rate-limit) を注入し、
// このコアが「検証 → 署名 recover==from → 残高 → rate-limit → submit → poll」を順に実行する。
// I/O を inject することで viem/fetch を mock せず unit test で全分岐を担保できる。
//
// 背景: memory:jpyc-eip3009 (Polygon は Gelato sponsoredCall、Kaia は自前 relayer)。

import { getAddress, type Address, type Hex } from 'viem';
import {
  encodeTransferWithAuthorizationCalldata,
  recoverTransferAuthorizationSigner,
  validateAuthorization,
  type Eip3009Authorization,
} from '@/lib/jpycEip3009';

export type RelayInput = {
  chainId: number;
  auth: Eip3009Authorization;
  signature: Hex;
  // rate-limit 用の識別子 (from は auth.from、ip は呼出元 IP prefix 等)。
  rateLimitKeys: string[];
};

// Gelato task の最終状態 (REST status の taskState を正規化)。
export type RelayTaskOutcome =
  | { state: 'success'; txHash: Hex }
  | { state: 'reverted'; txHash?: Hex }
  | { state: 'error'; detail: string };

export type RelayDeps = {
  nowSec: () => number;
  maxValue: bigint;
  // chainId → JPYC contract address。未対応 chain は null。
  jpycAddressFor: (chainId: number) => Address | null;
  // 残高照会 (viem balanceOf)。
  getBalance: (
    chainId: number,
    token: Address,
    owner: Address,
  ) => Promise<bigint>;
  // rate-limit。許可なら true。
  checkRateLimit: (keys: string[]) => Promise<boolean>;
  // Gelato sponsoredCall (REST)。taskId を返す。
  submitSponsoredCall: (
    chainId: number,
    target: Address,
    data: Hex,
  ) => Promise<{ taskId: string }>;
  // taskId を最終状態まで poll する (route 側で timeout/sleep を内包)。
  pollTask: (taskId: string) => Promise<RelayTaskOutcome>;
};

export type RelayResult =
  | { kind: 'success'; txHash: Hex }
  | { kind: 'reverted'; txHash?: Hex }
  // pre-submit に弾いた (検証/残高/rate-limit)。httpStatus + 理由コード。
  | { kind: 'rejected'; httpStatus: number; reason: string }
  // Gelato/relay 自体のエラー (cancelled/timeout 等)。client は fallback 可。
  | { kind: 'relay_error'; detail: string };

export async function relayJpycAuthorization(
  input: RelayInput,
  deps: RelayDeps,
): Promise<RelayResult> {
  const { chainId, auth, signature } = input;

  // 1. 対応 chain か (= JPYC address が解決できるか)。
  const jpyc = deps.jpycAddressFor(chainId);
  if (!jpyc) {
    return {
      kind: 'rejected',
      httpStatus: 400,
      reason: 'unsupported_chain',
    };
  }

  // 2. shape / 範囲検証 (value>0・期限・有効窓・上限・nonce 形式)。
  const v = validateAuthorization(auth, deps.nowSec(), {
    maxValue: deps.maxValue,
  });
  if (!v.ok) {
    return { kind: 'rejected', httpStatus: 400, reason: v.reason };
  }

  // 3. 署名 recover == from (無効署名で relay 枠を浪費しない)。
  let signer: Address;
  try {
    signer = await recoverTransferAuthorizationSigner(
      auth,
      chainId,
      jpyc,
      signature,
    );
  } catch {
    return { kind: 'rejected', httpStatus: 400, reason: 'signature_invalid' };
  }
  if (getAddress(signer) !== getAddress(auth.from)) {
    return { kind: 'rejected', httpStatus: 400, reason: 'signature_mismatch' };
  }

  // 4. 残高事前確認 (revert する tx を relay して枠を浪費しない)。
  const balance = await deps.getBalance(chainId, jpyc, auth.from);
  if (balance < auth.value) {
    return { kind: 'rejected', httpStatus: 400, reason: 'insufficient_balance' };
  }

  // 5. rate-limit (relayer は gas を払うので濫用/DoS の標的)。
  const allowed = await deps.checkRateLimit(input.rateLimitKeys);
  if (!allowed) {
    return { kind: 'rejected', httpStatus: 429, reason: 'rate_limited' };
  }

  // 6. submit + poll。
  const data = encodeTransferWithAuthorizationCalldata(auth, signature);
  let taskId: string;
  try {
    const submitted = await deps.submitSponsoredCall(chainId, jpyc, data);
    taskId = submitted.taskId;
  } catch (e) {
    return {
      kind: 'relay_error',
      detail: `submit_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const outcome = await deps.pollTask(taskId);
  if (outcome.state === 'success') {
    return { kind: 'success', txHash: outcome.txHash };
  }
  if (outcome.state === 'reverted') {
    return { kind: 'reverted', txHash: outcome.txHash };
  }
  return { kind: 'relay_error', detail: outcome.detail };
}
