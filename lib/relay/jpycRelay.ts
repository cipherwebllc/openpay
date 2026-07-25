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
import type {
  BudgetCheckResult,
  GasBudgetRefundToken,
} from '@/lib/relay/relayGuards';

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
  // broadcast 済 or broadcast 不確定 (Gelato timeout 等)。txHash は分かれば同梱・無ければ省略。
  | { state: 'pending'; txHash?: Hex }
  // broadcast されなかったことが確実な失敗のみ (Gelato Cancelled/Blacklisted/NotFound)。
  // client は standard へ fallback 可。timeout 等の不確定は 'pending' を使うこと。
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
  // 枯渇させる griefing を、chain 日次の relay 件数上限で止める。返り値:
  //   allowed  = 予算内で relay を許可するか (fail-open: KV 障害でも true)。
  //   consumed = カウンタを実際に INCR して 1 枠を消費したか (KV INCR 失敗の fail-open allow では
  //              false)。consumed=true なら、INCR した UTC 日付込み refundToken も返す。
  //              consumed=false の枠は後で refundGasBudget (DECR) してはならない — INCR していない
  //              枠を DECR するとカウンタが負に振れて余剰許容枠を与えてしまう (CDX-5)。
  // 未提供ならスキップ。alpha は可用性優先、mainnet は fail-closed 寄りに要見直し。
  checkGasBudget?: (
    chainId: number,
  ) => Promise<BudgetCheckResult<GasBudgetRefundToken>>;
  // (任意) checkGasBudget で実際に消費した (consumed=true) 日次枠を 1 戻す。tx が 1 件も broadcast
  // されなかったことが確実な失敗 ((a) submit throw / (b) poll 'error') でのみ呼び、RPC 不安定日に
  // 正当決済が daily_budget_exceeded で 503 になるのを防ぐ。check が返した token でのみ呼ぶ。
  refundGasBudget?: (refundToken: GasBudgetRefundToken) => Promise<void>;
  // (任意) authorization が既にチェーン上で使用済か (JPYC authorizationState)。true なら
  // submit せず pending を返す: guaranteed-revert を避けつつ、既に処理済かもしれない決済を
  // standard mode に fallback させない (二重支払い防止)。未提供ならスキップ。
  checkAuthorizationUsed?: (
    chainId: number,
    token: Address,
    from: Address,
    nonce: Hex,
  ) => Promise<boolean>;
  // (任意) 冪等性: 同一 (chainId,from,nonce) を 1 回だけ claim。重複 POST (network retry /
  // double-click) で二重 broadcast しないための保護。'duplicate' なら submit せず pending を返す
  // (txHash が記録済なら explorer 追跡用に同梱)。KV 設定済で応答不確定なら duplicate に倒す
  // (fail-safe)・KV 未設定のみ first。最終防壁は on-chain _authorizationStates。
  claimIdempotency?: (
    chainId: number,
    from: Address,
    nonce: Hex,
  ) => Promise<{ status: 'first' } | { status: 'duplicate'; txHash: Hex | null }>;
  // (任意) claim 済 authorization に broadcast 済 txHash を記録 (response-loss 後の重複 POST が
  // explorer で追跡できるように)。success/reverted/pending で hash が判れば呼ぶ。
  recordRelayHash?: (
    chainId: number,
    from: Address,
    nonce: Hex,
    txHash: Hex,
  ) => Promise<void>;
  // (任意) claim を解放。broadcast "前" の失敗 (relay_error) 時に呼び、正当な再試行を idem TTL
  // (30分) 待たせない (false tombstone 防止)。tx は出ていないので解放は安全。
  releaseIdempotency?: (
    chainId: number,
    from: Address,
    nonce: Hex,
  ) => Promise<void>;
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

  // 5.6 冪等性: 同一 authorization の重複 POST は再 broadcast せず pending (記録済 hash を同梱)。
  let idemClaimed = false;
  if (deps.claimIdempotency) {
    const claim = await deps.claimIdempotency(chainId, auth.from, auth.nonce);
    if (claim.status === 'duplicate') {
      return { kind: 'pending', txHash: claim.txHash ?? undefined };
    }
    idemClaimed = true;
  }
  const releaseClaim = async () => {
    if (idemClaimed) await deps.releaseIdempotency?.(chainId, auth.from, auth.nonce);
  };
  const recordHash = async (txHash: Hex) => {
    if (idemClaimed) {
      await deps.recordRelayHash?.(chainId, auth.from, auth.nonce, txHash);
    }
  };

  // 5.65 rate-limit (relayer は gas を払うので濫用/DoS の標的)。重複ガード (5.5/5.6) の後に
  // 置く: network retry / double-click の正当な重複 POST は pending で吸収され rate-limit 枠を
  // 浪費しない (枠を浪費すると broadcast 済の決済に 429 が返り「失敗」に見える)。グローバル
  // 日次予算 (5.7) より前に置き、rate-limit される actor が予算枠を消費しないようにする。
  // reject 時は claim を解放 (false tombstone 防止・5.7 と同じ)。
  const allowed = await deps.checkRateLimit(input.rateLimitKeys);
  if (!allowed) {
    await releaseClaim();
    return { kind: 'rejected', httpStatus: 429, reason: 'rate_limited' };
  }

  // 5.7 日次グローバル予算 (Sybil circuit breaker)。重複/既使用ガードの後・submit 直前に置く
  // (replay/duplicate が予算枠を消費して正当な決済を枯渇させる DoS を防ぐ・Codex P1)。超過は
  // submit せず reject (tx 未送信 → standard へ安全に fallback)。claim 済なら解放 (false tombstone 防止)。
  let gasBudgetRefundToken: GasBudgetRefundToken | null = null;
  if (deps.checkGasBudget) {
    const budget = await deps.checkGasBudget(chainId);
    if (!budget.allowed) {
      await releaseClaim();
      return { kind: 'rejected', httpStatus: 503, reason: 'daily_budget_exceeded' };
    }
    // 実際に INCR した UTC 日付込み token だけを refund 対象にする。fail-open (token=null) や
    // 日跨ぎ後の再計算で別日の counter を DECR し、余剰枠を与える波及を断つ。
    gasBudgetRefundToken = budget.refundToken;
  }
  // tx が 1 件も broadcast されなかったことが確実な失敗でのみ予算枠を 1 戻す (RPC 不安定日に
  // 正当決済が daily_budget_exceeded で 503 になるのを防ぐ)。checkGasBudget を通過した場合のみ。
  const refundBudget = async () => {
    if (gasBudgetRefundToken) {
      await deps.refundGasBudget?.(gasBudgetRefundToken);
    }
  };

  // 6. submit + poll。submit が throw = broadcast 前のエラー → relay_error (fallback 可)。
  const data = encodeTransferWithAuthorizationCalldata(auth, signature);
  let taskId: string;
  try {
    const submitted = await deps.submitSponsoredCall(chainId, jpyc, data);
    taskId = submitted.taskId;
  } catch (e) {
    await releaseClaim(); // broadcast 前失敗 → claim 解放 (正当な再試行を待たせない)
    await refundBudget(); // tx 未送信が確実 → 予算枠を戻す
    return {
      kind: 'relay_error',
      detail: `submit_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // broadcast 直後に hash を記録 (self-host は taskId=txHash)。poll 前に worker が落ちても重複
  // POST が explorer 追跡できる。Gelato の taskId は UUID なので txHash 形のみ記録する。
  if (/^0x[0-9a-fA-F]{64}$/.test(taskId)) await recordHash(taskId as Hex);

  // ここから先は broadcast 済。error は返さず success/reverted/pending のいずれか。
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
  // poll 'error' = broadcast されなかったことが確実な失敗のみ (Gelato Cancelled/Blacklisted/
  // NotFound)。timeout 等の不確定は pollTask 側で 'pending' に倒す約束なのでここには来ない。
  // よって未送信が確実 → relay_error で fallback 可 + claim 解放 (正当な再試行を待たせない)
  // + 予算枠を戻す (tx 未送信が確実なので消費した枠を回収)。
  await releaseClaim();
  await refundBudget();
  return { kind: 'relay_error', detail: outcome.detail };
}
