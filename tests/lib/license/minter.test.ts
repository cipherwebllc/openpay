// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toHex, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy } from 'viem/chains';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null, enabled: true, lockError: false, failSave: '' as '' | 'before' | 'after',
  rpc: { getBlock: vi.fn(), getTransactionReceipt: vi.fn(), readContract: vi.fn(), getLogs: vi.fn(), simulateContract: vi.fn(), getTransactionCount: vi.fn(), getBalance: vi.fn(), sendRawTransaction: vi.fn(), chain: undefined as unknown },
  wallet: { prepareTransactionRequest: vi.fn(), signTransaction: vi.fn() },
  intent: vi.fn(), confirm: vi.fn(), alert: vi.fn(), eval: vi.fn(),
}));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled }));
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => h.rpc.chain, customRpcUrlForChain: () => undefined }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(), createPublicClient: () => h.rpc, createWalletClient: () => h.wallet }));
vi.mock('@/lib/x402/purchaseIntent', () => ({ getPurchaseIntent: h.intent }));
vi.mock('@/lib/license/registration', () => ({ confirmLicenseRegistration: h.confirm }));
vi.mock('@/lib/x402/reverify', () => ({ sendReverifyAlert: h.alert }));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: h.store!.strings.get(key) ?? null }),
  kvSetNxGet: async (key: string, value: string, ttl: number) => {
    if (h.lockError) return { ok: false };
    h.store!.purgeExpired(); const old = h.store!.strings.get(key) ?? null;
    if (old === null) { h.store!.strings.set(key, value); h.store!.setTtl(key, ttl); }
    return { ok: true, value: old };
  },
  kvEval: async (script: string, keys: string[], args: string[]) => {
    h.eval(script, keys, args);
    const isSubmit = script.includes('local active=') && JSON.parse(args[2]!).submission;
    if (isSubmit && h.failSave === 'before') { h.failSave = ''; return { ok: false }; }
    const value = await runRedisLua(script, keys, args, h.store!);
    if (isSubmit && h.failSave === 'after') { h.failSave = ''; return { ok: false }; }
    return { ok: true, value };
  },
}));
import { licenseBackoff, runLicenseWorker, LICENSE_ABI } from '@/lib/license/minter';
import { LICENSE_ACTIVE_SUBMISSION, LICENSE_WORKER_LOCK, saveLicenseJob } from '@/lib/license/workerStore';
import { createLicenseDefinition } from '@/lib/license/definition';
import { computeLicensePaymentKey } from '@/lib/license/paymentKey';
import { LICENSE_DUE_INDEX, LICENSE_OBLIGATION_INDEX, licenseObligationKey } from '@/lib/license/stock';
import { licenseRegistrationJobKey } from '@/lib/license/product';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import type { LicenseMintJob } from '@/lib/license/jobs';

const NOW = 1_800_000_000_000;
const ID = 'h_' + 'a'.repeat(32);
const CONTRACT = '0x3333333333333333333333333333333333333333';
const PAYER = '0x1111111111111111111111111111111111111111';
const FORWARDER = '0x2222222222222222222222222222222222222222';
const TX = toHex(7n, { size: 32 }); const BLOCK = toHex(8n, { size: 32 }); const SALT = toHex(9n, { size: 32 });
const KEY = toHex(1n, { size: 32 });
const definition = createLicenseDefinition(ID, { supply: 10, transferable: true, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 80002, CONTRACT);
const paymentAbi = parseAbi(['event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)', 'event Settled(address indexed from,bytes32 indexed nonce,address indexed merchant,uint256 merchantValue,address feeReceiver,uint256 feeValue)']);
function fixture(): LicenseMintJob {
  const claim = { payer: PAYER, token: JPYC_V3_ASSET.address, chainId: 80002, forwarder: FORWARDER, commitVersion: toHex(1n, { size: 32 }), merchant: CONTRACT, merchantValue: '1000', feeReceiver: PAYER, feeValue: '10', validAfter: '0', validBefore: '1800000600', nonce: TX, signatureFingerprint: 'a'.repeat(64), resourceId: ID, contentRevision: 1, deploymentVersion: 'v1', anchorBlock: '1' } as LicenseMintJob['payment'];
  claim.nonce = buildForwarderNonce({ from: PAYER, merchant: CONTRACT, merchantValue: 1000n, feeReceiver: PAYER, feeValue: 10n, validAfter: 0n, validBefore: 1800000600n, intentSalt: SALT }, 80002, FORWARDER);
  const job: LicenseMintJob = { version: 1, kind: 'mint', productId: ID, license: definition, status: 'awaiting_finality', attempts: 0, nextAttemptAt: NOW, paymentKey: computeLicensePaymentKey({ paymentChainId: 80002n, paymentToken: claim.token, payer: PAYER, authorizationNonce: claim.nonce }), payer: PAYER, intentSalt: SALT, payment: claim, txHash: TX, purchasedAt: NOW };
  h.intent.mockResolvedValue({ state: 'settled', resourceId: ID, metadata: { license: definition }, txHash: TX, claim, token: claim.token, chainId: 80002 });
  return job;
}
let job: LicenseMintJob;
function current() { return JSON.parse(h.store!.strings.get(licenseObligationKey(job.paymentKey))!) as LicenseMintJob; }
function seed(value = job) { h.store!.strings.set(licenseObligationKey(value.paymentKey), JSON.stringify(value)); h.store!.zsets.set(LICENSE_OBLIGATION_INDEX, new Map([[value.paymentKey, NOW]])); }
function advance(ms = 3_600_000) { h.store!.advance(ms); }
const run = () => runLicenseWorker({ member: job.paymentKey });
function mintReceipt(hash: Hex) {
  return { transactionHash: hash, blockNumber: 90n, blockHash: BLOCK, status: 'success', logs: [{ address: CONTRACT, topics: encodeEventTopics({ abi: LICENSE_ABI, eventName: 'LicenseMinted', args: { id: BigInt(definition.tokenId), to: PAYER, paymentKey: job.paymentKey } }), data: '0x' }] };
}
beforeEach(() => {
  vi.clearAllMocks(); h.store = createFakeRedisStore(NOW); vi.spyOn(Date, 'now').mockImplementation(() => h.store!.now());
  vi.stubEnv('LICENSE_MINTER_PRIVATE_KEY', KEY); vi.stubEnv('RELAYER_PRIVATE_KEY', ''); vi.stubEnv('ALERT_WEBHOOK_URL', 'https://alerts.example');
  h.enabled = true; h.lockError = false; h.failSave = ''; h.rpc.chain = polygonAmoy; job = fixture(); seed();
  h.rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 100n, hash: BLOCK, timestamp: 1800000601n }));
  h.rpc.getTransactionReceipt.mockImplementation(async ({ hash }) => {
    if (hash !== TX) throw new Error('not found');
    return { transactionHash: TX, blockNumber: 50n, blockHash: BLOCK, status: 'success', logs: [
      { address: job.payment.token, topics: encodeEventTopics({ abi: paymentAbi, eventName: 'AuthorizationUsed', args: { authorizer: PAYER, nonce: job.payment.nonce } }), data: '0x' },
      { address: FORWARDER, topics: encodeEventTopics({ abi: paymentAbi, eventName: 'Settled', args: { from: PAYER, nonce: job.payment.nonce, merchant: CONTRACT } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [1000n, PAYER, 10n]) },
    ] };
  });
  h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf' ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true } : { id: 0n, to: zeroAddress });
  h.rpc.getLogs.mockResolvedValue([]); h.rpc.simulateContract.mockResolvedValue({}); h.rpc.getTransactionCount.mockResolvedValue(7); h.rpc.getBalance.mockResolvedValue(10n ** 18n);
  h.wallet.prepareTransactionRequest.mockImplementation(async (args) => ({ ...args, chainId: 80002, gas: 100_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n, type: 'eip1559' }));
  h.wallet.signTransaction.mockImplementation(async (args) => privateKeyToAccount(KEY).signTransaction(args));
  h.rpc.sendRawTransaction.mockImplementation(async ({ serializedTransaction }) => {
    expect(current().submission?.serializedTransaction).toBe(serializedTransaction);
    expect(h.store!.strings.get(LICENSE_ACTIVE_SUBMISSION)).toBe(job.paymentKey);
    return keccak256(serializedTransaction);
  });
  h.confirm.mockResolvedValue('registered'); h.alert.mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(closeRedisLuaEngine);

describe('license worker: viem + real Lua CAS', () => {
  it('persists finality evidence, nonce and signed hash before broadcast, then polls in the next run', async () => {
    expect(await run()).toMatchObject({ ok: true, processed: 1, failed: 0 });
    const submitted = current(); expect(submitted).toMatchObject({ status: 'submitted', paymentBlock: { blockNumber: '50', blockHash: BLOCK }, submission: { nonce: 7 } });
    expect(submitted.lease?.token).toBe(h.store!.strings.get(LICENSE_WORKER_LOCK));
    const original = h.rpc.getTransactionReceipt.getMockImplementation()!;
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash === TX ? original(args) : mintReceipt(args.hash));
    h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf' ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true } : { id: BigInt(definition.tokenId), to: PAYER });
    advance(); await run();
    expect(current()).toMatchObject({ status: 'minted', mintTxHash: submitted.submission!.hash, mintBlock: { blockNumber: '90', blockHash: BLOCK } });
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.store!.strings.has(LICENSE_ACTIVE_SUBMISSION)).toBe(false);
  });
  it('awaits finalized payment and rejects mismatched payment evidence', async () => {
    h.rpc.getBlock.mockResolvedValue({ number: 40n, hash: BLOCK }); await run();
    expect(current().status).toBe('awaiting_finality'); expect(h.rpc.simulateContract).not.toHaveBeenCalled();
    advance(); h.rpc.getBlock.mockResolvedValue({ number: 100n, hash: BLOCK });
    h.rpc.getTransactionReceipt.mockResolvedValue({ transactionHash: TX, blockNumber: 50n, blockHash: BLOCK, status: 'success', logs: [] }); await run();
    expect(current()).toMatchObject({ status: 'needs_repair', lastError: 'payment_tuple_mismatch' }); expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });
  it.each(['simulate', 'funding', 'gas'] as const)('backs off %s failures without signing', async (failure) => {
    if (failure === 'simulate') h.rpc.simulateContract.mockRejectedValue(new Error('receiver revert'));
    if (failure === 'funding') h.rpc.getBalance.mockResolvedValue(0n);
    if (failure === 'gas') h.wallet.prepareTransactionRequest.mockResolvedValue({ gas: 1_000_000n, maxFeePerGas: 10n ** 9n });
    await run(); expect(current()).toMatchObject({ status: 'retryable', attempts: 1, nextAttemptAt: NOW + 300_000 }); expect(h.wallet.signTransaction).not.toHaveBeenCalled();
    advance(); await run(); expect(current().nextAttemptAt).toBe(h.store!.now() + 600_000);
  });
  it('attempt 10 alerts and leaves an indexed repair obligation', async () => {
    seed({ ...job, attempts: 9 }); h.rpc.simulateContract.mockRejectedValue(new Error('bad receiver')); await run();
    expect(current()).toMatchObject({ status: 'needs_repair', attempts: 10, alertedAt: NOW, alertPending: false }); expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.store!.zsets.get(LICENSE_OBLIGATION_INDEX)?.has(job.paymentKey)).toBe(true);
    expect([1, 2, 3, 10].map(licenseBackoff)).toEqual([300_000, 600_000, 1_200_000, 3_600_000]);
  });
  it('alert failure stays due and is retried independently', async () => {
    seed({ ...job, attempts: 9 }); h.alert.mockResolvedValue(false); h.rpc.simulateContract.mockRejectedValue(new Error('bad receiver')); await run();
    expect(current().alertPending).toBe(true); advance(); h.alert.mockResolvedValue(true); await run(); expect(current().alertPending).toBe(false);
    expect(h.rpc.simulateContract).toHaveBeenCalledTimes(1);
  });
  it.each(['before', 'after'] as const)('recovers a crash %s submission CAS without a second signed transaction', async (boundary) => {
    h.failSave = boundary; await run(); expect(h.rpc.sendRawTransaction).not.toHaveBeenCalled();
    advance(); await run();
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(boundary === 'after' ? 1 : 2); expect(current().status).toBe('submitted');
  });
  it('unknown broadcast remains submitted at attempt 10 and reuses the saved hash', async () => {
    h.rpc.sendRawTransaction.mockRejectedValue(new Error('network disconnected')); await run(); const submitted = current();
    seed({ ...submitted, attempts: 9 }); advance(); await run();
    expect(current()).toMatchObject({ status: 'submitted', attempts: 10, submission: submitted.submission }); expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.alert).toHaveBeenCalledTimes(1);
  });
  it('refuses a finalized replacement with no license and recovers an exact replacement event', async () => {
    await run(); const signed = current(); advance(); h.rpc.getTransactionCount.mockResolvedValue(8); await run();
    expect(current()).toMatchObject({ status: 'needs_repair', lastError: 'nonce_replaced_without_license' });
    advance(); seed({ ...signed, lease: undefined, nextAttemptAt: h.store!.now() });
    h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf' ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true } : { id: BigInt(definition.tokenId), to: PAYER });
    const replacement = toHex(55n, { size: 32 }); h.rpc.getLogs.mockResolvedValue([{ transactionHash: replacement }]);
    const original = h.rpc.getTransactionReceipt.getMockImplementation()!;
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash === replacement ? mintReceipt(replacement) : original(args)); await run();
    expect(current()).toMatchObject({ status: 'minted', mintTxHash: replacement }); expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
  });
  it.each(['event', 'reorg', 'consumed'] as const)('never remints on receipt %s mismatch', async (kind) => {
    await run(); advance(); const original = h.rpc.getTransactionReceipt.getMockImplementation()!;
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash === TX ? original(args) : { ...mintReceipt(args.hash), ...(kind === 'event' ? { logs: [] } : kind === 'reorg' ? { blockHash: TX } : {}) });
    if (kind !== 'consumed') h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf' ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true } : { id: BigInt(definition.tokenId), to: PAYER });
    await run(); expect(current().status).toBe('needs_repair'); expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
  });
  it('serializes cron overlap, distinguishes lock IO failure, and fences stale writes', async () => {
    const [a, b] = await Promise.all([run(), run()]); expect([a, b].filter((r) => r.ok && r.skipped === 'locked')).toHaveLength(1); expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
    const saved = current(); advance(); h.store!.strings.set(LICENSE_WORKER_LOCK, 'new-owner');
    expect(await saveLicenseJob(job.paymentKey, JSON.stringify(saved), { ...saved, status: 'minted' }, saved.lease!.token)).toBe(false);
    h.lockError = true; expect(await run()).toEqual({ ok: false, error: 'storage_unavailable' });
  });
  it('retains the durable lane when an unknown transaction is not yet due', async () => {
    h.store!.strings.set(LICENSE_ACTIVE_SUBMISSION, 'another-job'); await run(); expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('stops dispatch at the deadline and rebuilds a lost due entry from the permanent index', async () => {
    h.rpc.getBlock.mockImplementation(async () => { h.store!.advance(40_000); return { number: 100n, hash: BLOCK }; });
    await runLicenseWorker(); expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.has(job.paymentKey)).toBe(true); expect(h.rpc.getTransactionReceipt).not.toHaveBeenCalled(); expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('isolates corrupt jobs and leaves them in the permanent index', async () => {
    const bad = toHex(123n, { size: 32 }); h.store!.zsets.set(LICENSE_DUE_INDEX, new Map([[bad, NOW - 1], [job.paymentKey, NOW]]));
    expect(await runLicenseWorker()).toMatchObject({ failed: 1, processed: 1 }); expect(current().status).toBe('submitted');
    expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.has(bad)).toBe(false);
    expect(h.store!.zsets.get('store:license:repair:quarantine')?.has('mint:' + bad)).toBe(true);
  });
  it('prioritizes the active hash ahead of a full page of older blocked jobs', async () => {
    await run(); const original = h.rpc.getTransactionReceipt.getMockImplementation()!; advance();
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash === TX ? original(args) : mintReceipt(args.hash));
    h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf' ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true } : { id: BigInt(definition.tokenId), to: PAYER });
    const due = new Map(Array.from({ length: 20 }, (_, i) => [toHex(BigInt(i + 1000), { size: 32 }), NOW - 1]));
    due.set(job.paymentKey, NOW); h.store!.zsets.set(LICENSE_DUE_INDEX, due);
    await runLicenseWorker(); expect(current().status).toBe('minted'); expect(h.store!.strings.has(LICENSE_ACTIVE_SUBMISSION)).toBe(false);
  });
  it('submits registration and confirms through the existing helper without publishing', async () => {
    const member = 'registration:' + ID; const key = licenseRegistrationJobKey(ID);
    h.store!.strings.set(key, JSON.stringify({ version: 1, kind: 'registration', productId: ID, license: definition, status: 'pending', attempts: 0, nextAttemptAt: NOW }));
    h.rpc.readContract.mockResolvedValue({ exists: false }); h.rpc.sendRawTransaction.mockResolvedValue(TX);
    await runLicenseWorker({ member }); const submitted = JSON.parse(h.store!.strings.get(key)!); expect(submitted).toMatchObject({ kind: 'register', status: 'submitted' });
    advance(); h.rpc.readContract.mockResolvedValue({ exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true }); h.rpc.getTransactionReceipt.mockResolvedValue(mintReceipt(submitted.submission.hash));
    await runLicenseWorker({ member }); expect(h.confirm).toHaveBeenCalledWith(ID, submitted.submission.hash, h.rpc); expect(JSON.parse(h.store!.strings.get(key)!).status).toBe('registered');
  });
  it('flag OFF never acquires a lock or dispatches RPC; relay key reuse never signs', async () => {
    h.enabled = false; await run(); expect(h.store!.strings.has(LICENSE_WORKER_LOCK)).toBe(false); expect(h.rpc.getBlock).not.toHaveBeenCalled();
    h.enabled = true; vi.stubEnv('RELAYER_PRIVATE_KEY', KEY); await run(); expect(current()).toMatchObject({ status: 'needs_repair', lastError: 'minter_must_differ_from_relayer' }); expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });
});
