import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, pad, toHex,
  type Address, type Hex, type PublicClient } from 'viem';
import mainnetFees from '../../fixtures/cctp/arc-forwarding/fees-6-to-26-mainnet.json';
import sandboxFees from '../../fixtures/cctp/arc-forwarding/fees-6-to-26-sandbox.json';
import forwarding from '../../fixtures/cctp/arc-forwarding/arc-testnet-forwarding-receipts.json';
import contrast from '../../fixtures/cctp/arc-forwarding/arc-testnet-destination-receipts.json';
import iris from '../../fixtures/cctp/arc-forwarding/iris-messages-forwarding-domain0.json';
import selfMintIris from '../../fixtures/cctp/arc-forwarding/iris-messages-domain0-nonce.json';
import * as cctp from '@/lib/crossChain/cctp';
import { env } from '@/lib/env';
import { executeCctpTransfer, CrossChainForwardPendingError, CrossChainQuoteExpiredError,
  type CctpResumeState, type ExecuteCctpTransferArgs } from '@/lib/crossChain/execute';
import { __resetContractDeployedCacheForTest } from '@/lib/crossChain/deploycheck';
import { loadResumeState, loadResumeStateDiscriminated, saveResumeStateStrict, type ResumeSessionKey } from '@/lib/crossChain/resumeStore';

const account: Address = '0x1111111111111111111111111111111111111111';
const recipient: Address = '0x2222222222222222222222222222222222222222';
const token: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const hash = (n: number) => toHex(n, { size: 32 });
const burnHash = hash(1), mintHash = hash(2), nonce = hash(3);
const quote = () => cctp.acceptForwardQuote({ sourceChainId: 84532, destChainId: 5042002,
  sourceDomain: 6, destDomain: 26, recipient, valueAtomic: '1000000' }, sandboxFees[0], 1000);
const eventLog = (event: typeof cctp.CCTP_MESSAGE_RECEIVED_EVENT | typeof cctp.CCTP_MINT_AND_WITHDRAW_EVENT | typeof cctp.CCTP_V2_DEPOSIT_FOR_BURN_EVENT,
  args: Record<string, unknown>, data: Hex, address: Address, logIndex: number) => ({
  address, topics: encodeEventTopics({ abi: [event], args }), data, logIndex,
  blockNumber: 100n, blockHash: hash(4), transactionHash: mintHash, transactionIndex: 0, removed: false,
});
function destinationLogs(q = quote()) {
  const body = ('0x' + [toHex(1, { size: 4 }), pad(token), pad(recipient), toHex(BigInt(q.grossAtomic), { size: 32 }),
    pad(account), toHex(BigInt(q.maxFeeAtomic), { size: 32 }), toHex(20000n, { size: 32 }), toHex(0n, { size: 32 }), cctp.CCTP_FORWARD_HOOK_DATA]
    .map((v) => v.slice(2)).join('')) as Hex;
  const mint = eventLog(cctp.CCTP_MINT_AND_WITHDRAW_EVENT, { mintRecipient: recipient, mintToken: cctp.ARC_USDC_ADDRESS },
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(q.grossAtomic) - 20000n, 20000n]), cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS, 1);
  const message = eventLog(cctp.CCTP_MESSAGE_RECEIVED_EVENT, { caller: account, nonce, finalityThresholdExecuted: 1000 },
    encodeAbiParameters([{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }], [6, pad(cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS), body]), cctp.CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS, 2);
  return [mint, message];
}
function sourceLog(q = quote(), override: { hook?: Hex; caller?: Hex; amount?: bigint; maxFee?: bigint; token?: Address; depositor?: Address; recipient?: Address; domain?: number; finality?: number } = {}) {
  return eventLog(cctp.CCTP_V2_DEPOSIT_FOR_BURN_EVENT, { burnToken: override.token ?? token, depositor: override.depositor ?? account, minFinalityThreshold: override.finality ?? 1000 },
    encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
      [override.amount ?? BigInt(q.grossAtomic), pad(override.recipient ?? recipient), override.domain ?? 26, pad(cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS), override.caller ?? hash(0), override.maxFee ?? BigInt(q.maxFeeAtomic), override.hook ?? cctp.CCTP_FORWARD_HOOK_DATA]), cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS, 3);
}
const receipt = (logs = destinationLogs()) => ({ status: 'success', blockNumber: 100n, blockHash: hash(4), logs });
const verifyArgs = (logs = destinationLogs()) => ({ destClient: { getTransactionReceipt: vi.fn().mockResolvedValue(receipt(logs)) } as unknown as PublicClient,
  txHash: mintHash, sourceDomain: 6 as const, nonce, mintRecipient: recipient, mintToken: cctp.ARC_USDC_ADDRESS,
  minAmount: 1000000n, burnToken: token, grossAmount: BigInt(quote().grossAtomic), maxFee: BigInt(quote().maxFeeAtomic), messageSender: account });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); localStorage.clear(); });

describe('Arc captured fixtures', () => {
  // required = forwardFee.high + protocolFee (Circle の現在要求)。maxFee (買い手が払う転送手数料) は high に
  // 10% headroom (切り上げ) を乗せる: mainnet 98239 → 108063 (+33 = 108096)、sandbox 20502 → 22553 (+130 = 22683)。
  it.each([[mainnetFees[0], 98272n, 108096n], [sandboxFees[0], 20632n, 22683n]] as const)('pins integer fee units/rounding', (fee, required, cap) => {
    expect(cctp.computeForwardRequiredFee(1000000n, fee)).toBe(required);
    expect(cctp.computeForwardMaxFee(1000000n, fee)).toBe(cap);
    expect(cctp.computeForwardRequiredFee(1n, fee)).toBe(BigInt(fee.forwardFee.high) + 1n);
    expect(cctp.computeForwardMaxFee(1n, fee)).toBe(cctp.forwardFeeCapAtomic(fee) + 1n);
    expect(cctp.computeForwardRequiredFee(1000000n, { ...fee, minimumFee: 0.325, forwardFee: { low: 0, med: 0, high: 24862 } })).toBe(24895n);
    expect(cctp.computeForwardMaxFee(1000000n, { ...fee, minimumFee: 0.325, forwardFee: { low: 0, med: 0, high: 24862 } })).toBe(27382n);
  });
  it('quote is frozen and JSON-safe; encoder owns hook and gross', () => {
    const q = quote(); expect(Object.isFrozen(q)).toBe(true); expect(JSON.parse(JSON.stringify(q))).toEqual(q);
    const data = cctp.encodeForwardDepositForBurnCalldata({ value: 1000000n, maxFee: BigInt(q.maxFeeAtomic), destinationDomain: 26, recipient, burnToken: token });
    expect(decodeFunctionData({ abi: cctp.CCTP_FORWARD_ABI, data }).args).toEqual([BigInt(q.grossAtomic), 26, pad(recipient), token, hash(0), BigInt(q.maxFeeAtomic), 1000, cctp.CCTP_FORWARD_HOOK_DATA]);
  });
  it('fetches Fast quote only; HTTP/malformed quote has no fallback', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(mainnetFees)));
    expect(await cctp.fetchCctpBurnFees(6, 26, { forward: true, fetch })).toEqual(mainnetFees[0]);
    expect(fetch.mock.calls[0][0]).toContain('/v2/burn/USDC/fees/6/26?forward=true');
    await expect(cctp.fetchCctpBurnFees(6, 26, { forward: true, fetch: async () => new Response('[]') })).rejects.toThrow();
    await expect(cctp.fetchCctpBurnFees(6, 26, { forward: true, fetch: async () => new Response('', { status: 503 }) })).rejects.toThrow();
  });
  it('pins topic0, indexed fields and body offsets against all real receipts', () => {
    for (const r of [...forwarding.receipts, ...contrast.receipts]) {
      for (const log of r.logs) {
        const l = { ...log, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] };
        if (log.topics[0] === cctp.CCTP_MESSAGE_RECEIVED_TOPIC0) {
          const decoded = decodeEventLog({ abi: [cctp.CCTP_MESSAGE_RECEIVED_EVENT], ...l });
          expect(decoded.args.nonce).toBe(log.topics[2]);
          expect(pad(decoded.args.caller).toLowerCase()).toBe(log.topics[1]);
          expect(BigInt(decoded.args.finalityThresholdExecuted)).toBe(BigInt(log.topics[3]));
          const b = cctp.decodeBurnMessageBody(decoded.args.messageBody);
          expect(b.version).toBe(1);
          const expected = r.decoded.find((d) => d.logIndex === log.logIndex);
          expect(decoded.args).toEqual(expected?.args);
          const mint = r.decoded.find((d) => d.event === 'MintAndWithdraw');
          expect(b.amount - b.feeExecuted).toBe(BigInt(mint!.args!.amount!));
          expect(b.mintRecipient.slice(-40).toLowerCase()).toBe(mint!.args!.mintRecipient!.slice(2).toLowerCase());
        }
        if (log.topics[0] === cctp.CCTP_MINT_AND_WITHDRAW_TOPIC0) {
          const decoded = decodeEventLog({ abi: [cctp.CCTP_MINT_AND_WITHDRAW_EVENT], ...l });
          expect(pad(decoded.args.mintRecipient).toLowerCase()).toBe(log.topics[1]);
          expect(pad(decoded.args.mintToken).toLowerCase()).toBe(log.topics[2]);
        }
      }
    }
    const body = iris.response.messages[0].decodedMessage.decodedMessageBody;
    const decoded = cctp.decodeBurnMessageBody(iris.response.messages[0].decodedMessage.messageBody as Hex);
    expect(decoded.hookData).toBe(body.hookData);
    expect(String(decoded.maxFee)).toBe(body.maxFee);
    expect(String(decoded.expirationBlock)).toBe(body.expirationBlock);
  });
  it('reads genuine forwarding and self-mint Iris candidates without asserting settlement', async () => {
    for (const response of [iris.response, selfMintIris.response]) {
      const observed = await cctp.pollIrisForward(0, burnHash, { fetch: async () => new Response(JSON.stringify(response)) });
      expect(observed?.forwardTxHash).toBe(response.messages[0].destinationMintTxHash);
    }
    expect((await cctp.pollIrisForward(6, burnHash, { fetch: async () => new Response('{"messages":[{"status":"pending_confirmations","forwardState":"PENDING","delayReason":"insufficient_fee"}]}') }))?.forwardTxHash).toBeUndefined();
  });
});

describe('destination binding', () => {
  it('verifies net and actual collected fee', async () => {
    expect(await cctp.verifyForwardMint(verifyArgs())).toEqual({ ok: true, verifiedNetAtomic: 1002683n, feeCollectedAtomic: 20000n, blockNumber: 100n });
  });
  it.each(['mint-emitter', 'message-emitter', 'nonce', 'source-domain', 'recipient', 'burnToken', 'maxFee', 'gross', 'mintToken', 'minAmount', 'sender', 'reverted', 'missing-mint'])('rejects %s', async (kind) => {
    const logs = destinationLogs(); const a = verifyArgs(logs);
    if (kind === 'mint-emitter') logs[0].address = recipient;
    if (kind === 'message-emitter') logs[1].address = recipient;
    if (kind === 'nonce') a.nonce = hash(99);
    if (kind === 'source-domain') a.sourceDomain = 0 as 6;
    if (kind === 'recipient') a.mintRecipient = account;
    if (kind === 'burnToken') a.burnToken = account;
    if (kind === 'maxFee') a.maxFee++;
    if (kind === 'gross') a.grossAmount++;
    if (kind === 'mintToken') a.mintToken = account;
    if (kind === 'minAmount') a.minAmount = 2000000n;
    if (kind === 'sender') a.messageSender = recipient;
    if (kind === 'missing-mint') logs.shift();
    if (kind === 'reverted') vi.mocked(a.destClient.getTransactionReceipt).mockResolvedValue({ ...receipt(logs), status: 'reverted' } as never);
    expect((await cctp.verifyForwardMint(a)).ok).toBe(false);
  });
  it('does not borrow a valid mint from another message in a multi-message receipt', async () => {
    const [mint, message] = destinationLogs();
    const other = { ...message, topics: [...message.topics] as typeof message.topics, logIndex: 2 };
    other.topics[2] = hash(77);
    const target = { ...message, logIndex: 3 };
    expect(await cctp.verifyForwardMint(verifyArgs([mint, other, target]))).toEqual({ ok: false, reason: 'mint-binding' });
  });
  it('discovers by indexed nonce and shrinks a rate-limited window', async () => {
    const getLogs = vi.fn().mockRejectedValueOnce(new Error('range')).mockResolvedValue([{ transactionHash: mintHash, args: { sourceDomain: 6 }, removed: false }]);
    const found = await cctp.findForwardMintByNonce({ getBlockNumber: async () => 3000n, getLogs } as unknown as PublicClient, { nonce, sourceDomain: 6, fromBlock: 1n });
    expect(found).toEqual({ hashes: [mintHash], nextBlock: 1001n, scannedToBlock: 1000n });
    expect(getLogs.mock.calls[0][0].args).toEqual({ nonce });
    expect(getLogs.mock.calls[1][0].toBlock).toBe(1000n);
  });
});

function harness(resume?: CctpResumeState) {
  vi.spyOn(env, 'enableUsdcArc', 'get').mockReturnValue(true);
  vi.spyOn(env, 'enableUsdcArcCrossChain', 'get').mockReturnValue(true);
  __resetContractDeployedCacheForTest();
  const q = quote();
  const source = { getChainId: async () => 84532, getBlockNumber: vi.fn().mockResolvedValue(100n),
    getTransactionCount: vi.fn().mockResolvedValue(1), getCode: vi.fn().mockResolvedValue('0x1234'),
    // approve 反映待ち (allowance ≥ gross) を即時に満たす。
    readContract: vi.fn().mockResolvedValue(10n ** 30n),
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt([sourceLog(q)])),
    waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt([sourceLog(q)])), getLogs: vi.fn().mockResolvedValue([]) };
  const dest = { getBlockNumber: vi.fn().mockResolvedValue(100n), getLogs: vi.fn().mockResolvedValue([]),
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt()) };
  const wallet = { getChainId: vi.fn().mockResolvedValue(84532), writeContract: vi.fn().mockResolvedValue(hash(5)), sendTransaction: vi.fn().mockResolvedValue(burnHash) };
  const states: CctpResumeState[] = [];
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/fees/') ? sandboxFees : { messages: [{ decodedMessage: { nonce }, forwardTxHash: mintHash, status: 'complete' }] })));
  const args: ExecuteCctpTransferArgs = { walletClient: wallet as never, sourcePublicClient: source as never,
    destPublicClient: dest as never, switchChainAsync: vi.fn(), account, sourceChainId: 84532, destChainId: 5042002,
    sourceDomain: 6, destDomain: 26, sourceToken: token, recipient, valueAtomic: 1000000n, feeAmount: 0n,
    forward: { acceptedQuote: q }, fetch, now: () => 2000, pollOptions: { timeoutMs: 0 }, resume,
    commitBurnIntent: vi.fn(), onMerchantMint: vi.fn(), onStep: (s) => states.push(structuredClone(s)) };
  return { args, source, dest, wallet, states, fetch };
}
function saved(state: NonNullable<CctpResumeState['forward']>['state'] = 'source-confirmed'): CctpResumeState {
  return { burnTxHash: burnHash, burnIntent: { v: 1, chainId: 84532, block: '90', at: Date.now() - 300_000, nonceLatest: 1, noncePending: 1,
    depositor: account, burnToken: token, mintRecipient: recipient, amount: quote().grossAtomic, destinationDomain: 26 },
  forward: { acceptedQuote: quote(), state, scanFromBlock: '90',
    ...(state !== 'intent' && state !== 'broadcast' ? { sourceEvidence: { txHash: burnHash, blockHash: hash(4), blockNumber: '100', logIndex: 3 } } : {}) } };
}

describe('forward executor', () => {
  it.each(['missing-forward', 'wrong-destination', 'fee', 'expired', 'exceeded'])('entry guard before tx: %s', async (kind) => {
    const h = harness();
    if (kind === 'missing-forward') h.args.forward = undefined;
    if (kind === 'wrong-destination') h.args.destChainId = 84532;
    if (kind === 'fee') h.args.feeAmount = 1n;
    if (kind === 'expired') h.args.now = () => 999999;
    if (kind === 'exceeded') h.fetch.mockImplementation(async () => new Response(JSON.stringify([{ ...sandboxFees[0], forwardFee: { high: 9999999 } }])));
    await expect(executeCctpTransfer(h.args)).rejects.toThrow();
    expect(h.wallet.writeContract).not.toHaveBeenCalled(); expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
    expect(h.args.switchChainAsync).not.toHaveBeenCalled();
  });
  it('gross approve/burn, atomic quote+marker, no destination switch/mint, verified accounting', async () => {
    const h = harness(); const result = await executeCctpTransfer(h.args);
    expect(result.mintTxHash).toBe(mintHash);
    expect(h.args.commitBurnIntent).toHaveBeenCalledWith(expect.objectContaining({ amount: '1022683' }), 'merchant', expect.objectContaining({ forward: expect.objectContaining({ acceptedQuote: quote(), state: 'intent' }) }));
    expect(h.wallet.writeContract).toHaveBeenCalledWith(expect.objectContaining({ args: [cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS, 1022683n] }));
    expect(h.wallet.sendTransaction).toHaveBeenCalledTimes(1); expect(h.args.switchChainAsync).not.toHaveBeenCalled();
    expect(h.states.map((s) => s.forward?.state)).toEqual(expect.arrayContaining(['intent', 'broadcast', 'source-confirmed', 'awaiting-forward', 'forward-observed', 'verified']));
    expect(h.states.at(-1)?.forward).toMatchObject({ nonce, acceptedQuote: quote(), sourceEvidence: { txHash: burnHash } });
    expect(h.args.onMerchantMint).toHaveBeenCalledWith(expect.objectContaining({ forward: { grossAtomic: '1022683', maxFeeAtomic: '22683', verifiedNetAtomic: '1002683', feeCollectedAtomic: '20000' } }));
  });
  it('flag OFF rejects a fresh transfer before any transaction', async () => {
    const h = harness(); vi.spyOn(env, 'enableUsdcArcCrossChain', 'get').mockReturnValue(false);
    await expect(executeCctpTransfer(h.args)).rejects.toThrow('disabled');
    expect(h.wallet.writeContract).not.toHaveBeenCalled(); expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('unknown candidate receipt is discarded and nonce discovery still completes', async () => {
    const h = harness(saved());
    h.dest.getTransactionReceipt.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'TransactionReceiptNotFoundError' }));
    h.dest.getLogs.mockResolvedValue([{ transactionHash: mintHash, args: { sourceDomain: 6 } }]);
    await expect(executeCctpTransfer(h.args)).resolves.toMatchObject({ mintTxHash: mintHash });
    expect(h.states.some((s) => s.forward?.nonce === nonce && s.forward?.state === 'awaiting-forward')).toBe(true);
  });
  it('delay reason without nonce remains visible and never sends a transaction', async () => {
    const h = harness(saved());
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ messages: [{ status: 'pending_confirmations', forwardState: 'PENDING', delayReason: 'amount_above_max' }] })));
    await expect(executeCctpTransfer(h.args)).rejects.toBeInstanceOf(CrossChainForwardPendingError);
    expect(h.states.at(-1)?.forward).toMatchObject({ state: 'awaiting-forward', delayReason: 'amount_above_max' });
    expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('strict intent failure prevents broadcast', async () => {
    const h = harness(); h.args.commitBurnIntent = () => { throw new Error('storage'); };
    await expect(executeCctpTransfer(h.args)).rejects.toThrow('storage'); expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it.each(['hook', 'caller', 'amount', 'maxFee', 'emitter', 'no-log', 'token', 'depositor', 'recipient', 'domain', 'finality'])('source-confirmed requires full evidence: %s', async (kind) => {
    const h = harness(saved('broadcast'));
    const log = sourceLog(quote(), kind === 'hook' ? { hook: '0x' } : kind === 'caller' ? { caller: pad(account) } : kind === 'amount' ? { amount: 1000000n } : kind === 'maxFee' ? { maxFee: 0n } : kind === 'token' ? { token: account } : kind === 'depositor' ? { depositor: recipient } : kind === 'recipient' ? { recipient: account } : kind === 'domain' ? { domain: 0 } : kind === 'finality' ? { finality: 2000 } : {});
    if (kind === 'emitter') log.address = recipient;
    h.source.getTransactionReceipt.mockResolvedValue(receipt(kind === 'no-log' ? [] : [log]));
    await expect(executeCctpTransfer(h.args)).rejects.toThrow('burn');
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it.each(['source-confirmed', 'awaiting-forward', 'forward-observed', 'broadcast', 'verified'] as const)('resume %s: no quote fetch or reburn; interrupted verified accounting completes', async (stage) => {
    const s = saved(stage); if (stage === 'verified') { s.mintTxHash = mintHash; s.forward!.nonce = nonce; }
    const h = harness(s); h.args.now = () => 9999999;
    await executeCctpTransfer(h.args);
    expect(h.source.getTransactionCount).not.toHaveBeenCalled();
    if (stage !== 'broadcast') expect(h.source.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(h.wallet.writeContract).not.toHaveBeenCalled();
    expect(h.wallet.sendTransaction).not.toHaveBeenCalled(); expect(h.fetch.mock.calls.every(([url]) => !url.includes('/fees/'))).toBe(true);
    expect(h.args.onMerchantMint).toHaveBeenCalledTimes(1);
  });
  it('verification mismatch returns to awaiting-forward without accounting', async () => {
    const h = harness(saved()); h.dest.getTransactionReceipt.mockResolvedValue(receipt([]));
    await expect(executeCctpTransfer(h.args)).rejects.toBeInstanceOf(CrossChainForwardPendingError);
    expect(h.states.at(-1)?.forward).toMatchObject({ state: 'awaiting-forward', candidateHash: undefined, nonce });
    expect(h.args.onMerchantMint).not.toHaveBeenCalled();
  });
  it('Iris outage after persisted nonce completes via discovery, including flag OFF', async () => {
    const s = saved(); s.forward!.nonce = nonce; const h = harness(s);
    vi.spyOn(env, 'enableUsdcArcCrossChain', 'get').mockReturnValue(false);
    h.fetch.mockRejectedValue(new Error('Iris down'));
    h.dest.getLogs.mockResolvedValue([{ transactionHash: mintHash, args: { sourceDomain: 6 } }]);
    await expect(executeCctpTransfer(h.args)).resolves.toMatchObject({ mintTxHash: mintHash });
    expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('Iris outage before nonce waits, with no destination scan or tx', async () => {
    const h = harness(saved()); h.fetch.mockRejectedValue(new Error('Iris down'));
    await expect(executeCctpTransfer(h.args)).rejects.toBeInstanceOf(CrossChainForwardPendingError);
    expect(h.dest.getLogs).not.toHaveBeenCalled(); expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('reorg of confirmed evidence locks without reopening the decision table', async () => {
    const h = harness(saved()); h.source.getTransactionReceipt.mockResolvedValue({ ...receipt([]), blockHash: hash(99) });
    await expect(executeCctpTransfer(h.args)).rejects.toThrow('burn');
    expect(h.source.getTransactionCount).not.toHaveBeenCalled(); expect(h.states.at(-1)?.forward?.sourceUnresolved).toBe(true);
  });
  it('reverted broadcast follows the existing decision table, probes, and requires fresh consent', async () => {
    const h = harness(saved('broadcast'));
    h.args.allowAutoReburn = true; h.args.now = Date.now; h.args.forward!.allowBurn = false;
    h.source.getBlockNumber.mockResolvedValue(200n);
    h.source.getTransactionReceipt.mockResolvedValueOnce({ ...receipt([]), status: 'reverted' });
    let replacement: cctp.AcceptedQuote | undefined;
    try { await executeCctpTransfer(h.args); } catch (e) {
      expect(e).toBeInstanceOf(CrossChainQuoteExpiredError);
      replacement = (e as CrossChainQuoteExpiredError).replacementQuote;
    }
    expect(replacement).toBeDefined(); expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
    h.source.getTransactionReceipt.mockResolvedValueOnce({ ...receipt([]), status: 'reverted' });
    h.args.forward = { acceptedQuote: replacement!, allowBurn: true };
    await expect(executeCctpTransfer(h.args)).resolves.toMatchObject({ mintTxHash: mintHash });
    expect(h.wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });
  it('intent probe-first continuation returns a fresh quote without a tx, then explicit reconsent burns', async () => {
    const s = saved('intent'); delete s.burnTxHash;
    const h = harness(s); h.args.now = () => Date.now(); h.args.allowAutoReburn = true; h.args.forward!.allowBurn = false;
    h.source.getBlockNumber.mockResolvedValue(200n);
    h.source.getTransactionCount.mockResolvedValue(1);
    let replacement: cctp.AcceptedQuote | undefined;
    try { await executeCctpTransfer(h.args); } catch (e) { expect(e).toBeInstanceOf(CrossChainQuoteExpiredError); replacement = (e as CrossChainQuoteExpiredError).replacementQuote; }
    expect(replacement?.quotedAt).toBeGreaterThan(1000); expect(h.wallet.writeContract).not.toHaveBeenCalled();
    h.args.forward = { acceptedQuote: replacement!, allowBurn: true };
    await expect(executeCctpTransfer(h.args)).resolves.toMatchObject({ mintTxHash: mintHash });
  });
});

describe('discriminated storage preserves legacy behavior', () => {
  const key: ResumeSessionKey = { account, kind: 'cctp-v2', sourceChainId: 84532, destChainId: 5042002, recipient, valueAtomic: 1000000n, feeAtomic: 0n };
  it('absent / valid / malformed / storage access failure', () => {
    expect(loadResumeStateDiscriminated(key).kind).toBe('absent');
    saveResumeStateStrict(key, saved()); expect(loadResumeStateDiscriminated(key).kind).toBe('present');
    localStorage.setItem(localStorage.key(0)!, '{broken');
    expect(loadResumeStateDiscriminated(key).kind).toBe('unreadable'); expect(loadResumeState(key)).toBeUndefined();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadResumeStateDiscriminated(key).kind).toBe('unreadable');
  });
});
