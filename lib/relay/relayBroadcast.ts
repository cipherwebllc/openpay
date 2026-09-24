// Post-preflight broadcast sequence shared by free relay and forwarder recovery.
// Claims and refund tokens belong to this invocation; preflight policy stays with each caller.
import type { Address, Hex } from 'viem';
import type {
  BudgetCheckResult,
  GasBudgetRefundToken,
  SubfloorBudgetRefundToken,
} from './relayGuards';
import type { RelayResult, RelayTaskOutcome } from './relayTypes';

type RelayBroadcastInput = {
  chainId: number;
  from: Address;
  nonce: Hex;
  rateLimitKeys: string[];
  encodeCalldata: () => Hex;
  submit: (data: Hex) => Promise<{ taskId: string }>;
};

type RelayBroadcastDeps = {
  checkRateLimit: (keys: string[]) => Promise<boolean>;
  claimIdempotency?: (
    chainId: number,
    from: Address,
    nonce: Hex,
  ) => Promise<{ status: 'first' } | { status: 'duplicate'; txHash: Hex | null }>;
  releaseIdempotency?: (chainId: number, from: Address, nonce: Hex) => Promise<void>;
  recordRelayHash?: (chainId: number, from: Address, nonce: Hex, txHash: Hex) => Promise<void>;
  checkGasBudget?: (chainId: number) => Promise<BudgetCheckResult<GasBudgetRefundToken>>;
  refundGasBudget?: (refundToken: GasBudgetRefundToken) => Promise<void>;
  pollTask: (taskId: string) => Promise<RelayTaskOutcome>;
};

type RelaySubfloorDeps = {
  checkSubfloorPayerRateLimit?: (chainId: number, payer: Address) => Promise<boolean>;
  checkSubfloorBudget?: (chainId: number) => Promise<BudgetCheckResult<SubfloorBudgetRefundToken>>;
  refundSubfloorBudget?: (refundToken: SubfloorBudgetRefundToken) => Promise<void>;
};

function rejected(httpStatus: number, reason: string): RelayResult {
  return { kind: 'rejected', httpStatus, reason };
}

export async function relayBroadcast(
  input: RelayBroadcastInput,
  deps: RelayBroadcastDeps,
  // Only recover opts into these guards, using its original dependency object.
  subfloor?: RelaySubfloorDeps,
): Promise<RelayResult> {
  const { chainId, from, nonce } = input;
  let idemClaimed = false;
  if (deps.claimIdempotency) {
    const claim = await deps.claimIdempotency(chainId, from, nonce);
    if (claim.status === 'duplicate') {
      return { kind: 'pending', txHash: claim.txHash ?? undefined };
    }
    idemClaimed = true;
  }
  const releaseClaim = async () => {
    if (idemClaimed) await deps.releaseIdempotency?.(chainId, from, nonce);
  };
  const recordHash = async (txHash: Hex) => {
    if (idemClaimed) await deps.recordRelayHash?.(chainId, from, nonce, txHash);
  };

  // rate-limit (副作用: KV sliding-window・relayer は gas を払うので濫用/DoS の標的)。重複ガードの後に
  // 置くことで retry / double-click の正当な重複 POST を pending で吸収し、rate-limit 枠を浪費しない
  // (浪費すると broadcast 済の決済に 429 が返り「失敗」に見える)。日次予算より前に置き、rate-limit
  // される actor が予算枠を消費しないようにする。reject 時は claim を解放 (false tombstone 防止)。
  if (!(await deps.checkRateLimit(input.rateLimitKeys))) {
    await releaseClaim();
    return rejected(429, 'rate_limited');
  }

  // ガスフロア未満 settle だけに配線される専用 payer limiter。署名済み from を鍵にし、
  // 同じ資金元からの低回収連打が専用日次枠と、その先の共有日次枠を枯らす波及を断つ。
  if (
    subfloor?.checkSubfloorPayerRateLimit &&
    !(await subfloor.checkSubfloorPayerRateLimit(chainId, from))
  ) {
    await releaseClaim();
    return rejected(429, 'rate_limited');
  }

  // ガスフロア未満 settle 専用の日次予算。Sybil で payer limiter を迂回されても、この chain 単位
  // counter が共有 relay:budget: より先に止め、通常決済 / CSV パス / x402 への枯渇波及を断つ。
  let subfloorBudgetRefundToken: SubfloorBudgetRefundToken | null = null;
  if (subfloor?.checkSubfloorBudget) {
    const budget = await subfloor.checkSubfloorBudget(chainId);
    if (!budget.allowed) {
      await releaseClaim();
      return rejected(503, 'daily_budget_exceeded');
    }
    subfloorBudgetRefundToken = budget.refundToken;
  }
  const refundSubfloor = async () => {
    if (subfloorBudgetRefundToken) {
      await subfloor?.refundSubfloorBudget?.(subfloorBudgetRefundToken);
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
      if (subfloor) await refundSubfloor();
      return rejected(503, 'daily_budget_exceeded');
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
    if (subfloor) await refundSubfloor();
  };

  // Encoding stays after budget acquisition and outside the submission catch.
  // Only submission failures release/refund here; encoding exceptions still propagate.
  const data = input.encodeCalldata();
  let taskId: string;
  try {
    taskId = (await input.submit(data)).taskId;
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
