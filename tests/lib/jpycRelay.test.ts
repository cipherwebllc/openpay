import { describe, it, expect, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildTransferWithAuthorizationTypedData,
  type Eip3009Authorization,
} from '@/lib/jpycEip3009';
import {
  relayJpycAuthorization,
  type RelayDeps,
  type RelayInput,
} from '@/lib/relay/jpycRelay';

const JPYC: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const CHAIN = 137;
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(PK);
const TO: Address = '0x000000000000000000000000000000000000dEaD';
const NOW = 1_800_000_000;

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
    const deps = makeDeps({ checkGasBudget: vi.fn(async () => false) });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({
      kind: 'rejected',
      reason: 'daily_budget_exceeded',
      httpStatus: 503,
    });
    expect(deps.submitSponsoredCall).not.toHaveBeenCalled();
  });

  it('B4: 予算内 (checkGasBudget true) → 通常どおり submit', async () => {
    const deps = makeDeps({ checkGasBudget: vi.fn(async () => true) });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res.kind).toBe('success');
    expect(deps.submitSponsoredCall).toHaveBeenCalledOnce();
  });

  it('B4: 予算チェックは重複ガードの後 (claim 済で予算超過 → release される・Codex P1)', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      checkGasBudget: vi.fn(async () => false),
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

  it('poll error → relay_error だが claim は解放しない (Gelato timeout=broadcast 済の可能性)', async () => {
    const releaseIdempotency = vi.fn(async () => {});
    const deps = makeDeps({
      claimIdempotency: vi.fn(async () => ({ status: 'first' as const })),
      releaseIdempotency,
      pollTask: vi.fn(async () => ({
        state: 'error' as const,
        detail: 'timeout',
      })),
    });
    const res = await relayJpycAuthorization(await makeInput(), deps);
    expect(res).toMatchObject({ kind: 'relay_error' });
    expect(releaseIdempotency).not.toHaveBeenCalled(); // 再 submit による二重送金を防ぐ
  });
});
