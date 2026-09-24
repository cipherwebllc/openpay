import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as authorization from '@/lib/jpycEip3009';
import * as settle from '@/lib/relay/forwarderSettle';
import { buildForwarderNonce, buildReceiveWithAuthorizationTypedData } from '@/lib/relay/forwarderIntent';
import { relayJpycAuthorization, type RelayDeps, type RelayTaskOutcome } from '@/lib/relay/jpycRelay';
import { recoverViaForwarder, type ForwarderRecoverDeps } from '@/lib/relay/forwarderRecover';
import type { GasBudgetRefundToken, SubfloorBudgetRefundToken } from '@/lib/relay/relayGuards';

// Characterization through the existing public entry points, added before R5 extraction.
// Real signatures and encoders keep validation, calldata and the lazy encoding boundary in scope.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const CHAIN = 80002;
const NOW = 1_800_000_000;
const JPYC: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const FORWARDER: Address = '0x4444444444444444444444444444444444444444';
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const FEE_RECEIVER: Address = '0x3333333333333333333333333333333333333333';
const HASH: Hex = `0x${'ab'.repeat(32)}`;
const FINAL_HASH: Hex = `0x${'cd'.repeat(32)}`;
const encodeTransfer = authorization.encodeTransferWithAuthorizationCalldata;
const encodeSettle = settle.encodeSettleCalldata;
type Rail = 'free' | 'recover';
type Trace = { events: string[]; fail?: string; error: Error };
let encodingTraces: WeakMap<object, Trace>;

function visit(trace: Trace, step: string) {
  trace.events.push(step);
  if (trace.fail === step) throw trace.error;
}

beforeEach(() => {
  encodingTraces = new WeakMap();
  vi.spyOn(authorization, 'encodeTransferWithAuthorizationCalldata').mockImplementation((auth, signature) => {
    visit(encodingTraces.get(auth)!, 'encode');
    return encodeTransfer(auth, signature);
  });
  vi.spyOn(settle, 'encodeSettleCalldata').mockImplementation((params, signature) => {
    visit(encodingTraces.get(params)!, 'encode');
    return encodeSettle(params, signature);
  });
});
afterEach(() => vi.restoreAllMocks());

async function harness(rail: Rail, day = '20260924') {
  const trace: Trace = { events: [], error: new Error('injected failure') };
  const nonce: Hex = `0x${'22'.repeat(32)}`;
  const auth: authorization.Eip3009Authorization = {
    from: account.address, to: MERCHANT, value: 1000n,
    validAfter: 0n, validBefore: BigInt(NOW + 60), nonce,
  };
  const params = {
    from: account.address, merchant: MERCHANT, merchantValue: 1000n,
    feeReceiver: FEE_RECEIVER, feeValue: 2n, validAfter: 0n,
    validBefore: BigInt(NOW + 60), intentSalt: nonce,
  };
  const rateLimitKeys = [account.address, '1.2.3.0/24'];
  const gasToken = `relay:budget:${CHAIN}:${day}` as GasBudgetRefundToken;
  const subfloorToken = `relay:subfloor:budget:${CHAIN}:${day}` as SubfloorBudgetRefundToken;
  const control = {
    taskId: HASH as string,
    outcome: { state: 'success', txHash: FINAL_HASH } as RelayTaskOutcome,
    claim: { status: 'first' } as Awaited<ReturnType<NonNullable<RelayDeps['claimIdempotency']>>>,
    allowed: true, subfloorAllowed: true, gasAllowed: true,
    subfloorBudgetAllowed: true, consumed: true, subfloorConsumed: true,
  };
  const submit = vi.fn(async (_chain: number, _target: Address, _data: Hex) => {
    visit(trace, 'submit');
    return { taskId: control.taskId };
  });
  const deps = {
    nowSec: () => NOW, maxValue: 10n ** 30n,
    expectedFeeValue: 2n, maxValidityWindowSec: 1200,
    jpycAddressFor: () => JPYC, forwarderFor: () => FORWARDER, feeReceiverFor: () => FEE_RECEIVER,
    getBalance: vi.fn(async () => { visit(trace, 'balance'); return 10_000n; }),
    checkAuthorizationUsed: vi.fn(async () => { visit(trace, 'used'); return false; }),
    claimIdempotency: vi.fn(async () => { visit(trace, 'claim'); return control.claim; }),
    checkRateLimit: vi.fn(async (_keys: string[]) => { visit(trace, 'limit'); return control.allowed; }),
    checkSubfloorPayerRateLimit: vi.fn(async (_chain: number, _payer: Address) => {
      visit(trace, 'subfloor-limit'); return control.subfloorAllowed;
    }),
    checkSubfloorBudget: vi.fn<NonNullable<ForwarderRecoverDeps['checkSubfloorBudget']>>(async () => {
      visit(trace, 'subfloor-budget');
      return control.subfloorConsumed
        ? { allowed: control.subfloorBudgetAllowed, consumed: true, refundToken: subfloorToken }
        : { allowed: control.subfloorBudgetAllowed, consumed: false, refundToken: null };
    }),
    checkGasBudget: vi.fn<NonNullable<RelayDeps['checkGasBudget']>>(async () => {
      visit(trace, 'gas-budget');
      return control.consumed
        ? { allowed: control.gasAllowed, consumed: true, refundToken: gasToken }
        : { allowed: control.gasAllowed, consumed: false, refundToken: null };
    }),
    releaseIdempotency: vi.fn(async (_chain: number, _from: Address, _nonce: Hex) => { visit(trace, 'release'); }),
    recordRelayHash: vi.fn(async (_chain: number, _from: Address, _nonce: Hex, hash: Hex) => {
      visit(trace, hash === HASH ? 'record-submit' : 'record-outcome');
    }),
    refundGasBudget: vi.fn(async (_token: GasBudgetRefundToken) => { visit(trace, 'refund-gas'); }),
    refundSubfloorBudget: vi.fn(async (_token: SubfloorBudgetRefundToken) => { visit(trace, 'refund-subfloor'); }),
    submitSponsoredCall: submit, submit,
    pollTask: vi.fn(async (_taskId: string) => { visit(trace, 'poll'); return control.outcome; }),
  } satisfies RelayDeps & ForwarderRecoverDeps;
  const signature = rail === 'free'
    ? await account.signTypedData(authorization.buildTransferWithAuthorizationTypedData(auth, CHAIN, JPYC))
    : await account.signTypedData(buildReceiveWithAuthorizationTypedData(params, CHAIN, JPYC, FORWARDER));
  encodingTraces.set(rail === 'free' ? auth : params, trace);
  const run = () => rail === 'free'
    ? relayJpycAuthorization({ chainId: CHAIN, auth, signature, rateLimitKeys }, deps)
    : recoverViaForwarder({ chainId: CHAIN, params, signature, rateLimitKeys }, deps);
  const expectedNonce = rail === 'free' ? nonce : buildForwarderNonce(params, CHAIN, FORWARDER);
  const beforeEncode = ['balance', 'used', 'claim', 'limit',
    ...(rail === 'recover' ? ['subfloor-limit', 'subfloor-budget'] : []), 'gas-budget'];
  const refunds = ['release', 'refund-gas', ...(rail === 'recover' ? ['refund-subfloor'] : [])];
  return { trace, deps, control, run, beforeEncode, refunds, gasToken, subfloorToken, expectedNonce, rateLimitKeys };
}

describe.each<Rail>(['free', 'recover'])('%s broadcast contract', (rail) => {
  it('pins the complete order, dependency arguments and calldata bytes', async () => {
    const h = await harness(rail);
    expect(await h.run()).toEqual({ kind: 'success', txHash: FINAL_HASH });
    expect(h.trace.events).toEqual([...h.beforeEncode, 'encode', 'submit', 'record-submit', 'poll', 'record-outcome']);
    expect(h.deps.checkRateLimit.mock.calls[0][0]).toBe(h.rateLimitKeys);
    expect(h.deps.claimIdempotency).toHaveBeenCalledWith(CHAIN, account.address, h.expectedNonce);
    expect(h.deps.recordRelayHash.mock.calls).toEqual([
      [CHAIN, account.address, h.expectedNonce, HASH],
      [CHAIN, account.address, h.expectedNonce, FINAL_HASH],
    ]);
    expect(h.deps.submit.mock.calls[0].slice(0, 2)).toEqual([CHAIN, rail === 'free' ? JPYC : FORWARDER]);
    expect(h.deps.pollTask).toHaveBeenCalledWith(HASH);
    if (rail === 'recover') {
      expect(h.deps.checkSubfloorPayerRateLimit).toHaveBeenCalledWith(CHAIN, account.address);
      expect(h.deps.checkSubfloorBudget).toHaveBeenCalledWith(CHAIN);
    }
    expect(h.deps.checkGasBudget).toHaveBeenCalledWith(CHAIN);
    expect(createHash('sha256').update(h.deps.submit.mock.calls[0][2]).digest('hex')).toBe(
      rail === 'free'
        ? '21d750a4e17bf6f79304759e34399033135b48cbf061dbc99ef67f5430b763b2'
        : '49354607951af4c656775c83c8931da019945177c936f801a24db6a59bbb49fe',
    );
  });

  it.each(['balance', 'used'])('preserves the existing %s preflight error difference (B-R5 deferred)', async (step) => {
    const h = await harness(rail);
    h.trace.fail = step;
    if (rail === 'free') await expect(h.run()).rejects.toBe(h.trace.error);
    else expect(await h.run()).toEqual({ kind: 'rejected', httpStatus: 503, reason: 'preflight_unavailable' });
    expect(h.trace.events).toEqual(step === 'balance' ? ['balance'] : ['balance', 'used']);
  });

  it.each(['claim', 'limit', 'gas-budget', 'encode', 'record-submit', 'poll', 'record-outcome'])(
    '%s exceptions propagate without releasing or refunding', async (step) => {
      const h = await harness(rail);
      h.trace.fail = step;
      await expect(h.run()).rejects.toBe(h.trace.error);
      const successful = [...h.beforeEncode, 'encode', 'submit', 'record-submit', 'poll', 'record-outcome'];
      expect(h.trace.events).toEqual(successful.slice(0, successful.indexOf(step) + 1));
    },
  );

  it.each(['submit', 'poll-error'])('%s releases then refunds the exact acquired tokens', async (step) => {
    const h = await harness(rail);
    h.control.taskId = 'gelato-task';
    if (step === 'submit') h.trace.fail = 'submit';
    else h.control.outcome = { state: 'error', detail: 'Cancelled' };
    expect(await h.run()).toEqual({ kind: 'relay_error', detail: step === 'submit' ? 'submit_failed: injected failure' : 'Cancelled' });
    expect(h.trace.events).toEqual([...h.beforeEncode, 'encode', 'submit', ...(step === 'poll-error' ? ['poll'] : []), ...h.refunds]);
    expect(h.deps.releaseIdempotency).toHaveBeenCalledWith(CHAIN, account.address, h.expectedNonce);
    expect(h.deps.refundGasBudget.mock.calls[0][0]).toBe(h.gasToken);
    if (rail === 'recover') expect(h.deps.refundSubfloorBudget.mock.calls[0][0]).toBe(h.subfloorToken);
  });

  it.each(['release', 'refund-gas'])('a throwing %s stops the remaining cleanup in its existing order', async (step) => {
    const h = await harness(rail);
    h.control.taskId = 'gelato-task';
    h.control.outcome = { state: 'error', detail: 'Cancelled' };
    h.trace.fail = step;
    await expect(h.run()).rejects.toBe(h.trace.error);
    expect(h.trace.events).toEqual([...h.beforeEncode, 'encode', 'submit', 'poll', ...h.refunds.slice(0, h.refunds.indexOf(step) + 1)]);
  });

  it.each(['pending', 'reverted'] as const)('%s retains claim and budgets, with or without a hash', async (state) => {
    for (const txHash of [undefined, FINAL_HASH]) {
      const h = await harness(rail);
      h.control.taskId = 'gelato-task';
      h.control.outcome = { state, txHash };
      expect(await h.run()).toEqual({ kind: state, txHash });
      expect(h.trace.events).toEqual([...h.beforeEncode, 'encode', 'submit', 'poll', ...(txHash ? ['record-outcome'] : [])]);
    }
  });

  it.each([null, HASH])('duplicate claim returns the recorded hash %s without consuming limits', async (txHash) => {
    const h = await harness(rail);
    h.control.claim = { status: 'duplicate', txHash };
    expect(await h.run()).toEqual({ kind: 'pending', txHash: txHash ?? undefined });
    expect(h.trace.events).toEqual(['balance', 'used', 'claim']);
  });

  it.each(['limit', 'gas-budget'])('%s rejection releases only owned claims and eligible budgets', async (step) => {
    const h = await harness(rail);
    h.control.allowed = step !== 'limit';
    h.control.gasAllowed = step !== 'gas-budget';
    expect(await h.run()).toEqual({ kind: 'rejected', httpStatus: step === 'limit' ? 429 : 503,
      reason: step === 'limit' ? 'rate_limited' : 'daily_budget_exceeded' });
    expect(h.trace.events).toEqual([...h.beforeEncode.slice(0, h.beforeEncode.indexOf(step) + 1), 'release',
      ...(step === 'gas-budget' && rail === 'recover' ? ['refund-subfloor'] : [])]);
    if (step === 'gas-budget' && rail === 'recover') expect(h.deps.refundSubfloorBudget.mock.calls[0][0]).toBe(h.subfloorToken);
  });

  it('skips absent optional checks and never records/releases an unowned claim or refunds unacquired budgets', async () => {
    const h = await harness(rail);
    // Retain the cleanup/recording spies while removing the operations which confer ownership.
    for (const key of ['checkAuthorizationUsed', 'claimIdempotency', 'checkGasBudget', 'checkSubfloorPayerRateLimit', 'checkSubfloorBudget'] as const) {
      Reflect.deleteProperty(h.deps, key);
    }
    h.control.outcome = { state: 'error', detail: 'Cancelled' };
    expect(await h.run()).toEqual({ kind: 'relay_error', detail: 'Cancelled' });
    expect(h.trace.events).toEqual(['balance', 'limit', 'encode', 'submit', 'poll']);
  });

  it('allows absent optional cleanup/recording callbacks after acquiring claims and budgets', async () => {
    const h = await harness(rail);
    for (const key of ['recordRelayHash', 'releaseIdempotency', 'refundGasBudget', 'refundSubfloorBudget'] as const) {
      Reflect.deleteProperty(h.deps, key);
    }
    h.control.outcome = { state: 'error', detail: 'Cancelled' };
    expect(await h.run()).toEqual({ kind: 'relay_error', detail: 'Cancelled' });
    expect(h.trace.events).toEqual([...h.beforeEncode, 'encode', 'submit', 'poll']);
  });

  it('does not refund fail-open budgets with null tokens', async () => {
    const h = await harness(rail);
    h.control.consumed = false;
    h.control.subfloorConsumed = false;
    h.trace.fail = 'submit';
    expect(await h.run()).toEqual({ kind: 'relay_error', detail: 'submit_failed: injected failure' });
    expect(h.trace.events).toEqual([...h.beforeEncode, 'encode', 'submit', 'release']);
  });

  it('keeps the text of a non-Error submit rejection', async () => {
    const h = await harness(rail);
    h.trace.error = 'plain string failure' as unknown as Error;
    h.trace.fail = 'submit';
    expect(await h.run()).toEqual({ kind: 'relay_error', detail: 'submit_failed: plain string failure' });
  });

  it('keeps claim ownership and prior-day refund tokens local across interleaved invocations', async () => {
    const first = await harness(rail, '20260924');
    const nextDay = await harness(rail, '20260925');
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    first.deps.submit.mockImplementation(async () => {
      visit(first.trace, 'submit');
      entered();
      await blocked;
      throw first.trace.error;
    });
    const pending = first.run();
    await started;
    nextDay.control.taskId = 'gelato-task';
    nextDay.control.outcome = { state: 'error', detail: 'Cancelled' };
    expect(await nextDay.run()).toEqual({ kind: 'relay_error', detail: 'Cancelled' });
    const duplicate = await harness(rail);
    duplicate.control.claim = { status: 'duplicate', txHash: HASH };
    expect(await duplicate.run()).toEqual({ kind: 'pending', txHash: HASH });
    expect(duplicate.trace.events).toEqual(['balance', 'used', 'claim']);
    resume();
    expect(await pending).toEqual({ kind: 'relay_error', detail: 'submit_failed: injected failure' });
    for (const h of [first, nextDay]) {
      expect(h.deps.refundGasBudget.mock.calls).toEqual([[h.gasToken]]);
      expect(h.deps.releaseIdempotency.mock.calls).toEqual([[CHAIN, account.address, h.expectedNonce]]);
      if (rail === 'recover') expect(h.deps.refundSubfloorBudget.mock.calls).toEqual([[h.subfloorToken]]);
    }
    expect(first.trace.events).toEqual([...first.beforeEncode, 'encode', 'submit', ...first.refunds]);
    expect(nextDay.trace.events).toEqual([...nextDay.beforeEncode, 'encode', 'submit', 'poll', ...nextDay.refunds]);
  });
});

describe('recover-only subfloor policy', () => {
  it.each(['subfloor-limit', 'subfloor-budget'])('%s rejection stops before shared budget acquisition', async (step) => {
    const h = await harness('recover');
    h.control.subfloorAllowed = step !== 'subfloor-limit';
    h.control.subfloorBudgetAllowed = step !== 'subfloor-budget';
    expect(await h.run()).toEqual({ kind: 'rejected', httpStatus: step === 'subfloor-limit' ? 429 : 503,
      reason: step === 'subfloor-limit' ? 'rate_limited' : 'daily_budget_exceeded' });
    expect(h.trace.events).toEqual([...h.beforeEncode.slice(0, h.beforeEncode.indexOf(step) + 1), 'release']);
  });

  it.each(['subfloor-limit', 'subfloor-budget'])('%s exceptions propagate without cleanup', async (step) => {
    const h = await harness('recover');
    h.trace.fail = step;
    await expect(h.run()).rejects.toBe(h.trace.error);
    expect(h.trace.events).toEqual(h.beforeEncode.slice(0, h.beforeEncode.indexOf(step) + 1));
  });

  it.each(['gas', 'subfloor'])('only refunds the acquired %s budget when the other fails open', async (budget) => {
    const h = await harness('recover');
    h.control.consumed = budget === 'gas';
    h.control.subfloorConsumed = budget === 'subfloor';
    h.trace.fail = 'submit';
    expect(await h.run()).toEqual({ kind: 'relay_error', detail: 'submit_failed: injected failure' });
    expect(h.trace.events).toEqual([...h.beforeEncode, 'encode', 'submit', 'release', `refund-${budget}`]);
    if (budget === 'gas') expect(h.deps.refundGasBudget.mock.calls[0][0]).toBe(h.gasToken);
    else expect(h.deps.refundSubfloorBudget.mock.calls[0][0]).toBe(h.subfloorToken);
  });
});
