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

  it('authorizationState 既使用 → pending (submit せず・二重支払い防止)', async () => {
    const deps = makeDeps({ checkAuthorizationUsed: vi.fn(async () => true) });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('pending');
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('冪等性: claimIdempotency duplicate → pending (submit せず)', async () => {
    const claimIdempotency = vi.fn<
      (c: number, from: Address, nonce: Hex) => Promise<'duplicate'>
    >(async () => 'duplicate');
    const deps = makeDeps({ claimIdempotency });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('pending');
    expect(deps.submit).not.toHaveBeenCalled();
    // claim には commitment nonce (= EIP-3009 nonce) が渡る。
    const [, from, nonce] = claimIdempotency.mock.calls[0];
    expect(getAddress(from)).toBe(getAddress(account.address));
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('冪等性: claimIdempotency first → 通常どおり submit → success', async () => {
    const deps = makeDeps({ claimIdempotency: vi.fn(async () => 'first' as const) });
    const res = await recoverViaForwarder(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(deps.submit).toHaveBeenCalledOnce();
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
