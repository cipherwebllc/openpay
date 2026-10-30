import { describe, it, expect, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { logger } from '@/lib/logger';
import {
  buildTransferWithAuthorizationTypedData,
  type Eip3009Authorization,
} from '@/lib/jpycEip3009';
import {
  relayJpycAuthorization,
  type RelayDeps,
  type RelayInput,
} from '@/lib/relay/jpycRelay';
import type {
  BudgetCheckResult,
  GasBudgetRefundToken,
} from '@/lib/relay/relayGuards';

const JPYC: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const CHAIN = 137;
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(PK);
const TO: Address = '0x000000000000000000000000000000000000dEaD';
const NOW = 1_800_000_000;
const GAS_BUDGET_TOKEN =
  'relay:budget:137:20260725' as GasBudgetRefundToken;

function gasBudget(
  allowed: boolean,
  consumed: boolean,
): BudgetCheckResult<GasBudgetRefundToken> {
  return consumed
    ? { allowed, consumed: true, refundToken: GAS_BUDGET_TOKEN }
    : { allowed, consumed: false, refundToken: null };
}

function makeAuth(over: Partial<Eip3009Authorization> = {}): Eip3009Authorization {
  return {
    from: account.address,
    to: TO,
    value: 1000n,
    validAfter: 0n,
    validBefore: BigInt(NOW + 60),
    nonce: `0x${'22'.repeat(32)}`,
    ...over,
  };
}

async function signAuth(auth: Eip3009Authorization): Promise<Hex> {
  const t = buildTransferWithAuthorizationTypedData(auth, CHAIN, JPYC);
  return account.signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  });
}

async function makeInput(
  authOver: Partial<Eip3009Authorization> = {},
): Promise<RelayInput> {
  const auth = makeAuth(authOver);
  return {
    chainId: CHAIN,
    auth,
    signature: await signAuth(auth),
    rateLimitKeys: [auth.from, '1.2.3.0/24'],
  };
}

function makeDeps(over: Partial<RelayDeps> = {}): RelayDeps {
  return {
    nowSec: () => NOW,
    maxValue: 10n ** 30n,
    jpycAddressFor: (c) => (c === CHAIN ? JPYC : null),
    getBalance: vi.fn(async () => 10_000n),
    checkRateLimit: vi.fn(async () => true),
    submitSponsoredCall: vi.fn(async () => ({ taskId: 'task-1' })),
    pollTask: vi.fn(async () => ({
      state: 'success' as const,
      txHash: `0x${'ab'.repeat(32)}` as Hex,
    })),
    ...over,
  };
}

describe('relayJpycAuthorization', () => {
  it('正常: 検証通過 → submit → poll success → {kind:success, txHash}', async () => {
    const deps = makeDeps();
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('success');
    if (res.kind === 'success') expect(res.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(deps.submitSponsoredCall).toHaveBeenCalledOnce();
    const [chainId, target] = (deps.submitSponsoredCall as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(chainId).toBe(CHAIN);
    expect(getAddress(target)).toBe(getAddress(JPYC));
  });

  it('未対応 chain → rejected unsupported_chain (submit せず)', async () => {
    const deps = makeDeps({ jpycAddressFor: () => null });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'unsupported_chain' });
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('範囲外 (value=0) → rejected (submit せず)', async () => {
    const deps = makeDeps();
    const input = await makeInput();
    // value=0 の auth に差し替え (署名も無効になるが validateAuthorization が先に弾く)
    const res = await relayJpycAuthorization(
      { ...input, auth: { ...input.auth, value: 0n } },
      deps,
    );
    expect(res.kind).toBe('rejected');
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('署名 mismatch (送信後に value 改竄) → rejected signature_mismatch', async () => {
    const deps = makeDeps();
    const input = await makeInput();
    // 署名は value=1000 に対して。auth.value を改竄 → recover が別アドレスに。
    const res = await relayJpycAuthorization(
      { ...input, auth: { ...input.auth, value: 2000n } },
      deps,
    );
    expect(res).toMatchObject({ kind: 'rejected', reason: 'signature_mismatch' });
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('残高不足 → rejected insufficient_balance (submit せず)', async () => {
    const deps = makeDeps({ getBalance: vi.fn(async () => 1n) });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({
      kind: 'rejected',
      reason: 'insufficient_balance',
    });
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  // B-R5: broadcast 前の on-chain read の RPC 例外は recover 経路と同じ構造化 503 に正規化し、
  // claim / rate-limit / 予算 / submit / poll のいずれにも進まない (release/refund も呼ばない)。
  it.each(['getBalance', 'checkAuthorizationUsed'] as const)(
    '%s の RPC 例外 → rejected 503 preflight_unavailable (claim/limit/budget/submit なし)',
    async (step) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const rpcError = new Error('rpc timeout');
      const rpcDown = async (): Promise<never> => {
        throw rpcError;
      };
      const deps = makeDeps({
        getBalance: step === 'getBalance' ? vi.fn(rpcDown) : vi.fn(async () => 10_000n),
        checkAuthorizationUsed:
          step === 'checkAuthorizationUsed' ? vi.fn(rpcDown) : vi.fn(async () => false),
        claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
        releaseIdempotency: vi.fn(async () => {}),
        recordRelayHash: vi.fn(async () => {}),
        checkGasBudget: vi.fn(async () => gasBudget(true, true)),
        refundGasBudget: vi.fn(async () => {}),
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res).toEqual({
        kind: 'rejected',
        httpStatus: 503,
        reason: 'preflight_unavailable',
      });
      expect(deps.getBalance).toHaveBeenCalledOnce();
      // 残高 read で止まった場合は既使用 read にも進まない。
      expect(deps.checkAuthorizationUsed).toHaveBeenCalledTimes(
        step === 'getBalance' ? 0 : 1,
      );
      expect(deps.claimIdempotency).not.toHaveBeenCalled();
      expect(deps.releaseIdempotency).not.toHaveBeenCalled();
      expect(deps.checkRateLimit).not.toHaveBeenCalled();
      expect(deps.checkGasBudget).not.toHaveBeenCalled();
      expect(deps.refundGasBudget).not.toHaveBeenCalled();
      expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
      expect(deps.pollTask).not.toHaveBeenCalled();
      expect(deps.recordRelayHash).not.toHaveBeenCalled();
      // 握った RPC 障害を運営が観測できる (例外は結果ではなく warn にだけ載せる)。
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('relay.jpyc.preflight_unavailable', {
        chainId: CHAIN,
        step: step === 'getBalance' ? 'balanceOf' : 'authorizationState',
        error: rpcError,
      });
      warn.mockRestore();
    },
  );

  it('rate-limit 超過 → rejected rate_limited (429)', async () => {
    const deps = makeDeps({ checkRateLimit: vi.fn(async () => false) });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({
      kind: 'rejected',
      reason: 'rate_limited',
      httpStatus: 429,
    });
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('rate-limit: duplicate claim は rate-limit を呼ばずに pending (枠を浪費しない)', async () => {
    const checkRateLimit = vi.fn(async () => true);
    const dupHash = `0x${'cd'.repeat(32)}` as Hex;
    const deps = makeDeps({
      checkRateLimit,
      claimIdempotency: vi.fn<
        (c: number, from: Address, nonce: Hex) => Promise<{ status: 'duplicate'; txHash: Hex }>
      >(async () => ({ status: 'duplicate', txHash: dupHash })),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'pending', txHash: dupHash });
    expect(checkRateLimit).toHaveBeenCalledTimes(0);
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('rate-limit: authorization 既使用は rate-limit を呼ばずに pending (枠を浪費しない)', async () => {
    const checkRateLimit = vi.fn(async () => true);
    const deps = makeDeps({
      checkRateLimit,
      checkAuthorizationUsed: vi.fn(async () => true),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('pending');
    expect(checkRateLimit).toHaveBeenCalledTimes(0);
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('rate-limit: claim first 後に rate-limit false → 429 + claim release (false tombstone 防止)', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const deps = makeDeps({
      checkRateLimit: vi.fn(async () => false),
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      releaseIdempotency,
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({
      kind: 'rejected',
      reason: 'rate_limited',
      httpStatus: 429,
    });
    expect(releaseIdempotency).toHaveBeenCalledOnce();
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('rate-limit: 正常系では rate-limit が claimIdempotency の後に呼ばれる', async () => {
    const checkRateLimit = vi.fn(async () => true);
    const claimIdempotency = vi.fn(async () => ({ status: 'first' as const }));
    const deps = makeDeps({ checkRateLimit, claimIdempotency });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(checkRateLimit).toHaveBeenCalledOnce();
    expect(claimIdempotency).toHaveBeenCalledOnce();
    const claimOrder = claimIdempotency.mock.invocationCallOrder[0];
    const rateOrder = checkRateLimit.mock.invocationCallOrder[0];
    expect(rateOrder).toBeGreaterThan(claimOrder);
  });

  it('submit 失敗 → relay_error', async () => {
    const deps = makeDeps({
      submitSponsoredCall: vi.fn(async () => {
        throw new Error('gelato 503');
      }),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('relay_error');
  });

  it('poll reverted → {kind:reverted}', async () => {
    const deps = makeDeps({
      pollTask: vi.fn(async () => ({ state: 'reverted' as const })),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('reverted');
  });

  it('poll pending (broadcast 済・未確定) → {kind:pending, txHash} (relay_error にしない)', async () => {
    const deps = makeDeps({
      pollTask: vi.fn(async () => ({
        state: 'pending' as const,
        txHash: `0x${'cd'.repeat(32)}` as Hex,
      })),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('pending');
    if (res.kind === 'pending') expect(res.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('authorizationState 既使用 → pending (submit せず・二重支払い防止)', async () => {
    const deps = makeDeps({
      checkAuthorizationUsed: vi.fn(async () => true),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('pending');
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('authorizationState 未使用 → 通常どおり submit → success', async () => {
    const deps = makeDeps({
      checkAuthorizationUsed: vi.fn(async () => false),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(deps.submitSponsoredCall).toHaveBeenCalledOnce();
  });

  it('B4: 日次予算超過 (checkGasBudget false) → rejected daily_budget_exceeded (submit せず)', async () => {
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => gasBudget(false, false)),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({
      kind: 'rejected',
      reason: 'daily_budget_exceeded',
      httpStatus: 503,
    });
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('B4: 予算内 (checkGasBudget true) → 通常どおり submit', async () => {
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => gasBudget(true, true)),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(deps.submitSponsoredCall).toHaveBeenCalledOnce();
  });

  it('B4: 予算チェックは重複ガードの後 (claim 済で予算超過 → release される・Codex P1)', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      checkGasBudget: vi.fn(async () => gasBudget(false, false)),
      releaseIdempotency,
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'daily_budget_exceeded' });
    expect(releaseIdempotency).toHaveBeenCalledOnce(); // false tombstone 防止
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('冪等性: duplicate → pending (記録済 txHash を同梱・submit せず)', async () => {
    const dupHash = `0x${'cd'.repeat(32)}` as Hex;
    const claimIdempotency = vi.fn<
      (c: number, from: Address, nonce: Hex) => Promise<{ status: 'duplicate'; txHash: Hex }>
    >(async () => ({ status: 'duplicate', txHash: dupHash }));
    const deps = makeDeps({ claimIdempotency });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'pending', txHash: dupHash });
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
    const [, from, nonce] = claimIdempotency.mock.calls[0];
    expect(getAddress(from)).toBe(getAddress(account.address));
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('冪等性: first → submit → success で recordRelayHash 記録', async () => {
    const recordRelayHash = vi.fn<
      (c: number, from: Address, nonce: Hex, txHash: Hex) => Promise<void>
    >(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      recordRelayHash,
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(deps.submitSponsoredCall).toHaveBeenCalledOnce();
    expect(recordRelayHash).toHaveBeenCalledOnce();
    const [, , , txHash] = recordRelayHash.mock.calls[0];
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('冪等性: submit throw (broadcast 前) → relay_error + claim release', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      releaseIdempotency,
      submitSponsoredCall: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('relay_error');
    expect(releaseIdempotency).toHaveBeenCalledOnce();
  });

  it('poll error (未送信確実: Cancelled) → relay_error + claim 解放', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      releaseIdempotency,
      pollTask: vi.fn(async () => ({
        state: 'error' as const,
        detail: 'Cancelled',
      })),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'relay_error' });
    expect(releaseIdempotency).toHaveBeenCalledOnce(); // 未送信確実なので解放してよい
  });

  it('poll pending (Gelato timeout・txHash 無し) → pending・claim 解放しない (fallback 禁止)', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      releaseIdempotency,
      pollTask: vi.fn(async () => ({ state: 'pending' as const })),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('pending'); // 不確定 → standard へ落とさない
    expect(releaseIdempotency).not.toHaveBeenCalled(); // 再 submit による二重送金を防ぐ
  });

  describe('refundGasBudget (未 broadcast 失敗の予算返却)', () => {
    it('submit throw (broadcast 前確実失敗) → refundGasBudget 1 回 (枠を戻す)', async () => {
      const refundGasBudget = vi.fn(async () => {});
      const deps = makeDeps({
        checkGasBudget: vi.fn(async () => gasBudget(true, true)),
        refundGasBudget,
        submitSponsoredCall: vi.fn(async () => {
          throw new Error('rpc down');
        }),
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res.kind).toBe('relay_error');
      expect(refundGasBudget).toHaveBeenCalledTimes(1);
      expect(refundGasBudget).toHaveBeenCalledWith(GAS_BUDGET_TOKEN);
    });

    it('poll error (未送信確実: Cancelled) → refundGasBudget 1 回', async () => {
      const refundGasBudget = vi.fn(async () => {});
      const deps = makeDeps({
        checkGasBudget: vi.fn(async () => gasBudget(true, true)),
        refundGasBudget,
        pollTask: vi.fn(async () => ({
          state: 'error' as const,
          detail: 'Cancelled',
        })),
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res.kind).toBe('relay_error');
      expect(refundGasBudget).toHaveBeenCalledTimes(1);
    });

    it('成功 → refundGasBudget 0 回 (枠を消費したまま)', async () => {
      const refundGasBudget = vi.fn(async () => {});
      const deps = makeDeps({
        checkGasBudget: vi.fn(async () => gasBudget(true, true)),
        refundGasBudget,
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res.kind).toBe('success');
      expect(refundGasBudget).not.toHaveBeenCalled();
    });

    it('reverted (broadcast 済) → refundGasBudget 0 回', async () => {
      const refundGasBudget = vi.fn(async () => {});
      const deps = makeDeps({
        checkGasBudget: vi.fn(async () => gasBudget(true, true)),
        refundGasBudget,
        pollTask: vi.fn(async () => ({ state: 'reverted' as const })),
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res.kind).toBe('reverted');
      expect(refundGasBudget).not.toHaveBeenCalled();
    });

    it('pending (broadcast 済・不確定) → refundGasBudget 0 回', async () => {
      const refundGasBudget = vi.fn(async () => {});
      const deps = makeDeps({
        checkGasBudget: vi.fn(async () => gasBudget(true, true)),
        refundGasBudget,
        pollTask: vi.fn(async () => ({ state: 'pending' as const })),
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res.kind).toBe('pending');
      expect(refundGasBudget).not.toHaveBeenCalled();
    });

    it('checkGasBudget 未通過 (deps 未提供) で submit throw → refundGasBudget 0 回', async () => {
      // checkGasBudget を提供しない = 枠を消費していない → refund もしない。
      const refundGasBudget = vi.fn(async () => {});
      const deps = makeDeps({
        refundGasBudget,
        submitSponsoredCall: vi.fn(async () => {
          throw new Error('rpc down');
        }),
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res.kind).toBe('relay_error');
      expect(refundGasBudget).not.toHaveBeenCalled();
    });

    // CDX-5: INCR 失敗の fail-open allow (allowed:true, consumed:false) は枠を消費していない。
    // 後で submit が throw しても refundGasBudget を呼んではならない (呼ぶと INCR していない
    // カウンタを DECR して負に振れ、cap 超過の余剰枠を与える)。
    it('INCR 失敗の fail-open allow (consumed:false) → relay は許可されるが、submit throw でも refund しない', async () => {
      const refundGasBudget = vi.fn(async () => {});
      const deps = makeDeps({
        checkGasBudget: vi.fn(async () => gasBudget(true, false)),
        refundGasBudget,
        submitSponsoredCall: vi.fn(async () => {
          throw new Error('rpc down');
        }),
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res.kind).toBe('relay_error'); // 許可された (= submit まで到達して throw)
      expect(deps.submitSponsoredCall).toHaveBeenCalledOnce();
      expect(refundGasBudget).not.toHaveBeenCalled(); // 消費していないので戻さない (負カウンタ防止)
    });

    // CDX-5: INCR 成功で cap 超過 (allowed:false) → submit せず reject。refund もしない (枠は取れていない)。
    it('INCR 成功・cap 超過 (allowed:false, consumed:true) → daily_budget_exceeded・submit せず・refund しない', async () => {
      const refundGasBudget = vi.fn(async () => {});
      const deps = makeDeps({
        checkGasBudget: vi.fn(async () => gasBudget(false, true)),
        refundGasBudget,
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res).toMatchObject({ kind: 'rejected', reason: 'daily_budget_exceeded' });
      expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
      expect(refundGasBudget).not.toHaveBeenCalled();
    });

    // CDX-5: INCR 成功で cap 内 (allowed:true, consumed:true) → 許可。submit throw で refund する (枠を戻す)。
    it('INCR 成功・cap 内 (consumed:true) で submit throw → refundGasBudget 1 回 (消費枠を戻す)', async () => {
      const refundGasBudget = vi.fn(async () => {});
      const deps = makeDeps({
        checkGasBudget: vi.fn(async () => gasBudget(true, true)),
        refundGasBudget,
        submitSponsoredCall: vi.fn(async () => {
          throw new Error('rpc down');
        }),
      });
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res.kind).toBe('relay_error');
      expect(refundGasBudget).toHaveBeenCalledTimes(1);
    });
  });
});

// 第 8 回レビュー A-01: relay の tx が revert しても、同じ authorization を別の tx (mempool の前走り等) が先に
// 実行していれば支払いは成立している。reverted は client に「新しい署名で払い直してよい」と伝える応答なので、
// 店宛ての経路 (readAuthorizationUsedAtRevert を渡す) では、revert のブロックに固定して「未使用」と読めたときだけ
// reverted を返し、使用済み・読めない・hash が無いときは pending (txHash なし) にする。渡さない経路 (受取人が
// OpenPay 自身の利用料・CSV パス) は従来どおり reverted。
describe('relayJpycAuthorization — revert 後の authorization 再確認 (A-01)', () => {
  const RELAY_TX = `0x${'ef'.repeat(32)}` as Hex;
  type ReadAtRevert = NonNullable<RelayDeps['readAuthorizationUsedAtRevert']>;

  // txHash: null = revert の hash が分からない (Gelato の ExecReverted 等)。
  function revertedDeps(
    readAuthorizationUsedAtRevert: ReadAtRevert | undefined,
    txHash: Hex | null = RELAY_TX,
  ) {
    const checkAuthorizationUsed = vi.fn(async () => false);
    const deps = makeDeps({
      checkAuthorizationUsed,
      ...(readAuthorizationUsedAtRevert ? { readAuthorizationUsedAtRevert } : {}),
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      releaseIdempotency: vi.fn(async () => {}),
      recordRelayHash: vi.fn(async () => {}),
      checkGasBudget: vi.fn(async () => gasBudget(true, true)),
      refundGasBudget: vi.fn(async () => {}),
      pollTask: vi.fn(async () => ({ state: 'reverted' as const, txHash: txHash ?? undefined })),
    });
    return { deps, checkAuthorizationUsed };
  }

  it('revert + 固定して使用済み → pending (txHash なし)・claim と予算はそのまま', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const readAtRevert = vi.fn<ReadAtRevert>(async () => true);
    const { deps } = revertedDeps(readAtRevert);
    const input = await makeInput();
    const res = await relayJpycAuthorization(input, deps);

    expect(res).toEqual({ kind: 'pending' });
    // 再確認は poll (revert の確定) の後に、revert した tx の hash を渡して読む (receipt のブロックに固定するため)。
    expect(readAtRevert).toHaveBeenCalledExactlyOnceWith(CHAIN, JPYC, input.auth.from, input.auth.nonce, RELAY_TX);
    expect(readAtRevert.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(deps.pollTask).mock.invocationCallOrder[0],
    );
    expect(deps.submitSponsoredCall).toHaveBeenCalledOnce();
    // broadcast 済みの結果なので claim の解放・予算の返却はしない (従来の reverted と同じ)。
    expect(deps.releaseIdempotency).not.toHaveBeenCalled();
    expect(deps.refundGasBudget).not.toHaveBeenCalled();
    expect(deps.recordRelayHash).toHaveBeenCalledWith(CHAIN, input.auth.from, input.auth.nonce, RELAY_TX);
    // 運営が追えるよう revert した relay の tx を warn に残す (応答には付けない)。
    expect(warn).toHaveBeenCalledWith('relay.jpyc.reverted_authorization_used', {
      chainId: CHAIN,
      txHash: RELAY_TX,
    });
    warn.mockRestore();
  });

  it('revert + 固定して未使用 → 従来どおり reverted (txHash つき)', async () => {
    const readAtRevert = vi.fn<ReadAtRevert>(async () => false);
    const { deps } = revertedDeps(readAtRevert);
    const res = await relayJpycAuthorization(await makeInput(), deps);

    expect(res).toEqual({ kind: 'reverted', txHash: RELAY_TX });
    expect(readAtRevert).toHaveBeenCalledOnce();
    expect(deps.releaseIdempotency).not.toHaveBeenCalled();
    expect(deps.refundGasBudget).not.toHaveBeenCalled();
  });

  it('revert + 固定して読めない (読み取り失敗) → pending (分からないは払い直してよいではない)・warn に残す', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const rpcError = new Error('header not found');
    const { deps } = revertedDeps(vi.fn<ReadAtRevert>(async () => {
      throw rpcError;
    }));
    const res = await relayJpycAuthorization(await makeInput(), deps);

    expect(res).toEqual({ kind: 'pending' });
    expect(deps.releaseIdempotency).not.toHaveBeenCalled();
    expect(deps.refundGasBudget).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('relay.jpyc.revert_recheck_unavailable', {
      chainId: CHAIN,
      txHash: RELAY_TX,
      error: rpcError,
    });
    warn.mockRestore();
  });

  it('revert の hash が無い (固定できない) → 読まずに pending・warn に残す', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const readAtRevert = vi.fn<ReadAtRevert>(async () => false);
    const { deps } = revertedDeps(readAtRevert, null);
    const res = await relayJpycAuthorization(await makeInput(), deps);

    expect(res).toEqual({ kind: 'pending' });
    expect(readAtRevert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('relay.jpyc.revert_recheck_unavailable', {
      chainId: CHAIN,
      reason: 'no_tx_hash',
    });
    warn.mockRestore();
  });

  it('readAuthorizationUsedAtRevert を渡さない経路 (受取人が OpenPay 自身) は従来どおり reverted・読み直さない', async () => {
    for (const txHash of [RELAY_TX, null]) {
      const { deps, checkAuthorizationUsed } = revertedDeps(undefined, txHash);
      const res = await relayJpycAuthorization(await makeInput(), deps);
      expect(res).toEqual({ kind: 'reverted', txHash: txHash ?? undefined });
      // 送信前の既使用チェックの 1 回だけ (revert 後に読み直さない)。
      expect(checkAuthorizationUsed).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ['success', { state: 'success' as const, txHash: RELAY_TX }],
    ['pending', { state: 'pending' as const, txHash: RELAY_TX }],
    ['error', { state: 'error' as const, detail: 'Cancelled' }],
  ])('poll が %s のときは再確認しない', async (_label, outcome) => {
    const readAtRevert = vi.fn<ReadAtRevert>(async () => true);
    const deps = makeDeps({ readAuthorizationUsedAtRevert: readAtRevert, pollTask: vi.fn(async () => outcome) });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe(outcome.state === 'error' ? 'relay_error' : outcome.state);
    expect(readAtRevert).not.toHaveBeenCalled();
  });
});
