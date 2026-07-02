import { describe, it, expect, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import {
  recoverViaForwarder,
  type ForwarderRecoverDeps,
  type ForwarderRecoverInput,
} from '@/lib/relay/forwarderRecover';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(PK);
const JPYC: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const FORWARDER: Address = '0x4444444444444444444444444444444444444444';
const FEE_RECEIVER: Address = '0x3333333333333333333333333333333333333333';
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CHAIN = 80002;
const NOW = 1_800_000_000;
const FEE = 2n * 10n ** 18n;

function makeParams(
  over: Partial<ForwarderSettleParams> = {},
): ForwarderSettleParams {
  return {
    from: account.address,
    merchant: MERCHANT,
    merchantValue: 1000n * 10n ** 18n,
    feeReceiver: FEE_RECEIVER,
    feeValue: FEE,
    validAfter: 0n,
    validBefore: BigInt(NOW + 60),
    intentSalt: `0x${'22'.repeat(32)}`,
    ...over,
  };
}

async function sign(params: ForwarderSettleParams): Promise<Hex> {
  const t = buildReceiveWithAuthorizationTypedData(params, CHAIN, JPYC, FORWARDER);
  return account.signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  });
}

async function makeInput(
  over: Partial<ForwarderSettleParams> = {},
): Promise<ForwarderRecoverInput> {
  const params = makeParams(over);
  return {
    chainId: CHAIN,
    params,
    signature: await sign(params),
    rateLimitKeys: [params.from, '1.2.3.0/24'],
  };
}

function makeDeps(
  over: Partial<ForwarderRecoverDeps> = {},
): ForwarderRecoverDeps {
  return {
    nowSec: () => NOW,
    expectedFeeValue: FEE,
    maxValue: 10n ** 30n,
    maxValidityWindowSec: 20 * 60,
    jpycAddressFor: (c) => (c === CHAIN ? JPYC : null),
    forwarderFor: (c) => (c === CHAIN ? FORWARDER : null),
    feeReceiverFor: (c) => (c === CHAIN ? FEE_RECEIVER : null),
    getBalance: vi.fn(async () => 10_000n * 10n ** 18n),
    checkRateLimit: vi.fn(async () => true),
    submit: vi.fn(async () => ({ taskId: '0xtask' })),
    pollTask: vi.fn(async () => ({
      state: 'success' as const,
      txHash: `0x${'ab'.repeat(32)}` as Hex,
    })),
    ...over,
  };
}

describe('recoverViaForwarder', () => {
  it('正常: 検証通過 → forwarder.settle submit → success', async () => {
    const deps = makeDeps();
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(deps.submit).toHaveBeenCalledOnce();
    const [chainId, target] = (deps.submit as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(chainId).toBe(CHAIN);
    expect(getAddress(target)).toBe(getAddress(FORWARDER));
  });

  it('未対応 chain (forwarder 未 deploy) → rejected unsupported_chain', async () => {
    const deps = makeDeps({ forwarderFor: () => null });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'unsupported_chain' });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('feeValue が server 権威額と不一致 → rejected fee_value_mismatch (submit せず)', async () => {
    const deps = makeDeps();
    const res = await recoverViaForwarder(await makeInput({ feeValue: FEE + 1n }), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'fee_value_mismatch' });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  // CDX-2: expectedFeeValue=0 (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC=0 等の誤設定) は、Eip3009Forwarder.settle が
  // feeValue==0 で ZeroValue revert する guaranteed-revert。submit 前に fee_misconfigured で弾く
  // (feeValue も 0 で一致させ fee_value_mismatch を回避し、fv=0 ガードに到達することを確認)。
  it('expectedFeeValue=0 (誤設定) → rejected fee_misconfigured (submit せず・guaranteed-revert 回避)', async () => {
    const deps = makeDeps({ expectedFeeValue: 0n });
    const res = await recoverViaForwarder(await makeInput({ feeValue: 0n }), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'fee_misconfigured' });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('feeReceiver が config と不一致 → rejected fee_receiver_mismatch', async () => {
    const deps = makeDeps();
    const res = await recoverViaForwarder(
      await makeInput({ feeReceiver: '0x9999999999999999999999999999999999999999' }),
      deps,
    );
    expect(res).toMatchObject({ kind: 'rejected', reason: 'fee_receiver_mismatch' });
  });

  it('merchant == feeReceiver → rejected', async () => {
    const deps = makeDeps();
    const res = await recoverViaForwarder(await makeInput({ merchant: FEE_RECEIVER }), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'merchant_is_fee_receiver' });
  });

  it('merchant == address(0) → rejected zero_merchant', async () => {
    const deps = makeDeps();
    const res = await recoverViaForwarder(
      await makeInput({ merchant: '0x0000000000000000000000000000000000000000' }),
      deps,
    );
    expect(res).toMatchObject({ kind: 'rejected', reason: 'zero_merchant' });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('merchant == forwarder → rejected (Codex P2・資金閉じ込め防止)', async () => {
    const deps = makeDeps();
    const res = await recoverViaForwarder(await makeInput({ merchant: FORWARDER }), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'merchant_is_forwarder' });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('intentSalt=0 → rejected zero_salt', async () => {
    const deps = makeDeps();
    const res = await recoverViaForwarder(
      await makeInput({ intentSalt: `0x${'00'.repeat(32)}` }),
      deps,
    );
    expect(res).toMatchObject({ kind: 'rejected', reason: 'zero_salt' });
  });

  it('署名 mismatch (送信後に merchantValue 改竄) → rejected signature_mismatch', async () => {
    const deps = makeDeps();
    const input = await makeInput();
    // 署名は merchantValue=1000 に対して。改竄すると recover が別 nonce → 別署名者に。
    const res = await recoverViaForwarder(
      { ...input, params: { ...input.params, merchantValue: 900n * 10n ** 18n } },
      deps,
    );
    expect(res).toMatchObject({ kind: 'rejected', reason: 'signature_mismatch' });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('残高不足 → rejected insufficient_balance', async () => {
    const deps = makeDeps({ getBalance: vi.fn(async () => 1n) });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'insufficient_balance' });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('期限切れ (validBefore <= now) → rejected expired', async () => {
    const deps = makeDeps();
    const res = await recoverViaForwarder(
      await makeInput({ validBefore: BigInt(NOW - 1) }),
      deps,
    );
    expect(res).toMatchObject({ kind: 'rejected', reason: 'expired' });
  });

  it('rate-limit 超過 → rejected rate_limited (429)', async () => {
    const deps = makeDeps({ checkRateLimit: vi.fn(async () => false) });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'rate_limited', httpStatus: 429 });
  });

  it('rate-limit 超過は claim 後に判定され、429 では claim を release する', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      checkRateLimit: vi.fn(async () => false),
      checkGasBudget: vi.fn(async () => ({ allowed: true, consumed: true })),
      releaseIdempotency,
      refundGasBudget,
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'rate_limited', httpStatus: 429 });
    expect(deps.claimIdempotency).toHaveBeenCalledOnce();
    expect(releaseIdempotency).toHaveBeenCalledOnce();
    expect(deps.checkGasBudget).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(refundGasBudget).not.toHaveBeenCalled();
  });

  it('authorizationState 既使用 → pending (submit せず・二重支払い防止)', async () => {
    const deps = makeDeps({
      checkAuthorizationUsed: vi.fn(async () => true),
      checkRateLimit: vi.fn(async () => false),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('pending');
    expect(deps.checkRateLimit).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('B4: 日次予算超過 (checkGasBudget false) → rejected daily_budget_exceeded (submit せず)', async () => {
    const deps = makeDeps({ checkGasBudget: vi.fn(async () => ({ allowed: false, consumed: false })) });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res).toMatchObject({
      kind: 'rejected',
      reason: 'daily_budget_exceeded',
      httpStatus: 503,
    });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('B4: 予算内 (checkGasBudget true) → 通常どおり submit', async () => {
    const deps = makeDeps({ checkGasBudget: vi.fn(async () => ({ allowed: true, consumed: true })) });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(deps.submit).toHaveBeenCalledOnce();
  });

  it('B4: 予算チェックは重複ガードの後 (claim 済で予算超過 → release・Codex P1)', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      checkGasBudget: vi.fn(async () => ({ allowed: false, consumed: false })),
      releaseIdempotency,
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'daily_budget_exceeded' });
    expect(releaseIdempotency).toHaveBeenCalledOnce();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('冪等性: duplicate → pending (記録済 txHash を同梱・submit せず)', async () => {
    const dupHash = `0x${'ef'.repeat(32)}` as Hex;
    const claimIdempotency = vi.fn<
      (c: number, from: Address, nonce: Hex) => Promise<{ status: 'duplicate'; txHash: Hex }>
    >(async () => ({ status: 'duplicate', txHash: dupHash }));
    const deps = makeDeps({ claimIdempotency });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'pending', txHash: dupHash });
    expect(deps.checkRateLimit).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    const [, from, nonce] = claimIdempotency.mock.calls[0];
    expect(getAddress(from)).toBe(getAddress(account.address));
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('冪等性: first → submit → success で recordRelayHash 記録', async () => {
    const recordRelayHash = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      recordRelayHash,
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(deps.submit).toHaveBeenCalledOnce();
    expect(recordRelayHash).toHaveBeenCalledOnce();
  });

  it('冪等性: submit throw (broadcast 前) → relay_error + claim release', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      releaseIdempotency,
      submit: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('relay_error');
    expect(releaseIdempotency).toHaveBeenCalledOnce();
  });

  it('poll reverted → reverted', async () => {
    const deps = makeDeps({
      pollTask: vi.fn(async () => ({ state: 'reverted' as const })),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('reverted');
  });

  it('poll pending (broadcast 後未確定) → pending', async () => {
    const deps = makeDeps({
      pollTask: vi.fn(async () => ({
        state: 'pending' as const,
        txHash: `0x${'cd'.repeat(32)}` as Hex,
      })),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('pending');
  });

  it('submit 失敗 (broadcast 前) → relay_error', async () => {
    const deps = makeDeps({
      submit: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('relay_error');
  });
});

// L3: recover 経路の日次予算 refund 配線 (free 経路 jpycRelay と同一セマンティクス)。
// refund は tx が 1 件も broadcast されなかったことが確実な失敗 ((a) submit throw → relay_error /
// (b) poll 'error' terminal → relay_error) でのみ呼び、checkGasBudget を通過した場合に限る。
// pending/reverted/success では呼ばない (broadcast 済の可能性があり枠を戻すのは不正)。
describe('recoverViaForwarder — 日次予算 refund 配線 (L3)', () => {
  it('submit throw (予算消費後) → refundGasBudget が 1 回だけ呼ばれる', async () => {
    const checkGasBudget = vi.fn(async () => ({ allowed: true, consumed: true }));
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      checkGasBudget,
      refundGasBudget,
      submit: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('relay_error');
    expect(checkGasBudget).toHaveBeenCalledOnce();
    expect(refundGasBudget).toHaveBeenCalledOnce();
    expect(refundGasBudget).toHaveBeenCalledWith(CHAIN);
  });

  it("poll 'error' terminal (予算消費後) → refundGasBudget が 1 回だけ呼ばれる", async () => {
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => ({ allowed: true, consumed: true })),
      refundGasBudget,
      pollTask: vi.fn(async () => ({ state: 'error' as const, detail: 'Cancelled' })),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('relay_error');
    expect(refundGasBudget).toHaveBeenCalledOnce();
  });

  it('success → refundGasBudget は呼ばれない (broadcast 済・枠は消費したまま)', async () => {
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => ({ allowed: true, consumed: true })),
      refundGasBudget,
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(refundGasBudget).not.toHaveBeenCalled();
  });

  it('reverted (broadcast 済) → refundGasBudget は呼ばれない', async () => {
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => ({ allowed: true, consumed: true })),
      refundGasBudget,
      pollTask: vi.fn(async () => ({ state: 'reverted' as const })),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('reverted');
    expect(refundGasBudget).not.toHaveBeenCalled();
  });

  it('pending (broadcast 後未確定) → refundGasBudget は呼ばれない (二重支払い防止)', async () => {
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => ({ allowed: true, consumed: true })),
      refundGasBudget,
      pollTask: vi.fn(async () => ({
        state: 'pending' as const,
        txHash: `0x${'cd'.repeat(32)}` as Hex,
      })),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('pending');
    expect(refundGasBudget).not.toHaveBeenCalled();
  });

  it('checkGasBudget 未提供 (枠未消費) で submit throw → refundGasBudget は呼ばれない', async () => {
    const refundGasBudget = vi.fn(async () => {});
    // checkGasBudget を渡さない (= gasBudgetConsumed=false)。refund は提供されていても呼ばれない。
    const deps = makeDeps({
      refundGasBudget,
      submit: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('relay_error');
    expect(refundGasBudget).not.toHaveBeenCalled();
  });

  it('予算超過 (checkGasBudget false・未消費) → refundGasBudget は呼ばれない (枠を取れていない)', async () => {
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => ({ allowed: false, consumed: false })),
      refundGasBudget,
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'daily_budget_exceeded' });
    expect(refundGasBudget).not.toHaveBeenCalled();
  });

  // CDX-5: INCR 失敗の fail-open allow (allowed:true, consumed:false) は枠を消費していない。
  // submit が throw しても refundGasBudget を呼んではならない (INCR していないカウンタを DECR すると
  // 負に振れ cap 超過の余剰枠を与える)。recover 経路も free 経路と同一セマンティクス。
  it('INCR 失敗の fail-open allow (consumed:false) → 許可されるが submit throw でも refund しない', async () => {
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => ({ allowed: true, consumed: false })),
      refundGasBudget,
      submit: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('relay_error'); // 許可された (submit まで到達して throw)
    expect(deps.submit).toHaveBeenCalledOnce();
    expect(refundGasBudget).not.toHaveBeenCalled();
  });

  // CDX-5: INCR 成功で cap 超過 (allowed:false, consumed:true) → submit せず reject・refund しない。
  it('INCR 成功・cap 超過 (allowed:false, consumed:true) → daily_budget_exceeded・submit せず・refund しない', async () => {
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => ({ allowed: false, consumed: true })),
      refundGasBudget,
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'rejected', reason: 'daily_budget_exceeded' });
    expect(deps.submit).not.toHaveBeenCalled();
    expect(refundGasBudget).not.toHaveBeenCalled();
  });

  // CDX-5: INCR 成功で cap 内 (consumed:true) で submit throw → refund する (消費枠を戻す)。
  it('INCR 成功・cap 内 (consumed:true) で submit throw → refundGasBudget 1 回', async () => {
    const refundGasBudget = vi.fn(async () => {});
    const deps = makeDeps({
      checkGasBudget: vi.fn(async () => ({ allowed: true, consumed: true })),
      refundGasBudget,
      submit: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('relay_error');
    expect(refundGasBudget).toHaveBeenCalledTimes(1);
  });
});
