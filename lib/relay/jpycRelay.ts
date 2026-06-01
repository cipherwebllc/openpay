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

// submit 済 tx の最終状態。'pending' は「broadcast 済だが確定待ち」(timeout 等)。
// 重要: broadcast 後の不確定は 'error' ではなく 'pending' を返す。'error' は client を
// standard mode に fallback させるため、tx が後で確定すると二重支払いになる (Codex #4)。
export type RelayTaskOutcome =
  | { state: 'success'; txHash: Hex }
  | { state: 'reverted'; txHash?: Hex }
  | { state: 'pending'; txHash: Hex }
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
  // (任意) 日次グローバル予算 (circuit breaker)。Sybil が fresh EOA を量産して relayer の POL を
  // 枯渇させる griefing を、chain 日次の relay 件数上限で止める。true=予算内 (許可)。未提供なら
  // スキップ。fail-open (KV 障害は許可) — alpha は可用性優先、mainnet は fail-closed 寄りに要見直し。
  checkGasBudget?: (chainId: number) => Promise<boolean>;
  // (任意) authorization が既にチェーン上で使用済か (JPYC authorizationState)。true なら
  // submit せず pending を返す: guaranteed-revert を避けつつ、既に処理済かもしれない決済を
  // standard mode に fallback させない (二重支払い防止)。未提供ならスキップ。
  checkAuthorizationUsed?: (
    chainId: number,
    token: Address,
    from: Address,
    nonce: Hex,
  ) => Promise<boolean>;
  // (任意) 冪等性: 同一 (chainId,from,nonce) の先行 submit があれば 'duplicate'。重複 POST
  // (network retry / double-click) で二重 broadcast (gas 浪費) しないための最適化。'duplicate'
  // なら submit せず pending。fail-open: KV 不確定/未設定は 'first' (proceed)。資金の二重支払いは
  // on-chain _authorizationStates が最終防壁なので、ここは確定的重複のみ弾けば足りる。
  claimIdempotency?: (
    chainId: number,
    from: Address,
    nonce: Hex,
  ) => Promise<'first' | 'duplicate'>;
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
  // broadcast 済だが未確定 (確認待ち)。client は standard へ fallback してはならない
  // (二重支払い防止)。txHash があれば追跡可能、authorizationState 既使用時は無し。
  | { kind: 'pending'; txHash?: Hex }
  // pre-submit に弾いた (検証/残高/rate-limit)。httpStatus + 理由コード。
  | { kind: 'rejected'; httpStatus: number; reason: string }
  // submit "前" のエラー (検証通過後〜broadcast 前: 残高 race / RPC / 資金不足)。tx は
  // 出ていないので client は安全に fallback 可。broadcast 後は使わない (pending を使う)。
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

  // 5.4 日次グローバル予算 (Sybil circuit breaker)。超過なら submit せず reject。tx 未送信なので
  // client は standard へ安全に fallback できる (二重支払いリスク無し)。
  if (deps.checkGasBudget) {
    if (!(await deps.checkGasBudget(chainId))) {
      return { kind: 'rejected', httpStatus: 503, reason: 'daily_budget_exceeded' };
    }
  }

  // 5.5 authorization 既使用チェック (任意)。使用済なら submit は確実に revert する。
  // ここで pending を返すことで gas を浪費せず、かつ「既に処理済かもしれない決済」を
  // standard へ fallback させない (二重支払い防止)。
  if (deps.checkAuthorizationUsed) {
    const used = await deps.checkAuthorizationUsed(
      chainId,
      jpyc,
      auth.from,
      auth.nonce,
    );
    if (used) return { kind: 'pending' };
  }

  // 5.6 冪等性: 同一 authorization の重複 POST は再 broadcast せず pending (gas 浪費防止)。
  if (deps.claimIdempotency) {
    const claim = await deps.claimIdempotency(chainId, auth.from, auth.nonce);
    if (claim === 'duplicate') return { kind: 'pending' };
  }

  // 6. submit + poll。submit が throw = broadcast 前のエラー → relay_error (fallback 可)。
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

  // ここから先は broadcast 済。error は返さず success/reverted/pending のいずれか。
  const outcome = await deps.pollTask(taskId);
  if (outcome.state === 'success') {
    return { kind: 'success', txHash: outcome.txHash };
  }
  if (outcome.state === 'reverted') {
    return { kind: 'reverted', txHash: outcome.txHash };
  }
  if (outcome.state === 'pending') {
    return { kind: 'pending', txHash: outcome.txHash };
  }
  // poll 'error': provider 依存。Gelato は taskId が broadcast 前に返るので 'error'
  // (Cancelled/NotFound) = 未送信 → relay_error で fallback 可。self-host の pollReceipt は
  // broadcast 後なので 'error' を返さず 'pending' に倒す (二重支払い回避は poll 側の責務)。
  return { kind: 'relay_error', detail: outcome.detail };
}
