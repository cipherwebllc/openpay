import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, keccak256, pad, type Hex } from 'viem';
import * as config from '@/lib/crossChain/config';
import { GATEWAY_MINTER_ABI } from '@/lib/crossChain/gateway';
import { decodeGatewayAttestation } from '@/lib/crossChain/gatewayAttestation';
import { activeGatewayAttempt, gatewayCanRelease, reconcileGatewayReceipt, reconcileGatewayAttempt, recoverGatewayMintHash, type GatewayAttempt } from '@/lib/crossChain/gatewayRecovery';
import { env } from '@/lib/env';
import { executeGatewayTransfer, type GatewayResumeState } from '@/lib/crossChain/execute';
import { gatewayAttestation, gatewaySpec, encodedSpec } from '../../fixtures/gateway';

const hash = pad('0x01');
const address = (s: Hex) => `0x${s.slice(-40)}` as Hex;
function setup(resume: GatewayResumeState = { merchantAttestation: gatewayAttestation() }) {
  let used = false;
  const minted = new Set<Hex>();
  let chainId = 80002;
  const wallet = { getChainId: vi.fn(async () => chainId), signTypedData: vi.fn(async (_args: unknown) => gatewayAttestation().signature), sendTransaction: vi.fn(async ({ data }: { data: Hex }) => {
    const att = decodeFunctionData({ abi: GATEWAY_MINTER_ABI, data }).args[0];
    minted.add(decodeGatewayAttestation(att).transferSpecHash); return hash;
  }) };
  const block = { number: '0x65', hash, l1BlockNumber: '0x65' };
  const client = {
    request: vi.fn(async (a: { method: string; params: unknown[] }): Promise<unknown> => a.method === 'eth_call' ? pad(used || minted.has(`0x${(a.params[0] as { data: string }).data.slice(-64)}`) ? '0x01' : '0x00') : block),
    readContract: vi.fn(async () => 302_400n), getBlockNumber: vi.fn(async () => 1000n),
    getCode: vi.fn(async () => '0x1234'), getLogs: vi.fn(async () => []),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  };
  let saved = resume;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/balances')) return new Response(JSON.stringify({ balances: [{ domain: 6, balance: '20' }] }));
    const spec = JSON.parse(String(init?.body))[0].burnIntent.spec;
    return new Response(JSON.stringify({ ...gatewayAttestation({ ...spec, value: BigInt(spec.value) }, 1000n), expirationBlock: '1000', transferId: 'transfer-id' }));
  });
  const args = {
    walletClient: wallet as never, sourcePublicClient: client as never, destPublicClient: client as never,
    switchChainAsync: vi.fn(async ({ chainId: id }: { chainId: number }) => { chainId = id; }), account: address(gatewaySpec.sourceDepositor), recipient: address(gatewaySpec.destinationRecipient),
    sourceChainId: 84532, destChainId: 80002, sourceDomain: 6 as const, destDomain: 7 as const,
    sourceToken: address(gatewaySpec.sourceToken), destToken: address(gatewaySpec.destinationToken), valueAtomic: 1_000_000n,
    resume, fetch, onStep: (s: GatewayResumeState) => { saved = structuredClone(s); },
  };
  return { args, wallet, client, fetch, block, minted, saved: () => saved, setUsed: (v: boolean) => { used = v; } };
}
afterEach(() => vi.restoreAllMocks());
describe('X12 Gateway recovery', () => {
  it('retains expired-unused evidence and never broadcasts or signs on ordinary resume', async () => {
    const s = setup();
    await expect(executeGatewayTransfer(s.args)).rejects.toThrow();
    expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
    expect(s.saved().merchantAttestation).toEqual(s.args.resume.merchantAttestation);
    expect(activeGatewayAttempt(s.saved().merchant)?.obtainedAt).toBeUndefined();
    expect(activeGatewayAttempt(s.saved().merchant)?.attestation?.transferId).toBeUndefined();
    expect(activeGatewayAttempt(s.saved().merchant)?.observations.at(-1)?.funding).toMatchObject({ sourceDomain: 6, token: 'USDC', requiredAtomic: '1001000' });
  });
  it('settles a third-party finalized mint without a saved hash or signing', async () => {
    const s = setup(); s.setUsed(true);
    const result = await executeGatewayTransfer(s.args);
    expect(result).toMatchObject({ path: 'gateway', settlement: 'hashless', transferSpecHash: keccak256(encodedSpec()) });
    expect(result.mintTxHash).toBeUndefined();
    expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
  it('does not sign a missing fee on ordinary resume', async () => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
    const s = setup(); s.setUsed(true);
    await executeGatewayTransfer({ ...s.args, feeReceiver: address(pad('0x12')), feeAmount: 100n });
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
});

function attempt(expiry = 100n): GatewayAttempt {
  const att = gatewayAttestation(gatewaySpec, expiry);
  const d = decodeGatewayAttestation(att.attestation);
  return { attestation: att, spec: { ...d.spec, value: String(d.spec.value) }, transferSpecHash: d.transferSpecHash,
    receiptScanFrom: '0', maxBlockHeight: String(d.maxBlockHeight), status: 'unknown', observations: [], txHashes: [] };
}
const merchantHash = keccak256(encodedSpec());

describe('X12 finalized snapshot boundaries', () => {
  it('treats equality as valid and pins consumption to the exact canonical block hash', async () => {
    const s = setup(); s.block.number = '0x64';
    expect((await reconcileGatewayAttempt(s.args.destPublicClient, 80002, attempt())).status).toBe('mintable');
    const calls = s.client.request.mock.calls.filter(([a]) => a.method === 'eth_call');
    expect(calls).toHaveLength(2);
    for (const [a] of calls) expect(a.params[1]).toEqual({ blockHash: hash, requireCanonical: true });
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
  it.each(['concurrent-mint', 'latest-expired'])('waits for finality on %s, regardless of surplus funds', async (scenario) => {
    const s = setup();
    const latestHash = pad('0x02');
    s.client.request.mockImplementation(async (a) => {
      if (a.method === 'eth_call') return pad(scenario === 'concurrent-mint' && (a.params[1] as { blockHash: Hex }).blockHash === latestHash ? '0x01' : '0x00');
      return a.params[0] === 'latest' ? { number: '0x65', hash: latestHash } : { number: '0x64', hash };
    });
    await expect(executeGatewayTransfer(s.args)).rejects.toThrow();
    expect(activeGatewayAttempt(s.saved().merchant)?.status).toBe('awaiting-finality');
    expect(activeGatewayAttempt(s.saved().merchant)?.observations.at(-1)).toMatchObject({ latestUsed: scenario === 'concurrent-mint', latestHeight: '101' });
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
    expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('keeps evidence on a reorg of the expiry boundary instead of authorizing replacement', async () => {
    const s = setup();
    s.client.request.mockImplementation(async (a) => a.method === 'eth_call' ? pad('0x00') :
      { number: '0x65', hash: a.params[0] === 'finalized' ? hash : pad('0x02') });
    await expect(executeGatewayTransfer(s.args)).rejects.toThrow();
    expect(activeGatewayAttempt(s.saved().merchant)?.status).toBe('unknown');
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
    expect(s.saved().merchantAttestation).toEqual(s.args.resume.merchantAttestation);
  });
  it.each([42161, 421614])('uses Arbitrum %s L1 height even when RPC L2 height has crossed expiry', async (chain) => {
    const s = setup(); s.block.number = '0xffff'; s.block.l1BlockNumber = '0x64';
    expect((await reconcileGatewayAttempt(s.args.destPublicClient, chain, attempt())).status).toBe('mintable');
    s.block.l1BlockNumber = '0x65';
    expect((await reconcileGatewayAttempt(s.args.destPublicClient, chain, attempt())).status).toBe('expired-unused');
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
  it.each(['rpc', 'unsupported', 'missing-l1', 'malformed-used'])('keeps the lock on %s', async (failure) => {
    const s = setup();
    let chain = 80002;
    if (failure === 'rpc') s.client.request.mockRejectedValue(new Error('offline'));
    if (failure === 'unsupported') chain = 999;
    if (failure === 'missing-l1') { chain = 42161; s.block.l1BlockNumber = 'invalid'; }
    if (failure === 'malformed-used') s.client.request.mockImplementation(async (a) => a.method === 'eth_call' ? '0x' : s.block);
    expect((await reconcileGatewayAttempt(s.args.destPublicClient, chain, attempt())).status).toBe('unknown');
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
});

describe('X12 replacement and leg funding', () => {
  beforeEach(() => vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true));
  it.each([
    [{ domain: 6, balance: '1' }], // principal alone cannot cover the Circle fee
    [{ domain: 7, balance: '100' }], // another source domain is not spendable by this intent
    [{ domain: 6, balance: '1e2' }],
    [{ domain: 6, balance: '100' }, { domain: 6, balance: '100' }],
    [],
  ].map((balances) => ({ balances })))('does not offer replacement for insufficient or malformed balances %j', async ({ balances }) => {
    const s = setup(); s.fetch.mockResolvedValue(new Response(JSON.stringify({ balances })));
    await expect(executeGatewayTransfer(s.args)).rejects.toThrow();
    expect(activeGatewayAttempt(s.saved().merchant)?.status).toBe('awaiting-balance');
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
    expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('includes every outstanding leg and each Circle fee in the funding gate', async () => {
    const s = setup({ merchantAttestation: gatewayAttestation(), feeAttestation: gatewayAttestation({ ...gatewaySpec, value: 10_000n, destinationRecipient: pad('0x12') }) });
    s.fetch.mockResolvedValue(new Response(JSON.stringify({ balances: [{ domain: 6, balance: '1.011' }] })));
    await expect(executeGatewayTransfer({ ...s.args, feeAmount: 10_000n, feeReceiver: address(pad('0x12')) })).rejects.toThrow();
    expect(activeGatewayAttempt(s.saved().merchant)?.status).toBe('awaiting-balance');
    expect(activeGatewayAttempt(s.saved().fee)?.status).toBe('awaiting-balance');
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
  it('reload after classification rechecks proof and funding without signing', async () => {
    const s = setup(); await expect(executeGatewayTransfer(s.args)).rejects.toThrow();
    expect(activeGatewayAttempt(s.saved().merchant)?.status).toBe('replaceable');
    s.fetch.mockRejectedValue(new Error('balance offline'));
    await expect(executeGatewayTransfer({ ...s.args, resume: structuredClone(s.saved()) })).rejects.toThrow();
    expect(activeGatewayAttempt(s.saved().merchant)?.status).toBe('awaiting-balance');
    expect(s.saved().merchantAttestation).toEqual(s.args.resume.merchantAttestation);
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
  it('signs only with consent for the exact resolved identity and retains all old evidence', async () => {
    const s = setup();
    const result = await executeGatewayTransfer({ ...s.args, replacement: { merchant: merchantHash } });
    expect(result.path).toBe('gateway');
    expect(s.wallet.signTypedData).toHaveBeenCalledOnce();
    expect(s.saved().merchant?.attempts).toHaveLength(2);
    expect(s.saved().merchant?.attempts[0].attestation).toEqual(s.args.resume.merchantAttestation);
    const current = activeGatewayAttempt(s.saved().merchant)!;
    expect(current.transferSpecHash).not.toBe(merchantHash);
    expect(current.attestation).toMatchObject({ transferId: 'transfer-id', expirationBlock: '1000' });
    expect(current.obtainedAt).toEqual(expect.any(Number));
    expect(s.fetch.mock.calls.filter(([url]) => url.endsWith('/v1/balances'))).toHaveLength(2);
  });
  it.each(['stale-consent', 'already-paid', 'insufficient-after-check'])('rejects replacement at signing time: %s', async (failure) => {
    const s = setup();
    if (failure === 'already-paid') s.client.getBlockNumber.mockImplementation(async () => { s.setUsed(true); return 1000n; });
    if (failure === 'insufficient-after-check') s.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ balances: [{ domain: 6, balance: '20' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ balances: [{ domain: 6, balance: '0' }] })));
    await expect(executeGatewayTransfer({ ...s.args, replacement: { merchant: failure === 'stale-consent' ? pad('0x99') : merchantHash } })).rejects.toThrow();
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
  it('saves spec/salt/signature before transfer and keeps an unresolved request after response loss', async () => {
    const s = setup(); const original = s.fetch.getMockImplementation()!;
    s.fetch.mockImplementation(async (url, init) => {
      if (!url.endsWith('/v1/transfer')) return original(url, init);
      const current = activeGatewayAttempt(s.saved().merchant)!;
      const req = JSON.parse(String(init?.body))[0];
      expect(current.spec).toEqual(req.burnIntent.spec);
      expect(current.intent?.signature).toBe(req.signature);
      expect(current.intent?.requestSentAt).toEqual(expect.any(Number));
      throw new Error('response lost');
    });
    await expect(executeGatewayTransfer({ ...s.args, replacement: { merchant: merchantHash } })).rejects.toThrow('response lost');
    expect(s.saved().merchant?.attempts).toHaveLength(2);
    s.wallet.signTypedData.mockClear(); s.fetch.mockClear();
    await expect(executeGatewayTransfer({ ...s.args, resume: s.saved() })).rejects.toThrow();
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('aborts before signing/request when durable storage fails', async () => {
    const s = setup(); vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
    await expect(executeGatewayTransfer({ ...s.args, resume: undefined, onStep: () => { throw new Error('quota'); } })).rejects.toThrow('quota');
    expect(s.wallet.signTypedData).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
  });
  it('merchant-paid / fee-expired stays paid; explicit fee replacement never signs/pays the merchant again', async () => {
    const feeSpec = { ...gatewaySpec, value: 10_000n, destinationRecipient: pad('0x12'), salt: pad('0x02') };
    const s = setup({ merchantAttestation: gatewayAttestation(), feeAttestation: gatewayAttestation(feeSpec) });
    s.minted.add(merchantHash);
    const args = { ...s.args, feeReceiver: address(pad('0x12')), feeAmount: 10_000n };
    expect(await executeGatewayTransfer(args)).toMatchObject({ settlement: 'hashless', feeUnresolved: true });
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
    const result = await executeGatewayTransfer({ ...args, replacement: { fee: keccak256(encodedSpec(feeSpec)) } });
    expect(result.feeUnresolved).toBe(false);
    expect(s.wallet.signTypedData).toHaveBeenCalledOnce();
    expect(s.wallet.signTypedData.mock.calls[0]).toEqual([expect.objectContaining({ message: expect.objectContaining({ spec: expect.objectContaining({ destinationRecipient: pad('0x12') }) }) })]);
    expect(s.saved().merchant?.attempts).toHaveLength(1);
    expect(s.saved().fee?.attempts).toHaveLength(2);
  });
});

describe('X12 broadcast/revert races', () => {
  it.each(['AttestationExpiredAtIndex', 'TransferSpecHashUsed', 'generic reverted receipt'])('reconciles %s without trusting our failed hash', async (failure) => {
    const s = setup({ merchantAttestation: gatewayAttestation(gatewaySpec, 1000n), mintTxHash: pad('0x33') });
    if (failure === 'generic reverted receipt') {
      s.client.waitForTransactionReceipt.mockImplementation(async () => { s.setUsed(true); return { status: 'reverted' }; });
    } else {
      s.wallet.sendTransaction.mockImplementation(async () => { s.setUsed(true); throw new Error(failure); });
    }
    const result = await executeGatewayTransfer(s.args);
    expect(result).toMatchObject({ settlement: 'hashless', transferSpecHash: merchantHash });
    expect(result.mintTxHash).toBeUndefined();
    expect(s.saved().mintTxHash).toBe(pad('0x33'));
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
  it('generic revert without consumption remains unresolved, with all tx evidence', async () => {
    const s = setup({ merchantAttestation: gatewayAttestation(gatewaySpec, 1000n) });
    s.wallet.sendTransaction.mockResolvedValue(hash);
    s.client.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    await expect(executeGatewayTransfer(s.args)).rejects.toThrow();
    expect(activeGatewayAttempt(s.saved().merchant)?.txHashes).toEqual([hash]);
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
});

it.each([
  { ...gatewayAttestation(), expirationBlock: '99' },
  gatewayAttestation({ ...gatewaySpec, sourceDepositor: pad('0x19') }),
  { ...gatewayAttestation(), attestation: `0x1e12db71${gatewayAttestation().attestation.slice(10)}` as Hex },
])('retains mismatched/unsupported raw evidence and never signs or broadcasts', async (attestation) => {
  const s = setup({ merchantAttestation: attestation });
  await expect(executeGatewayTransfer(s.args)).rejects.toThrow();
  expect(s.saved().merchantAttestation).toEqual(attestation);
  expect(s.wallet.signTypedData).not.toHaveBeenCalled(); expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
});

it('recovers another caller’s canonical mint hash and does not reuse a reverted local hash', async () => {
  const oldHash = pad('0x55'); const otherHash = pad('0x66');
  const s = setup({ merchant: { attempts: [{ ...attempt(), txHashes: [oldHash] }] }, merchantAttestation: gatewayAttestation(), mintTxHash: oldHash }); s.setUsed(true);
  s.client.getLogs.mockResolvedValue([{ transactionHash: otherHash, blockHash: hash, blockNumber: 100n, removed: false }] as never);
  const result = await executeGatewayTransfer(s.args);
  expect(result).toMatchObject({ settlement: 'transaction', mintTxHash: otherHash });
  expect(s.saved().mintTxHash).toBe(oldHash);
  expect(s.wallet.signTypedData).not.toHaveBeenCalled(); expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
});

it('continues receipt recovery backwards after a hashless completion, without signing', async () => {
  const s = setup({ merchant: { attempts: [attempt(5000n)] } }); s.block.number = '0x1388'; s.setUsed(true);
  await executeGatewayTransfer(s.args);
  expect(activeGatewayAttempt(s.saved().merchant)?.receiptScanTo).toBe('3000');
  s.client.getLogs.mockResolvedValue([{ transactionHash: pad('0x77'), blockHash: hash, blockNumber: 2500n, removed: false }] as never);
  const state = await reconcileGatewayReceipt(s.args.destPublicClient, s.args.destChainId, s.saved());
  expect(activeGatewayAttempt(state.merchant)?.settledTxHash).toBe(pad('0x77'));
  expect(s.client.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 1001n, toBlock: 3000n }));
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
});


describe('review regressions: request lifecycle and own mint', () => {
  it('recheckOnly refuses fresh signing even with rollout enabled', async () => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
    const s = setup({});
    await expect(executeGatewayTransfer({ ...s.args, recheckOnly: true })).rejects.toThrow();
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('does not replace with rollout disabled, but still rechecks the existing identity', async () => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(false);
    const s = setup();
    await expect(executeGatewayTransfer({ ...s.args, replacement: { merchant: merchantHash } })).rejects.toThrow();
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
    s.setUsed(true);
    expect(await executeGatewayTransfer(s.args)).toMatchObject({ settlement: 'hashless' });
    expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  });
  it('restores the replaceable identity after rejecting a replacement signature', async () => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
    const s = setup();
    s.wallet.signTypedData.mockRejectedValueOnce(new Error('User rejected'));
    await expect(executeGatewayTransfer({ ...s.args, replacement: { merchant: merchantHash } })).rejects.toThrow('User rejected');
    expect(activeGatewayAttempt(s.saved().merchant)?.transferSpecHash).toBe(merchantHash);
    await executeGatewayTransfer({ ...s.args, resume: s.saved(), replacement: { merchant: merchantHash } });
    expect(s.wallet.signTypedData).toHaveBeenCalledTimes(2);
  });
  it('returns this client’s own successful mint immediately before finality', async () => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
    const s = setup({}); const latestHash = pad('0x02'); const onMerchantMint = vi.fn();
    s.client.request.mockImplementation(async (a) => {
      if (a.method === 'eth_call') return pad((a.params[1] as { blockHash: Hex }).blockHash === latestHash && s.minted.size ? '0x01' : '0x00');
      return a.params[0] === 'latest' || a.params[0] === '0x66' ? { number: '0x66', hash: latestHash } : s.block;
    });
    const result = await executeGatewayTransfer({ ...s.args, onMerchantMint });
    expect(result).toMatchObject({ settlement: 'transaction', mintTxHash: hash });
    expect(onMerchantMint).toHaveBeenCalledWith({ mintTxHash: hash, transferSpecHash: result.transferSpecHash });
    expect(activeGatewayAttempt(s.saved().merchant)?.status).toBe('confirming');
    expect(s.wallet.signTypedData).toHaveBeenCalledOnce();
  });
});


it.each(['fresh', 'replacement'] as const)('releases a definitively rejected %s request and retries only on new consent', async (flow) => {
  vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
  const s = setup(flow === 'fresh' ? {} : undefined);
  const original = s.fetch.getMockImplementation()!;
  let reject = true;
  s.fetch.mockImplementation(async (url, init) => {
    if (reject && url.endsWith('/v1/transfer')) return new Response('invalid request', { status: 400 });
    return original(url, init);
  });
  const consent = flow === 'replacement' ? { replacement: { merchant: merchantHash } } : { newPayment: true };
  await expect(executeGatewayTransfer({ ...s.args, ...consent })).rejects.toThrow('HTTP 400');
  expect(gatewayCanRelease(s.saved())).toBe(true);
  expect(s.saved().merchant?.attempts.at(-1)?.status).toBe('rejected-request');
  expect(s.saved().merchant?.attempts.at(-1)?.intent?.requestSentAt).toEqual(expect.any(Number));
  s.wallet.signTypedData.mockClear();
  await expect(executeGatewayTransfer({ ...s.args, resume: s.saved() })).rejects.toThrow();
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  reject = false;
  await executeGatewayTransfer({ ...s.args, resume: s.saved(), ...consent });
  expect(s.wallet.signTypedData).toHaveBeenCalledOnce();
});

it('releases a rejected fresh signature and retries only on a new Pay click', async () => {
  vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
  const s = setup({}); s.wallet.signTypedData.mockRejectedValueOnce(new Error('rejected'));
  await expect(executeGatewayTransfer(s.args)).rejects.toThrow('rejected');
  expect(s.saved().merchant?.attempts[0].status).toBe('abandoned-unsigned');
  expect(gatewayCanRelease(s.saved())).toBe(true);
  expect(s.fetch).not.toHaveBeenCalled();
  s.wallet.signTypedData.mockClear();
  await expect(executeGatewayTransfer({ ...s.args, resume: s.saved() })).rejects.toThrow();
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  await executeGatewayTransfer({ ...s.args, resume: s.saved(), newPayment: true });
  expect(s.wallet.signTypedData).toHaveBeenCalledOnce();
});

it.each([408, 409, 429, 500, 503])('keeps HTTP %s ambiguous and never signs on recheck', async (status) => {
  vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
  const s = setup({}); s.fetch.mockResolvedValue(new Response('ambiguous', { status }));
  await expect(executeGatewayTransfer(s.args)).rejects.toThrow();
  expect(gatewayCanRelease(s.saved())).toBe(false);
  s.wallet.signTypedData.mockClear();
  await expect(executeGatewayTransfer({ ...s.args, resume: s.saved(), newPayment: true })).rejects.toThrow();
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
});

it.each([false, true])('distinguishes tracked signed-but-unsent from a lost response (requestSent=%s)', async (sent) => {
  const pending = attempt(); delete pending.attestation; delete pending.maxBlockHeight;
  pending.intent = { maxBlockHeight: '1000', maxFee: '1000', signature: gatewayAttestation().signature, requestTracked: true,
    ...(sent ? { requestSentAt: 1 } : {}) };
  const s = setup({ merchant: { attempts: [pending] } });
  await expect(executeGatewayTransfer({ ...s.args, recheckOnly: true })).rejects.toThrow();
  expect(gatewayCanRelease(s.saved())).toBe(!sent);
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  expect(s.fetch).not.toHaveBeenCalled();
});

it('does not infer unsent from missing tracking metadata in an older request', async () => {
  const pending = attempt(); delete pending.attestation; delete pending.maxBlockHeight;
  pending.intent = { maxBlockHeight: '1000', maxFee: '1000', signature: gatewayAttestation().signature };
  const s = setup({ merchant: { attempts: [pending] } });
  await expect(executeGatewayTransfer(s.args)).rejects.toThrow();
  expect(gatewayCanRelease(s.saved())).toBe(false);
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
});

it('the kill switch blocks explicit replacement but permits existing mint recovery', async () => {
  vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
  vi.spyOn(config, 'CROSS_CHAIN_DISABLED', 'get').mockReturnValue(true);
  const s = setup();
  await expect(executeGatewayTransfer({ ...s.args, replacement: { merchant: merchantHash } })).rejects.toThrow();
  s.setUsed(true);
  await executeGatewayTransfer(s.args);
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
});

it('a completed record is receipt-only, even when passed directly to the executor', async () => {
  const s = setup(); s.setUsed(true); await executeGatewayTransfer(s.args);
  const onMerchantMint = vi.fn();
  await expect(executeGatewayTransfer({ ...s.args, resume: s.saved(), onMerchantMint })).rejects.toThrow();
  expect(onMerchantMint).not.toHaveBeenCalled();
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
});


it('finality maintenance replaces a reorged own mint hash with the canonical caller’s hash', async () => {
  const old = pad('0x88'); const canonical = pad('0x99');
  const own = { ...attempt(), status: 'confirming' as const, settledTxHash: old, txHashes: [old] };
  const s = setup({ completion: 'confirming', merchant: { attempts: [own] } }); s.setUsed(true);
  s.client.getLogs.mockResolvedValue([{ transactionHash: canonical, blockHash: hash, blockNumber: 100n, removed: false }] as never);
  const state = await reconcileGatewayReceipt(s.args.destPublicClient, 80002, s.saved());
  expect(state.completion).toBe('settled');
  expect(activeGatewayAttempt(state.merchant)?.settledTxHash).toBe(canonical);
  expect(activeGatewayAttempt(state.merchant)?.txHashes).toEqual([old]);
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
});


it('releases an older unsigned attempt without inventing a signature on recheck', async () => {
  const pending = attempt(); delete pending.attestation; delete pending.maxBlockHeight;
  pending.intent = { maxBlockHeight: '1000', maxFee: '1000' };
  const s = setup({ merchant: { attempts: [pending] } });
  await expect(executeGatewayTransfer({ ...s.args, recheckOnly: true })).rejects.toThrow();
  expect(gatewayCanRelease(s.saved())).toBe(true);
  expect(s.saved().merchant?.attempts[0].status).toBe('abandoned-unsigned');
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  expect(s.fetch).not.toHaveBeenCalled();
});

it('S-C: a declined fee requires explicit fee authorization before merchant mint', async () => {
  vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
  const s = setup({});
  const fee = { feeReceiver: address(pad('0x12')), feeAmount: 100n };
  s.wallet.signTypedData.mockResolvedValueOnce(gatewayAttestation().signature).mockRejectedValueOnce(new Error('fee rejected'));
  await expect(executeGatewayTransfer({ ...s.args, ...fee })).rejects.toThrow('fee rejected');
  expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
  expect(s.saved().fee?.attempts.at(-1)?.status).toBe('abandoned-unsigned');
  s.wallet.signTypedData.mockClear();
  await expect(executeGatewayTransfer({ ...s.args, ...fee, resume: s.saved() })).rejects.toThrow();
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
  const merchant = activeGatewayAttempt(s.saved().merchant)!;
  await executeGatewayTransfer({ ...s.args, ...fee, resume: s.saved(), replacement: { authorizeFee: merchant.transferSpecHash } });
  expect(s.wallet.signTypedData).toHaveBeenCalledOnce();
  expect(s.wallet.sendTransaction).toHaveBeenCalledTimes(2);
  expect(s.saved().feeUnresolved).toBe(false);
});

it('surfaces a finalized expired-unused own receipt without another signature or success', async () => {
  const s = setup({ completion: 'confirming', merchant: { attempts: [{ ...attempt(), status: 'confirming', settledTxHash: hash }] } });
  const state = await reconcileGatewayReceipt(s.args.destPublicClient, 80002, s.saved());
  expect(state.completion).toBe('confirming');
  expect(activeGatewayAttempt(state.merchant)).toMatchObject({ status: 'expired-unused', settledTxHash: undefined });
  expect(gatewayCanRelease(state)).toBe(false);
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
  expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
});
it('bounds receipt lookup to the known attestation window', async () => {
  const s = setup(); const a = { ...attempt(4000n), receiptScanFrom: '3500' };
  await recoverGatewayMintHash(s.args.destPublicClient, a, { status: 'paid', used: true, blockNumber: '9000', height: '9000', blockHash: hash }, 80002);
  expect(s.client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 3500n, toBlock: 4000n }));
  expect(a.receiptScanComplete).toBe(true);
});
it('maps the Arbitrum attestation expiry from L1 heights to L2 receipt blocks', async () => {
  const s = setup(); const a = { ...attempt(100n), receiptScanFrom: '9000' };
  s.client.request.mockImplementation(async ({ params }) => {
    const number = BigInt(params[0] as string);
    return { hash, number: params[0], l1BlockNumber: number < 9500n ? '0x64' : '0x65' };
  });
  await recoverGatewayMintHash(s.args.destPublicClient, a, { status: 'paid', used: true, blockNumber: '10000', height: '101', blockHash: hash }, 421614);
  expect(s.client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 9000n, toBlock: 9499n }));
});
it('keeps legacy hashless receipts without an unbounded genesis scan', async () => {
  const s = setup(); s.setUsed(true);
  await executeGatewayTransfer(s.args);
  expect(s.client.getLogs).not.toHaveBeenCalled();
  expect(activeGatewayAttempt(s.saved().merchant)?.receiptScanComplete).toBe(true);
  expect(s.wallet.signTypedData).not.toHaveBeenCalled();
});
it('backs off repeated receipt failures before any RPC and retains the scan cursor', async () => {
  vi.useFakeTimers();
  try {
    const s = setup({ completion: 'settled', merchant: { attempts: [{ ...attempt(), status: 'paid' }] } }); s.setUsed(true);
    s.client.getLogs.mockRejectedValue(new Error('range unavailable'));
    let state = await reconcileGatewayReceipt(s.args.destPublicClient, 80002, s.saved());
    expect(activeGatewayAttempt(state.merchant)?.receiptRetryAt).toBe(Date.now() + 20000);
    s.client.request.mockClear(); s.client.getLogs.mockClear();
    state = await reconcileGatewayReceipt(s.args.destPublicClient, 80002, state);
    expect(s.client.request).not.toHaveBeenCalled(); expect(s.client.getLogs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20000);
    state = await reconcileGatewayReceipt(s.args.destPublicClient, 80002, state);
    expect(activeGatewayAttempt(state.merchant)?.receiptRetryAt).toBe(Date.now() + 40000);
    expect(activeGatewayAttempt(state.merchant)?.receiptScanTo).toBeUndefined();
    expect(s.wallet.signTypedData).not.toHaveBeenCalled(); expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it.each(['recheckOnly', 'rollout', 'kill-switch', 'stale-consent'])('refuses new fee authorization under %s', async (guard) => {
  vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(guard !== 'rollout');
  if (guard === 'kill-switch') vi.spyOn(config, 'CROSS_CHAIN_DISABLED', 'get').mockReturnValue(true);
  const s = setup({ merchant: { attempts: [attempt(1000n)] } });
  await expect(executeGatewayTransfer({ ...s.args, feeReceiver: address(pad('0x12')), feeAmount: 100n,
    recheckOnly: guard === 'recheckOnly', replacement: { authorizeFee: guard === 'stale-consent' ? pad('0xff') : merchantHash } })).rejects.toThrow();
  expect(s.wallet.signTypedData).not.toHaveBeenCalled(); expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
});

it.each(['fresh', 'replacement'] as const)('aborts a %s request when another tab abandoned its pending signature', async (flow) => {
  vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
  const { saveGatewayResumeStateStrict, saveResumeStateStrict, loadResumeState } = await import('@/lib/crossChain/resumeStore');
  const s = setup(flow === 'fresh' ? {} : undefined);
  const key = { kind: 'gateway' as const, account: s.args.account, recipient: s.args.recipient,
    sourceChainId: 84532, destChainId: 80002, valueAtomic: 1000000n, feeAtomic: 0n };
  if (flow === 'replacement') saveResumeStateStrict(key, s.args.resume);
  s.wallet.signTypedData.mockImplementation(async () => {
    const current = loadResumeState<GatewayResumeState>(key)!;
    current.merchant!.attempts.at(-1)!.status = 'abandoned-unsigned';
    saveGatewayResumeStateStrict(key, current);
    return gatewayAttestation().signature;
  });
  try {
    await expect(executeGatewayTransfer({ ...s.args,
      replacement: flow === 'replacement' ? { merchant: merchantHash } : undefined,
      onStep: (state, beforeSigning, beforeRequest) => saveGatewayResumeStateStrict(key, state, beforeSigning, beforeRequest),
    })).rejects.toThrow('before transfer request');
    const current = loadResumeState<GatewayResumeState>(key)!;
    expect(current.merchant!.attempts.at(-1)!.status).toBe('abandoned-unsigned');
    expect(current.merchant!.attempts.at(-1)!.intent?.requestSentAt).toBeUndefined();
    expect(s.fetch.mock.calls.filter(([url]) => url.endsWith('/v1/transfer'))).toHaveLength(0);
    expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
  } finally { localStorage.clear(); }
});

it('marks a lost own fee confirmation unresolved before archiving the paid merchant', async () => {
  const merchant = { ...attempt(), status: 'paid' as const, settledTxHash: hash };
  const attestation = gatewayAttestation({ ...gatewaySpec, value: 100n, destinationRecipient: pad('0x12') });
  const d = decodeGatewayAttestation(attestation.attestation);
  const s = setup({ completion: 'confirming', feeUnresolved: false, merchant: { attempts: [merchant] },
    fee: { attempts: [{ ...attempt(), attestation, transferSpecHash: d.transferSpecHash,
      spec: { ...d.spec, value: String(d.spec.value) }, status: 'confirming' }] } });
  const state = await reconcileGatewayReceipt(s.args.destPublicClient, 80002, s.saved());
  expect(state).toMatchObject({ completion: 'settled', feeUnresolved: true });
  expect(activeGatewayAttempt(state.fee)?.status).toBe('expired-unused');
  expect(s.wallet.signTypedData).not.toHaveBeenCalled(); expect(s.wallet.sendTransaction).not.toHaveBeenCalled();
});
