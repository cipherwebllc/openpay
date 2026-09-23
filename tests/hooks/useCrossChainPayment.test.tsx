import { gatewayAttestation, gatewaySpec } from '../fixtures/gateway';
import { pad } from 'viem';
import { act, renderHook, waitFor, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createPublicClient, type Address, type Hex } from 'viem';
import { useCrossChainPayment } from '@/hooks/useCrossChainPayment';
import { CrossChainHint } from '@/components/CrossChainHint';
import { renderWithIntl } from '../_helpers/i18n';
import { env } from '@/lib/env';
import * as chains from '@/lib/chains';
import { readAllCrossChainBalances } from '@/lib/crossChain/balance';
import { executeCctpTransfer, executeGatewayTransfer, CrossChainBurnUnresolvedError, CrossChainQuoteExpiredError, type CctpResumeState } from '@/lib/crossChain/execute';
import { acceptForwardQuote, fetchCctpBurnFees, pollIrisAttestation } from '@/lib/crossChain/cctp';
import { requestAttestation } from '@/lib/crossChain/gateway';
import { BUYER_SOURCE_TARGETS } from '@/lib/crossChain/config';
import { __resetContractDeployedCacheForTest } from '@/lib/crossChain/deploycheck';
import { saveResumeStateStrict, loadResumeState, loadGatewayReceipts, type ResumeSessionKey } from '@/lib/crossChain/resumeStore';
import { logPaymentEvent } from '@/lib/paymentLog';
import fees from '../fixtures/cctp/arc-forwarding/fees-6-to-26-sandbox.json';

const account = '0x1111111111111111111111111111111111111111' as Address;
const recipient = '0x2222222222222222222222222222222222222222' as Address;
const hash = `0x${'ab'.repeat(32)}` as Hex;
const { publicClientFor, publicClients, connection, wallet, switchChainAsync, gatewayMint } = vi.hoisted(() => {
  const gatewayMint: { hash?: `0x${string}` } = {};
  const blockHash = `0x${'01'.repeat(32)}` as `0x${string}`;
  const makeClient = (chainId: number) => ({
    chain: { id: chainId },
    getCode: vi.fn().mockResolvedValue('0x6000'),
    readContract: vi.fn().mockResolvedValue(302_400n),
    getBlockNumber: vi.fn().mockResolvedValue(chainId === 84532 ? 1234n : 900000n),
    getTransactionCount: vi.fn().mockResolvedValue(1),
    request: vi.fn(async (a: { method: string; params?: unknown[] }) => a.method === 'eth_call'
      ? `0x${'0'.repeat(63)}${gatewayMint.hash ? '1' : '0'}`
      : { hash: blockHash, number: '0x01', l1BlockNumber: '0x01' }),
    getLogs: vi.fn(async () => gatewayMint.hash ? [{ transactionHash: gatewayMint.hash, blockHash, blockNumber: 1n, removed: false }] : []),
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [] }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: `0x${string}` }) => { gatewayMint.hash = hash; return { status: 'success' }; }),
  });
  const publicClients = new Map<number, ReturnType<typeof makeClient>>();
  const publicClientFor = (chainId: number) => {
    if (!publicClients.has(chainId)) publicClients.set(chainId, makeClient(chainId));
    return publicClients.get(chainId)!;
  };
  const connection = { chainId: 5042002 };
  return {
    gatewayMint, publicClientFor, publicClients, connection,
    wallet: { getChainId: vi.fn(), writeContract: vi.fn(), sendTransaction: vi.fn(), signTypedData: vi.fn() },
    switchChainAsync: vi.fn(),
  };
});
vi.mock('viem', async (actual) => ({ ...await actual<typeof import('viem')>(),
  createPublicClient: vi.fn(({ chain }: { chain: { id: number } }) => publicClientFor(chain.id)) }));
vi.mock('wagmi', () => ({ useAccount: () => ({ address: account }),
  useWalletClient: () => ({ data: { ...wallet, chain: { id: connection.chainId } } }),
  usePublicClient: (options?: { chainId?: number }) => publicClientFor(options?.chainId ?? connection.chainId),
  useSwitchChain: () => ({ switchChainAsync }) }));
vi.mock('@/lib/crossChain/balance', async (actual) => ({ ...await actual<typeof import('@/lib/crossChain/balance')>(), readAllCrossChainBalances: vi.fn() }));
vi.mock('@/lib/crossChain/cctp', async (actual) => ({ ...await actual<typeof import('@/lib/crossChain/cctp')>(), fetchCctpBurnFees: vi.fn(), pollIrisAttestation: vi.fn() }));
vi.mock('@/lib/crossChain/gateway', async (actual) => ({ ...await actual<typeof import('@/lib/crossChain/gateway')>(), requestAttestation: vi.fn() }));
vi.mock('@/lib/crossChain/execute', async (actual) => ({ ...await actual<typeof import('@/lib/crossChain/execute')>(), executeCctpTransfer: vi.fn(), executeGatewayTransfer: vi.fn() }));
vi.mock('@/lib/paymentLog', async (actual) => ({ ...await actual<typeof import('@/lib/paymentLog')>(), logPaymentEvent: vi.fn() }));
const args = { targetChainId: 5042002, requiredAtomic: 1000000n, recipient, feeReceiver: account };
const key: ResumeSessionKey = { account, kind: 'cctp-v2', sourceChainId: 84532, destChainId: 5042002, recipient, valueAtomic: 1000000n, feeAtomic: 0n };
function saved(): CctpResumeState {
  return { burnTxHash: hash, burnIntent: { v: 1, chainId: 84532, amount: '1020632', destinationDomain: 26,
    depositor: account, burnToken: account, mintRecipient: recipient, block: '100', at: 0, nonceLatest: 1, noncePending: 1 },
  forward: { state: 'awaiting-forward', scanFromBlock: '100', acceptedQuote: acceptForwardQuote({ sourceChainId: 84532,
    destChainId: 5042002, sourceDomain: 6, destDomain: 26, recipient, valueAtomic: '1000000' }, fees[0]) } };
}
let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={qc}>{children}</QueryClientProvider>; }
beforeEach(() => {
  publicClients.clear();
  gatewayMint.hash = undefined;
  connection.chainId = 5042002;
  vi.mocked(executeCctpTransfer).mockReset();
  vi.mocked(executeGatewayTransfer).mockReset();
  wallet.getChainId.mockImplementation(async () => connection.chainId);
  switchChainAsync.mockImplementation(async ({ chainId }: { chainId: number }) => { connection.chainId = chainId; });
  __resetContractDeployedCacheForTest();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(env, 'enableUsdcArc', 'get').mockReturnValue(true);
  vi.spyOn(env, 'enableUsdcArcCrossChain', 'get').mockReturnValue(true);
  vi.mocked(fetchCctpBurnFees).mockResolvedValue(fees[0]);
  vi.mocked(readAllCrossChainBalances).mockResolvedValue({ wallet: [{ target: { chainId: 84532, domain: 6, isTestnet: true, role: 'merchant-and-buyer' },
    balance: 3000000n, status: 'ok' }], gateway: { status: 'ok', perDomain: new Map(), total: 0n }, gatewayReadyDomains: new Set() } as never);
});
afterEach(() => { qc.clear(); localStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each([80002, 5042002])('requires explicit option selection for target %s (no auto-execute API)', (targetChainId) => {
  const { result } = renderHook(() => useCrossChainPayment({ ...args, targetChainId, enabled: false }), { wrapper });
  expect(result.current.executeOption).toBeTypeOf('function');
  expect(result.current).not.toHaveProperty('execute');
  expect(executeGatewayTransfer).not.toHaveBeenCalled();
  expect(executeCctpTransfer).not.toHaveBeenCalled();
});

describe.each([false, true])('D9 Gateway committed recovery independent of readiness (flag=%s)', (enabled) => {
  beforeEach(() => vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(enabled));
  const legacyArgs = { ...args, targetChainId: 80002 };
  const merchantAttestation = gatewayAttestation({ ...gatewaySpec, sourceDepositor: pad(account), sourceSigner: pad(account), destinationRecipient: pad(recipient) });

  it.each(BUYER_SOURCE_TARGETS)('restores the committed lock for source $chainId when its readiness probe fails', async (target) => {
    const gatewayKey: ResumeSessionKey = { ...key, kind: 'gateway', sourceChainId: target.chainId, destChainId: legacyArgs.targetChainId };
    saveResumeStateStrict(gatewayKey, { merchantAttestation });
    const source = publicClientFor(target.chainId);
    source.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'withdrawalDelay') throw new Error('Gateway readiness RPC unavailable');
      return 3_000_000n;
    });
    const actual = await vi.importActual<typeof import('@/lib/crossChain/balance')>('@/lib/crossChain/balance');
    vi.mocked(readAllCrossChainBalances).mockImplementation((account) => actual.readAllCrossChainBalances(account, {
      fetch: vi.fn(async () => new Response(JSON.stringify({ balances: [{ domain: target.domain, balance: '3' }] }))),
    }));

    const { result } = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(result.current.isFetchingBalances).toBe(false));

    expect(source.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'withdrawalDelay' }));
    expect(result.current.pathOptions.some((option) => option.kind === 'gateway' && !option.recoveryOnly)).toBe(false);
    expect(result.current.pathOptions).toContainEqual(expect.objectContaining({
      kind: 'gateway', sourceChainId: target.chainId, recoveryOnly: true,
    }));
    expect(result.current.isCommitted).toBe(true);
    expect(loadResumeState(gatewayKey)).toEqual({ merchantAttestation });
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('restores the lock before balances are available, with the query disabled', () => {
    saveResumeStateStrict({ ...key, kind: 'gateway', destChainId: legacyArgs.targetChainId }, { merchantAttestation });
    const { result } = renderHook(() => useCrossChainPayment({ ...legacyArgs, enabled: false }), { wrapper });
    expect(result.current.pathOptions).toEqual([expect.objectContaining({
      kind: 'gateway', sourceChainId: key.sourceChainId, recoveryOnly: true,
    })]);
    expect(result.current.isCommitted).toBe(true);
    expect(readAllCrossChainBalances).not.toHaveBeenCalled();
  });

  it('does not restore another recipient’s payment lock', () => {
    saveResumeStateStrict({ ...key, kind: 'gateway', destChainId: legacyArgs.targetChainId, recipient: account }, { merchantAttestation });
    const { result } = renderHook(() => useCrossChainPayment({ ...legacyArgs, enabled: false }), { wrapper });
    expect(result.current.isCommitted).toBe(false);
  });
});

describe('Gateway rollout preserves saved recovery with the flag OFF', () => {
  const legacyArgs = { ...args, targetChainId: 80002 };
  const gatewayKey: ResumeSessionKey = { ...key, kind: 'gateway', destChainId: 80002 };
  const state = { merchantAttestation: gatewayAttestation({ ...gatewaySpec, sourceDepositor: pad(account), sourceSigner: pad(account), destinationRecipient: pad(recipient) }) };

  beforeEach(async () => {
    connection.chainId = 80002;
    const actual = await vi.importActual<typeof import('@/lib/crossChain/execute')>('@/lib/crossChain/execute');
    vi.mocked(executeGatewayTransfer).mockImplementation(actual.executeGatewayTransfer);
    wallet.sendTransaction.mockResolvedValue(hash);
    saveResumeStateStrict(gatewayKey, state);
  });

  it.each(['empty', 'failed', 'loading'])(
    'exposes and resumes a saved attestation when balances are %s', async (status) => {
      if (status === 'loading') vi.mocked(readAllCrossChainBalances).mockImplementation(() => new Promise(() => {}));
      else if (status === 'failed') vi.mocked(readAllCrossChainBalances).mockRejectedValue(new Error('offline'));
      else vi.mocked(readAllCrossChainBalances).mockResolvedValue({
        wallet: [], gateway: { status: 'ok', depositor: account, total: 0n, perDomain: new Map() }, gatewayReadyDomains: new Set(),
      });
      const { result } = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
      await waitFor(() => expect(result.current.pathOptions.some((o) => o.kind === 'gateway')).toBe(true));
      await waitFor(() => expect(result.current.isCommitted).toBe(true));
      const option = result.current.pathOptions.find((o) => o.kind === 'gateway')!;
      expect(result.current.isOptionResumable(option)).toBe(true);
      await act(async () => { await result.current.executeOption(option); });
      expect(executeGatewayTransfer).toHaveBeenCalledWith(expect.objectContaining({ resume: state }));
      expect(wallet.signTypedData).not.toHaveBeenCalled();
      expect(requestAttestation).not.toHaveBeenCalled();
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
      expect(result.current.result).toMatchObject({ path: 'gateway', mintTxHash: hash });
      expect(loadResumeState(gatewayKey)).toBeUndefined();
      expect(loadGatewayReceipts(account, 80002)[0].state.merchantAttestation).toEqual(state.merchantAttestation);
    },
  );

  it.each(['loading', 'empty', 'failed'])('shows a usable resume button while balances are %s', async (status) => {
    if (status === 'loading') vi.mocked(readAllCrossChainBalances).mockImplementation(() => new Promise(() => {}));
    else if (status === 'failed') vi.mocked(readAllCrossChainBalances).mockRejectedValue(new Error('offline'));
    else vi.mocked(readAllCrossChainBalances).mockResolvedValue({
      wallet: [], gateway: { status: 'ok', depositor: account, total: 0n, perDomain: new Map() }, gatewayReadyDomains: new Set(),
    });
    renderWithIntl(wrapper({ children: <CrossChainHint {...legacyArgs} token="usdc" enabled
      tokenAddress={account} displayDecimals={6} directIsGasless={false} /> }));
    expect(await screen.findByRole('button', { name: '送金状態を再確認' })).toBeEnabled();
    expect(screen.queryByText(/残高: 0/)).not.toBeInTheDocument();
  });

  it('does not reuse recovery for a different invoice amount', async () => {
    const { result } = renderHook(() => useCrossChainPayment({ ...legacyArgs, requiredAtomic: 2_000_000n }), { wrapper });
    await waitFor(() => expect(result.current.isFetchingBalances).toBe(false));
    expect(result.current.pathOptions.some((o) => o.kind === 'gateway')).toBe(false);
  });

  it('rejects a stale Gateway option if its saved attestation has disappeared', async () => {
    const { result } = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(result.current.pathOptions.some((o) => o.kind === 'gateway')).toBe(true));
    const option = result.current.pathOptions.find((o) => o.kind === 'gateway')!;
    localStorage.clear();
    await act(async () => {
      await expect(result.current.executeOption(option)).rejects.toThrow('Gateway cross-chain is disabled');
    });
    expect(executeGatewayTransfer).not.toHaveBeenCalled();
    expect(wallet.signTypedData).not.toHaveBeenCalled();
  });
});

describe('source-chain client routing with the wallet connected to the destination', () => {
  const legacyArgs = { ...args, targetChainId: 80002 };
  const legacyKey = { ...key, destChainId: legacyArgs.targetChainId };
  const burnHash = `0x${'bc'.repeat(32)}` as Hex;
  const mintHash = `0x${'cd'.repeat(32)}` as Hex;

  beforeEach(async () => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
    connection.chainId = legacyArgs.targetChainId;
    const actual = await vi.importActual<typeof import('@/lib/crossChain/execute')>('@/lib/crossChain/execute');
    vi.mocked(executeCctpTransfer).mockImplementation(actual.executeCctpTransfer);
    vi.mocked(executeGatewayTransfer).mockImplementation(actual.executeGatewayTransfer);
    wallet.writeContract.mockResolvedValue(hash);
    wallet.sendTransaction.mockImplementation(async ({ chain }: { chain: { id: number } }) =>
      chain.id === legacyKey.sourceChainId ? burnHash : mintHash);
    wallet.signTypedData.mockResolvedValue(hash);
    vi.mocked(pollIrisAttestation).mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' });
    vi.mocked(requestAttestation).mockImplementation(async ({ burnIntent }) => gatewayAttestation(burnIntent.spec, 1_000_000n));
    vi.mocked(readAllCrossChainBalances).mockResolvedValue({
      wallet: [{ target: { chainId: 84532, domain: 6, isTestnet: true, role: 'merchant-and-buyer' },
        balance: 3000000n, status: 'ok' }],
      gateway: { status: 'ok', perDomain: new Map([[6, 3000000n]]), total: 3000000n },
      gatewayReadyDomains: new Set([6]),
    } as never);
  });

  it.each(['cctp-v2', 'gateway'] as const)('rejects a missing source chain definition before constructing the %s client or executing', async (kind) => {
    vi.spyOn(chains, 'chainObjectForId').mockReturnValue(undefined);
    const { result } = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(result.current.pathOptions.some((o) => o.kind === kind)).toBe(true));

    await act(async () => {
      await expect(result.current.executeOption(result.current.pathOptions.find((o) => o.kind === kind)!))
        .rejects.toThrow(`Unsupported source chainId ${legacyKey.sourceChainId}`);
    });

    expect(createPublicClient).not.toHaveBeenCalled();
    expect(executeCctpTransfer).not.toHaveBeenCalled();
    expect(executeGatewayTransfer).not.toHaveBeenCalled();
    expect(switchChainAsync).not.toHaveBeenCalled();
  });

  it('reads legacy CCTP approval and burn receipts on the selected source, then the mint on the destination', async () => {
    const source = publicClientFor(legacyKey.sourceChainId);
    const dest = publicClientFor(legacyArgs.targetChainId);
    const { result } = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(result.current.pathOptions.some((o) => o.kind === 'cctp-v2')).toBe(true));
    const option = result.current.pathOptions.find((o) => o.kind === 'cctp-v2')!;

    await act(async () => { await result.current.executeOption(option); });

    expect(source.waitForTransactionReceipt).toHaveBeenNthCalledWith(1, { hash });
    expect(source.waitForTransactionReceipt).toHaveBeenNthCalledWith(2, { hash: burnHash });
    expect(dest.waitForTransactionReceipt.mock.calls).toEqual([[{ hash: mintHash }]]);
    expect(wallet.writeContract).toHaveBeenCalledWith(expect.objectContaining({ chain: expect.objectContaining({ id: 84532 }) }));
    expect(result.current.result).toMatchObject({ path: 'cctp-v2', burnTxHash: burnHash, mintTxHash: mintHash });
  });

  it('reconciles a persisted burn receipt on the source without approving or burning again', async () => {
    saveResumeStateStrict(legacyKey, { approveTxHash: hash, burnTxHash: burnHash });
    const source = publicClientFor(legacyKey.sourceChainId);
    const dest = publicClientFor(legacyArgs.targetChainId);
    dest.getTransactionReceipt.mockRejectedValue(Object.assign(new Error('not on destination'), { name: 'TransactionReceiptNotFoundError' }));
    const { result } = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(result.current.pathOptions.some((o) => o.kind === 'cctp-v2')).toBe(true));

    await act(async () => { await result.current.executeOption(result.current.pathOptions.find((o) => o.kind === 'cctp-v2')!); });

    expect(source.getTransactionReceipt.mock.calls).toEqual([[{ hash: burnHash }]]);
    expect(dest.getTransactionReceipt).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
    expect(wallet.sendTransaction.mock.calls).toEqual([[expect.objectContaining({ chain: expect.objectContaining({ id: legacyArgs.targetChainId }) })]]);
    expect(loadResumeState(legacyKey)).toBeUndefined();
  });

  it('probes a persisted unresolved burn using source nonces, height and logs before switching the wallet', async () => {
    const marker = { ...saved().burnIntent!, amount: '1000000', destinationDomain: 7, block: '1200', at: Date.now() };
    saveResumeStateStrict(legacyKey, { burnIntent: marker, burnTxHash: burnHash });
    const source = publicClientFor(legacyKey.sourceChainId);
    const dest = publicClientFor(legacyArgs.targetChainId);
    source.getTransactionReceipt.mockRejectedValue(Object.assign(new Error('not mined'), { name: 'TransactionReceiptNotFoundError' }));
    dest.getTransactionReceipt.mockRejectedValue(Object.assign(new Error('not on destination'), { name: 'TransactionReceiptNotFoundError' }));
    const { result } = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(result.current.pathOptions.some((o) => o.kind === 'cctp-v2')).toBe(true));

    await act(async () => {
      await expect(result.current.executeOption(result.current.pathOptions.find((o) => o.kind === 'cctp-v2')!)).rejects.toBeInstanceOf(CrossChainBurnUnresolvedError);
    });

    expect(source.getTransactionReceipt).toHaveBeenCalledWith({ hash: burnHash });
    expect(source.getTransactionCount).toHaveBeenCalledWith({ address: account, blockTag: 'pending' });
    expect(source.getTransactionCount).toHaveBeenCalledWith({ address: account, blockTag: 'latest' });
    expect(source.getBlockNumber).toHaveBeenCalledOnce();
    expect(source.getLogs).toHaveBeenCalledWith(expect.objectContaining({ toBlock: 1234n }));
    expect(dest.getTransactionReceipt).not.toHaveBeenCalled();
    expect(dest.getTransactionCount).not.toHaveBeenCalled();
    expect(dest.getBlockNumber).not.toHaveBeenCalled();
    expect(dest.getLogs).not.toHaveBeenCalled();
    expect(switchChainAsync).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(loadResumeState(legacyKey)).toMatchObject({ burnIntent: marker, burnTxHash: burnHash });

    // Manual hash adoption is also source-scoped while the wallet stays on the destination.
    source.getTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    await act(async () => { expect(await result.current.adoptBurnTxHash(burnHash)).toEqual({ ok: false, reason: 'reverted' }); });
    expect(source.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(dest.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('builds the Gateway burn intent from the selected source height', async () => {
    const source = publicClientFor(legacyKey.sourceChainId);
    const dest = publicClientFor(legacyArgs.targetChainId);
    const { result } = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(result.current.pathOptions.some((o) => o.kind === 'gateway')).toBe(true));

    await act(async () => { await result.current.executeOption(result.current.pathOptions.find((o) => o.kind === 'gateway')!); });

    expect(source.getBlockNumber).toHaveBeenCalledOnce();
    expect(source.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'withdrawalDelay' }));
    expect(dest.readContract).not.toHaveBeenCalled();
    expect(dest.getBlockNumber).not.toHaveBeenCalled();
    expect(wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ maxBlockHeight: 1234n + 302_400n + 30_240n }),
    }));
    expect(dest.waitForTransactionReceipt.mock.calls).toEqual([[{ hash: mintHash }]]);
    expect(result.current.result).toMatchObject({ path: 'gateway', mintTxHash: mintHash });
  });

  it.each(['cctp-v2', 'gateway'] as const)('keeps the %s executor on the source client across a wallet-switch rerender and reuses it', async (kind) => {
    const source = publicClientFor(legacyKey.sourceChainId);
    const { result, rerender } = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(result.current.pathOptions.some((o) => o.kind === kind)).toBe(true));
    const option = result.current.pathOptions.find((o) => o.kind === kind)!;
    const executor = kind === 'gateway' ? executeGatewayTransfer : executeCctpTransfer;
    let release!: (value: Hex) => void;
    const walletPrompt = new Promise<Hex>((resolve) => { release = resolve; });
    const prompt = kind === 'gateway' ? wallet.signTypedData : wallet.writeContract;
    prompt.mockReturnValueOnce(walletPrompt);
    let execution!: Promise<unknown>;
    await act(async () => { execution = result.current.executeOption(option); });
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(connection.chainId).toBe(legacyKey.sourceChainId);

    rerender();
    const capturedClient = vi.mocked(executor).mock.calls[0][0].sourcePublicClient;
    await act(async () => { release(hash); await execution; });

    expect(capturedClient).toBe(source);
    expect(vi.mocked(executor).mock.calls[0][0].sourcePublicClient).toBe(capturedClient);
    expect(kind === 'gateway' ? source.getBlockNumber : source.waitForTransactionReceipt).toHaveBeenCalled();
    rerender();
    await act(async () => { await result.current.executeOption(option); });
    expect(vi.mocked(executor).mock.calls[1][0].sourcePublicClient).toBe(capturedClient);
    expect(vi.mocked(createPublicClient).mock.calls).toEqual([[expect.objectContaining({ chain: expect.objectContaining({ id: legacyKey.sourceChainId }) })]]);
  });
});

describe('Arc hook recovery and authorization', () => {
  it('mount scan is independent of disabled queries, balances, options and flag OFF', async () => {
    saveResumeStateStrict(key, saved());
    vi.spyOn(env, 'enableUsdcArcCrossChain', 'get').mockReturnValue(false);
    const { result } = renderHook(() => useCrossChainPayment({ ...args, enabled: false }), { wrapper });
    await waitFor(() => expect(result.current.pendingRecovery?.kind).toBe('pending'));
    expect(result.current.pathOptions).toEqual([]); expect(readAllCrossChainBalances).not.toHaveBeenCalled();
    expect(result.current).not.toHaveProperty('execute');
  });
  it('scans all buyer sources, including sources missing from balances', async () => {
    const state = saved(); state.burnIntent!.chainId = 998;
    state.forward!.acceptedQuote = { ...state.forward!.acceptedQuote, sourceChainId: 998, sourceDomain: 19 };
    saveResumeStateStrict({ ...key, sourceChainId: 998 }, state);
    const { result } = renderHook(() => useCrossChainPayment(args), { wrapper });
    await waitFor(() => expect(result.current.pendingRecovery?.sourceChainId).toBe(998));
    expect(fetchCctpBurnFees).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.pathOptions).toHaveLength(1));
    await act(async () => { await expect(result.current.executeOption(result.current.pathOptions[0])).rejects.toThrow('unavailable'); });
    expect(result.current.pendingRecovery?.sourceChainId).toBe(998);
    expect(executeCctpTransfer).not.toHaveBeenCalled();
  });
  it('unreadable entry blocks new execution without clearing the lock', async () => {
    saveResumeStateStrict(key, saved()); localStorage.setItem(localStorage.key(0)!, '{invalid');
    const { result } = renderHook(() => useCrossChainPayment(args), { wrapper });
    await waitFor(() => expect(result.current.pendingRecovery?.kind).toBe('unreadable'));
    await waitFor(() => expect(result.current.pathOptions).toHaveLength(1));
    await act(async () => { await expect(result.current.executeOption(result.current.pathOptions[0])).rejects.toThrow('unavailable'); });
    expect(executeCctpTransfer).not.toHaveBeenCalled(); expect(result.current.pendingRecovery?.kind).toBe('unreadable');
  });
  it('rejects forged and stale options before state reset; binds quote to payment', async () => {
    const { result, rerender } = renderHook((amount) => useCrossChainPayment({ ...args, requiredAtomic: amount }), { initialProps: 1000000n, wrapper });
    await waitFor(() => expect(result.current.pathOptions[0]?.acceptedQuote).toBeDefined());
    const original = result.current.pathOptions[0];
    await act(async () => { await expect(result.current.executeOption({ ...original })).rejects.toThrow('unavailable'); });
    rerender(2000000n);
    await act(async () => { await expect(result.current.executeOption(original)).rejects.toThrow(); });
    expect(executeCctpTransfer).not.toHaveBeenCalled();
  });
  it.each(['recipient', 'valueAtomic', 'sourceChainId', 'destChainId'] as const)('rejects current option whose quote has mismatched %s', async (field) => {
    const { result } = renderHook(() => useCrossChainPayment(args), { wrapper });
    await waitFor(() => expect(result.current.pathOptions[0]?.acceptedQuote).toBeDefined());
    const option = result.current.pathOptions[0];
    option.acceptedQuote = { ...option.acceptedQuote!, [field]: field === 'recipient' ? account : field === 'valueAtomic' ? '1' : 1 };
    await act(async () => { await expect(result.current.executeOption(option)).rejects.toThrow('binding'); });
    expect(executeCctpTransfer).not.toHaveBeenCalled();
  });
  it('verified but interrupted record remains recoverable and cleans up after accounting', async () => {
    const state = saved(); state.forward!.state = 'verified'; state.mintTxHash = hash;
    saveResumeStateStrict(key, state);
    vi.mocked(executeCctpTransfer).mockImplementation(async (a) => {
      a.onStep?.(state);
      a.onMerchantMint?.({ mintTxHash: hash, burnTxHash: hash, forward: { grossAtomic: '1020632', maxFeeAtomic: '20632', verifiedNetAtomic: '1000632', feeCollectedAtomic: '20000' } });
      return { path: 'cctp-v2', approveTxHash: hash, burnTxHash: hash, mintTxHash: hash, destChainId: 5042002 };
    });
    const { result } = renderHook(() => useCrossChainPayment(args), { wrapper });
    await waitFor(() => expect(result.current.pendingRecovery?.state?.forward?.state).toBe('verified'));
    expect(fetchCctpBurnFees).not.toHaveBeenCalled();
    await act(async () => { await result.current.recheckForward(); });
    expect(logPaymentEvent).toHaveBeenCalledTimes(1); expect(loadResumeState(key)).toBeUndefined();
  });
  it('selected source client + accepted quote; atomic commit and actual cap accounting', async () => {
    const { result } = renderHook(() => useCrossChainPayment(args), { wrapper });
    await waitFor(() => expect(result.current.pathOptions[0]?.acceptedQuote).toBeDefined());
    const option = result.current.pathOptions[0];
    vi.mocked(executeCctpTransfer).mockImplementation(async (a) => {
      expect(a.sourcePublicClient).toBe(publicClientFor(option.sourceChainId));
      expect(a.destPublicClient).toBe(publicClientFor(args.targetChainId));
      expect(a.forward?.acceptedQuote).toBe(option.acceptedQuote);
      const state = saved(); state.forward!.acceptedQuote = a.forward!.acceptedQuote;
      a.commitBurnIntent(state.burnIntent!, 'merchant', { forward: { ...state.forward!, state: 'intent' } });
      expect(loadResumeState<CctpResumeState>(key)).toMatchObject({ burnIntent: state.burnIntent, forward: { acceptedQuote: option.acceptedQuote } });
      state.forward!.state = 'verified'; state.mintTxHash = hash; a.onStep?.(state);
      a.onMerchantMint?.({ mintTxHash: hash, burnTxHash: hash, forward: { grossAtomic: '1020632', maxFeeAtomic: '20632', verifiedNetAtomic: '1000632', feeCollectedAtomic: '20000' } });
      return { path: 'cctp-v2', approveTxHash: hash, burnTxHash: hash, mintTxHash: hash, destChainId: 5042002 };
    });
    await act(async () => { await result.current.executeOption(option); });
    expect(createPublicClient).toHaveBeenCalledWith(expect.objectContaining({ chain: expect.objectContaining({ id: 84532 }) }));
    expect(logPaymentEvent).toHaveBeenCalledWith(expect.objectContaining({ bridgeFeeMax: '20632', bridgedAmount: '1020632', merchantAmount: '1000632', saleAmount: '1000000' }));
    expect(loadResumeState(key)).toBeUndefined();
  });
  it('rejects competing execution synchronously without unlocking an in-flight attempt', async () => {
    const { result } = renderHook(() => useCrossChainPayment(args), { wrapper });
    await waitFor(() => expect(result.current.pathOptions[0]?.acceptedQuote).toBeDefined());
    const option = result.current.pathOptions[0]; let finish!: () => void;
    vi.mocked(executeCctpTransfer).mockImplementation(() => new Promise((_resolve, reject) => { finish = () => reject(new Error('pending')); }));
    let first!: Promise<unknown>;
    await act(async () => { first = result.current.executeOption(option).catch(() => {}); });
    await act(async () => { await expect(result.current.executeOption(option)).rejects.toThrow('already running'); });
    expect(result.current.isExecuting).toBe(true); expect(executeCctpTransfer).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await first; });
  });
  it('post-confirmation recheck uses saved quote with no quote fetch when flag OFF', async () => {
    const state = saved(); saveResumeStateStrict(key, state);
    vi.spyOn(env, 'enableUsdcArcCrossChain', 'get').mockReturnValue(false);
    vi.mocked(executeCctpTransfer).mockImplementation(async (a) => {
      expect(a.sourcePublicClient).toBe(publicClientFor(key.sourceChainId));
      expect(a.forward).toEqual({ acceptedQuote: state.forward!.acceptedQuote, allowBurn: false });
      throw new Error('still pending');
    });
    const { result } = renderHook(() => useCrossChainPayment({ ...args, enabled: false }), { wrapper });
    await waitFor(() => expect(result.current.pendingRecovery?.kind).toBe('pending'));
    await act(async () => { await result.current.recheckForward(); });
    expect(fetchCctpBurnFees).not.toHaveBeenCalled(); expect(loadResumeState(key)).toBeDefined();
  });
  it('expired quote is discarded and refreshed on the same route key', async () => {
    const { result } = renderHook(() => useCrossChainPayment(args), { wrapper });
    await waitFor(() => expect(result.current.pathOptions[0]?.acceptedQuote).toBeDefined());
    const old = result.current.pathOptions[0];
    vi.mocked(executeCctpTransfer).mockRejectedValue(new CrossChainQuoteExpiredError());
    await act(async () => { await expect(result.current.executeOption(old)).rejects.toThrow(); });
    await waitFor(() => expect(result.current.pathOptions[0]?.acceptedQuote).toBeDefined());
    expect(result.current.pathOptions[0].key).toBe(old.key);
    expect(result.current.pathOptions[0].acceptedQuote).not.toBe(old.acceptedQuote);
  });
  it('recovery panel precedes enabled/empty exits and propagates parent lock', async () => {
    saveResumeStateStrict(key, saved());
    vi.spyOn(env, 'enableUsdcArcCrossChain', 'get').mockReturnValue(false);
    const onExecutingChange = vi.fn();
    renderWithIntl(<QueryClientProvider client={qc}><CrossChainHint {...args} token="usdc" enabled={false}
      displayDecimals={6} tokenAddress={account} directIsGasless={false} onExecutingChange={onExecutingChange} /></QueryClientProvider>);
    await screen.findByText('前回の Arc 支払いを確認');
    expect(onExecutingChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('Circle の応答待ちです。nonce 未取得のため宛先探索はまだできません。')).toBeInTheDocument();
  });
});

describe('X12 Gateway reload and parent lock', () => {
  const legacyArgs = { ...args, targetChainId: 80002 };
  const gatewayKey: ResumeSessionKey = { ...key, kind: 'gateway', destChainId: 80002 };
  const att = gatewayAttestation({ ...gatewaySpec, sourceDepositor: pad(account), sourceSigner: pad(account), destinationRecipient: pad(recipient) });
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/lib/crossChain/execute')>('@/lib/crossChain/execute');
    vi.mocked(executeGatewayTransfer).mockImplementation(actual.executeGatewayTransfer);
    vi.mocked(readAllCrossChainBalances).mockRejectedValue(new Error('discovery offline'));
    saveResumeStateStrict(gatewayKey, { merchantAttestation: att });
  });
  it.each(['expired-funded', 'rpc-failed', 'balance-failed'])('rechecks %s without signing; reload never trusts old replacement eligibility', async (scenario) => {
    const dest = publicClientFor(80002);
    dest.request.mockImplementation(async (a) => a.method === 'eth_call' ? pad('0x00') : { hash, number: '0x65', l1BlockNumber: '0x65' });
    if (scenario === 'rpc-failed') dest.request.mockRejectedValue(new Error('RPC down'));
    vi.stubGlobal('fetch', vi.fn(async () => scenario === 'balance-failed' ? new Response('offline', { status: 503 }) :
      new Response(JSON.stringify({ balances: [{ domain: 6, balance: '2' }] }))));
    const h = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(h.result.current.isCommitted).toBe(true));
    await act(async () => { await h.result.current.recheckGateway(); });
    expect(h.result.current.isCommitted).toBe(scenario !== 'expired-funded');
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    h.unmount();
    const reloaded = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(reloaded.result.current.isCommitted).toBe(true));
    expect(reloaded.result.current.gatewayRecovery?.kind).toBe('pending');
  });
  it('S-A: interrupted paid without completion stays locked, shows paid, and completes on recheck', async () => {
    const { decodeGatewayAttestation } = await import('@/lib/crossChain/gatewayAttestation');
    const d = decodeGatewayAttestation(att.attestation);
    saveResumeStateStrict(gatewayKey, { merchantAttestation: att, merchant: { attempts: [{
      transferSpecHash: d.transferSpecHash, spec: { ...d.spec, value: String(d.spec.value) }, attestation: att,
      maxBlockHeight: String(d.maxBlockHeight), status: 'paid', txHashes: [],
      observations: [{ status: 'paid', used: true, blockHash: hash, blockNumber: '101', height: '101' }],
    }] } });
    gatewayMint.hash = hash;
    const onSuccess = vi.fn(); const onExecutingChange = vi.fn();
    renderWithIntl(wrapper({ children: <CrossChainHint {...legacyArgs} enabled={false} token="usdc" tokenAddress={account}
      displayDecimals={6} directIsGasless={false} onSuccess={onSuccess} onExecutingChange={onExecutingChange} /> }));
    expect(await screen.findByText('送金は確定しています。取引の詳細を再取得できます。追加の支払いは不要です。')).toBeInTheDocument();
    expect(onExecutingChange).toHaveBeenLastCalledWith(true);
    expect(onSuccess).not.toHaveBeenCalled();
    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(screen.getByRole('button', { name: '送金状態を再確認' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(loadResumeState(gatewayKey)).toBeUndefined();
    expect(wallet.signTypedData).not.toHaveBeenCalled(); expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it.each(['expired', 'crossChain=false'])('S-B: refuses a new authorization for %s but allows existing recovery', async () => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
    const h = renderHook(() => useCrossChainPayment({ ...legacyArgs, enabled: false }), { wrapper });
    await waitFor(() => expect(h.result.current.isCommitted).toBe(true));
    const { decodeGatewayAttestation } = await import('@/lib/crossChain/gatewayAttestation');
    await act(async () => { await h.result.current.recheckGateway({ merchant: decodeGatewayAttestation(att.attestation).transferSpecHash }, 84532, false); });
    expect(executeGatewayTransfer).not.toHaveBeenCalled();
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    gatewayMint.hash = hash;
    await act(async () => { await h.result.current.recheckGateway(undefined, 84532, false); });
    expect(h.result.current.result?.path).toBe('gateway');
    expect(wallet.signTypedData).not.toHaveBeenCalled(); expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it.each(['malformed', 'read-error', 'scan-error'])('holds the lock and shows recovery for %s storage', async (scenario) => {
    if (scenario === 'malformed') localStorage.setItem(localStorage.key(0)!, '{broken');
    if (scenario === 'read-error') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    if (scenario === 'scan-error') vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new Error('denied'); });
    const h = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
    await waitFor(() => expect(h.result.current.gatewayRecovery?.kind).toBe('unreadable'));
    expect(h.result.current.isCommitted).toBe(true);
    await act(async () => { await h.result.current.recheckGateway(); });
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('shows hashless success with flags disabled and no explorer transaction link', async () => {
    const dest = publicClientFor(80002);
    dest.request.mockImplementation(async (a) => a.method === 'eth_call' ? pad('0x01') : { hash, number: '0x65', l1BlockNumber: '0x65' });
    dest.getLogs.mockRejectedValue(new Error('archive unavailable'));
    const onSuccess = vi.fn();
    renderWithIntl(wrapper({ children: <CrossChainHint {...legacyArgs} token="usdc" enabled={false}
      tokenAddress={account} displayDecimals={6} directIsGasless={false} onSuccess={onSuccess} /> }));
    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(await screen.findByRole('button', { name: '送金状態を再確認' }));
    expect(await screen.findByText(/Circle Gateway 経由で着金しました/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Explorer/ })).not.toBeInTheDocument();
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ settlement: 'hashless', transferSpecHash: expect.any(String) }));
    expect(wallet.signTypedData).not.toHaveBeenCalled();
  });
});

it('X12 does not unlock or replace one source while another persisted source remains unresolved', async () => {
  const actual = await vi.importActual<typeof import('@/lib/crossChain/execute')>('@/lib/crossChain/execute');
  vi.mocked(executeGatewayTransfer).mockImplementation(actual.executeGatewayTransfer);
  const { resolveDeployment } = await import('@/lib/tokens');
  const att = gatewayAttestation({ ...gatewaySpec, sourceDepositor: pad(account), sourceSigner: pad(account), destinationRecipient: pad(recipient) });
  const firstKey: ResumeSessionKey = { ...key, kind: 'gateway', destChainId: 80002 };
  saveResumeStateStrict(firstKey, { merchantAttestation: att });
  saveResumeStateStrict({ ...firstKey, sourceChainId: 11155420 }, { merchantAttestation: gatewayAttestation({ ...gatewaySpec,
    sourceDomain: 2, sourceToken: pad(resolveDeployment('usdc', 11155420)!.address),
    sourceDepositor: pad(account), sourceSigner: pad(account), destinationRecipient: pad(recipient) }) });
  const dest = publicClientFor(80002);
  dest.request.mockImplementation(async (a) => a.method === 'eth_call' ? pad('0x00') : { hash, number: '0x65', l1BlockNumber: '0x65' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ balances: [{ domain: 6, balance: '2' }] }))));
  const h = renderHook(() => useCrossChainPayment({ ...args, targetChainId: 80002 }), { wrapper });
  await waitFor(() => expect(h.result.current.gatewayRecovery?.entries).toHaveLength(2));
  await act(async () => { await h.result.current.recheckGateway(undefined, 84532); });
  expect(h.result.current.isCommitted).toBe(true);
  const current = h.result.current.gatewayRecovery!;
  expect(current.replacementAllowed).toBe(false);
  await act(async () => {
    await expect(h.result.current.executeOption({ kind: 'direct', key: 'direct' } as never)).rejects.toThrow('Gateway recovery pending');
    await expect(h.result.current.executeOption({ kind: 'gateway', key: 'gateway-0', sourceChainId: 11155111, sourceDomain: 0 } as never)).rejects.toThrow('Gateway recovery pending');
  });
  const specHash = current.state!.merchant!.attempts[0].transferSpecHash;
  await act(async () => { await h.result.current.recheckGateway({ merchant: specHash }, 84532, true); });
  expect(wallet.signTypedData).not.toHaveBeenCalled();
  expect(wallet.sendTransaction).not.toHaveBeenCalled();
  // After independently rechecking the second source with its own domain balance, both can release.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ balances: [{ domain: 2, balance: '2' }] }))));
  await act(async () => { await h.result.current.recheckGateway(undefined, 11155420); });
  expect(h.result.current.isCommitted).toBe(false);
  expect(h.result.current.gatewayRecovery?.replacementAllowed).toBe(true);
  expect(wallet.signTypedData).not.toHaveBeenCalled();
});


describe('review B1/S1: completed receipts are independent of the next invoice', () => {
  const gatewayArgs = { ...args, targetChainId: 80002, enabled: false };
  const gatewayKey: ResumeSessionKey = { ...key, kind: 'gateway', destChainId: 80002 };
  const option = { key: 'gateway-6', kind: 'gateway' as const, sourceChainId: 84532, sourceDomain: 6 as const,
    sourceBalanceAtomic: 3_000_000n, serviceFeeAtomic: 1000n, estimatedGasUnits: 150000n, gasOnChainId: 80002, etaSeconds: 5 };
  beforeEach(async () => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
    const actual = await vi.importActual<typeof import('@/lib/crossChain/execute')>('@/lib/crossChain/execute');
    vi.mocked(executeGatewayTransfer).mockImplementation(actual.executeGatewayTransfer);
    wallet.signTypedData.mockResolvedValue(hash); wallet.sendTransaction.mockResolvedValue(hash);
    vi.mocked(requestAttestation).mockImplementation(async ({ burnIntent }) => gatewayAttestation(burnIntent.spec, 1000n));
  });
  it('B1: success -> remount has no lock/panel/replayed success and allows a second same-amount payment', async () => {
    const first = renderHook(() => useCrossChainPayment(gatewayArgs), { wrapper });
    await act(async () => { await first.result.current.executeOption(option); });
    const firstIdentity = first.result.current.result;
    expect(firstIdentity?.path).toBe('gateway');
    expect(loadResumeState(gatewayKey)).toBeUndefined();
    expect(loadGatewayReceipts(account, 80002)).toHaveLength(1);
    first.unmount();
    const second = renderHook(() => useCrossChainPayment(gatewayArgs), { wrapper });
    expect(second.result.current.isCommitted).toBe(false);
    expect(second.result.current.gatewayRecovery).toBeUndefined();
    const onSuccess = vi.fn();
    const panel = renderWithIntl(wrapper({ children: <CrossChainHint {...gatewayArgs} token="usdc" tokenAddress={account}
      displayDecimals={6} directIsGasless={false} onSuccess={onSuccess} /> }));
    expect(screen.queryByRole('button', { name: '送金状態を再確認' })).not.toBeInTheDocument();
    wallet.signTypedData.mockClear();
    await act(async () => { await second.result.current.recheckGateway(); });
    expect(second.result.current.result).toBeUndefined();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    panel.unmount(); gatewayMint.hash = undefined;
    await act(async () => { await second.result.current.executeOption(option); });
    expect(wallet.signTypedData).toHaveBeenCalledOnce();
    expect(second.result.current.result).not.toEqual(firstIdentity);
    expect(loadGatewayReceipts(account, 80002)).toHaveLength(2);
  });
  it('S1: immediate success/accounting, automatic finalized settlement, and no lock on another amount', async () => {
    vi.useFakeTimers();
    try {
      let finalized = false; const latest = pad('0x02'); const old = pad('0x01');
      const dest = publicClientFor(80002);
      dest.request.mockImplementation(async (a) => {
        if (a.method === 'eth_call') return pad(gatewayMint.hash && (finalized || (a.params?.[1] as { blockHash: Hex }).blockHash === latest) ? '0x01' : '0x00');
        return a.params?.[0] === 'latest' || a.params?.[0] === '0x2' || finalized
          ? { number: '0x02', hash: latest, l1BlockNumber: '0x02' } : { number: '0x01', hash: old, l1BlockNumber: '0x01' };
      });
      const h = renderHook((props) => useCrossChainPayment(props), { wrapper, initialProps: gatewayArgs });
      await act(async () => { await h.result.current.executeOption(option); });
      expect(h.result.current.result).toMatchObject({ settlement: 'transaction', mintTxHash: hash });
      expect(logPaymentEvent).toHaveBeenCalledOnce();
      expect(loadGatewayReceipts(account, 80002)).toHaveLength(0);
      expect(loadResumeState(gatewayKey)).toMatchObject({ completion: 'confirming' });
      const sameInvoice = renderHook(() => useCrossChainPayment(gatewayArgs), { wrapper });
      expect(sameInvoice.result.current.isCommitted).toBe(true);
      wallet.signTypedData.mockClear(); wallet.sendTransaction.mockClear();
      await act(async () => { await sameInvoice.result.current.recheckGateway(); });
      expect(sameInvoice.result.current.result).toBeUndefined();
      expect(wallet.signTypedData).not.toHaveBeenCalled();
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
      sameInvoice.unmount();
      h.rerender({ ...gatewayArgs, requiredAtomic: 2_000_000n });
      expect(h.result.current.isCommitted).toBe(false);
      expect(h.result.current.gatewayRecovery).toBeUndefined();
      expect(h.result.current.result).toBeUndefined();
      wallet.signTypedData.mockClear(); wallet.sendTransaction.mockClear();
      // Let the in-flight old snapshot finish before advancing the fixture's finalized head.
      await act(async () => {});
      finalized = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(loadGatewayReceipts(account, 80002)[0].state.completion).toBe('settled');
      expect(h.result.current.result).toBeUndefined();
      expect(logPaymentEvent).toHaveBeenCalledOnce();
      expect(wallet.signTypedData).not.toHaveBeenCalled();
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
      h.unmount();
    } finally { vi.useRealTimers(); }
  });
  it('B2: rejecting a fresh signature releases the parent lock and permits Pay again', async () => {
    wallet.signTypedData.mockRejectedValueOnce(new Error('User rejected'));
    const h = renderHook(() => useCrossChainPayment(gatewayArgs), { wrapper });
    await act(async () => { await expect(h.result.current.executeOption(option)).rejects.toThrow('User rejected'); });
    expect(h.result.current.isCommitted).toBe(false);
    expect(h.result.current.gatewayRecovery).toBeUndefined();
    wallet.signTypedData.mockClear();
    await act(async () => { await h.result.current.recheckGateway(); });
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    await act(async () => { await h.result.current.executeOption(option); });
    expect(wallet.signTypedData).toHaveBeenCalledOnce();
    expect(h.result.current.result?.path).toBe('gateway');
  });
});


it('backfills a settled hashless payer receipt on remount without a panel, lock, signing, or onSuccess', async () => {
  const { appendPayerReceipt, buildPayerReceipt, loadPayerReceipts } = await import('@/lib/payerReceipt');
  const actual = await vi.importActual<typeof import('@/lib/crossChain/execute')>('@/lib/crossChain/execute');
  vi.mocked(executeGatewayTransfer).mockImplementation(actual.executeGatewayTransfer);
  const legacyArgs = { ...args, targetChainId: 80002, enabled: false };
  const { decodeGatewayAttestation } = await import('@/lib/crossChain/gatewayAttestation');
  const attestation = gatewayAttestation({ ...gatewaySpec, sourceDepositor: pad(account), sourceSigner: pad(account), destinationRecipient: pad(recipient) });
  const d = decodeGatewayAttestation(attestation.attestation);
  saveResumeStateStrict({ ...key, kind: 'gateway', destChainId: 80002 }, { merchant: { attempts: [{
    transferSpecHash: d.transferSpecHash, spec: { ...d.spec, value: String(d.spec.value) }, attestation,
    receiptScanFrom: '0', maxBlockHeight: String(d.maxBlockHeight), status: 'unknown', txHashes: [], observations: [],
  }] } });
  const dest = publicClientFor(80002);
  gatewayMint.hash = hash;
  dest.getLogs.mockRejectedValue(new Error('archive unavailable'));
  const h = renderHook(() => useCrossChainPayment(legacyArgs), { wrapper });
  await act(async () => { await h.result.current.recheckGateway(); });
  const completed = h.result.current.result;
  expect(completed).toMatchObject({ settlement: 'hashless' });
  if (completed?.path !== 'gateway') throw new Error('Expected Gateway completion');
  appendPayerReceipt(buildPayerReceipt({ chainId: 80002, asset: 'usdc', amount: '1', merchantAddress: recipient,
    gatewayTransferSpecHash: completed.transferSpecHash }));
  h.unmount();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25000);
  dest.getLogs.mockResolvedValue([{ transactionHash: hash, blockHash: `0x${'01'.repeat(32)}`, blockNumber: 1n, removed: false }]);
  const onSuccess = vi.fn();
  renderWithIntl(wrapper({ children: <CrossChainHint {...legacyArgs} token="usdc" tokenAddress={account}
    displayDecimals={6} directIsGasless={false} onSuccess={onSuccess} /> }));
  await waitFor(() => expect(loadPayerReceipts()[0].txHash).toBe(hash));
  expect(loadPayerReceipts()).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '送金状態を再確認' })).not.toBeInTheDocument();
  expect(onSuccess).not.toHaveBeenCalled();
  expect(logPaymentEvent).toHaveBeenCalledOnce();
  expect(wallet.signTypedData).not.toHaveBeenCalled();
  expect(wallet.sendTransaction).not.toHaveBeenCalled();
});


it('Gateway scope changes preserve the existing CCTP completion and commitment', async () => {
  const completed = { path: 'cctp-v2' as const, mintTxHash: hash, burnTxHash: hash, destChainId: 80002 };
  vi.mocked(executeCctpTransfer).mockImplementation(async (input) => {
    input.onStep?.({ burnTxHash: hash });
    return completed as never;
  });
  const legacyArgs = { ...args, targetChainId: 80002, enabled: false };
  const h = renderHook((props) => useCrossChainPayment(props), { wrapper, initialProps: legacyArgs });
  await act(async () => { await h.result.current.executeOption({ kind: 'cctp-v2', key: 'cctp-v2-6', sourceChainId: 84532, sourceDomain: 6 } as never); });
  expect(h.result.current.isCommitted).toBe(true);
  h.rerender({ ...legacyArgs, requiredAtomic: 2_000_000n });
  expect(h.result.current.result).toEqual(completed);
  expect(h.result.current.isCommitted).toBe(true);
});
