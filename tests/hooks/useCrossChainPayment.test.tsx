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
import { defaultBlockHeightOffset, requestAttestation } from '@/lib/crossChain/gateway';
import { __resetContractDeployedCacheForTest } from '@/lib/crossChain/deploycheck';
import { saveResumeStateStrict, loadResumeState, type ResumeSessionKey } from '@/lib/crossChain/resumeStore';
import { logPaymentEvent } from '@/lib/paymentLog';
import fees from '../fixtures/cctp/arc-forwarding/fees-6-to-26-sandbox.json';

const account = '0x1111111111111111111111111111111111111111' as Address;
const recipient = '0x2222222222222222222222222222222222222222' as Address;
const hash = `0x${'ab'.repeat(32)}` as Hex;
const { publicClientFor, publicClients, connection, wallet, switchChainAsync } = vi.hoisted(() => {
  const makeClient = (chainId: number) => ({
    chain: { id: chainId },
    getCode: vi.fn().mockResolvedValue('0x6000'),
    getBlockNumber: vi.fn().mockResolvedValue(chainId === 84532 ? 1234n : 900000n),
    getTransactionCount: vi.fn().mockResolvedValue(1),
    getLogs: vi.fn().mockResolvedValue([]),
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [] }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
  });
  const publicClients = new Map<number, ReturnType<typeof makeClient>>();
  const publicClientFor = (chainId: number) => {
    if (!publicClients.has(chainId)) publicClients.set(chainId, makeClient(chainId));
    return publicClients.get(chainId)!;
  };
  const connection = { chainId: 5042002 };
  return {
    publicClientFor, publicClients, connection,
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
vi.mock('@/lib/crossChain/balance', () => ({ readAllCrossChainBalances: vi.fn() }));
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
    balance: 3000000n, status: 'ok' }], gateway: { status: 'ok', perDomain: new Map(), total: 0n } } as never);
});
afterEach(() => { qc.clear(); localStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('source-chain client routing with the wallet connected to the destination', () => {
  const legacyArgs = { ...args, targetChainId: 80002 };
  const legacyKey = { ...key, destChainId: legacyArgs.targetChainId };
  const burnHash = `0x${'bc'.repeat(32)}` as Hex;
  const mintHash = `0x${'cd'.repeat(32)}` as Hex;

  beforeEach(async () => {
    connection.chainId = legacyArgs.targetChainId;
    const actual = await vi.importActual<typeof import('@/lib/crossChain/execute')>('@/lib/crossChain/execute');
    vi.mocked(executeCctpTransfer).mockImplementation(actual.executeCctpTransfer);
    vi.mocked(executeGatewayTransfer).mockImplementation(actual.executeGatewayTransfer);
    wallet.writeContract.mockResolvedValue(hash);
    wallet.sendTransaction.mockImplementation(async ({ chain }: { chain: { id: number } }) =>
      chain.id === legacyKey.sourceChainId ? burnHash : mintHash);
    wallet.signTypedData.mockResolvedValue(hash);
    vi.mocked(pollIrisAttestation).mockResolvedValue({ status: 'complete', message: '0x1234', attestation: '0x5678' });
    vi.mocked(requestAttestation).mockResolvedValue({ attestation: '0x1234', signature: '0x5678' });
    vi.mocked(readAllCrossChainBalances).mockResolvedValue({
      wallet: [{ target: { chainId: 84532, domain: 6, isTestnet: true, role: 'merchant-and-buyer' },
        balance: 3000000n, status: 'ok' }],
      gateway: { status: 'ok', perDomain: new Map([[6, 3000000n]]), total: 3000000n },
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
    expect(dest.getBlockNumber).not.toHaveBeenCalled();
    expect(wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ maxBlockHeight: 1234n + defaultBlockHeightOffset(legacyKey.sourceChainId) }),
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
    await expect(result.current.execute()).rejects.toThrow('chooser');
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
