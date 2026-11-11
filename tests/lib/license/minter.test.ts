// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toHex, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy } from 'viem/chains';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null, enabled: true, lockError: false, failSave: '' as '' | 'before' | 'after',
  rpc: { getBlock: vi.fn(), getBytecode: vi.fn(), getTransactionReceipt: vi.fn(), readContract: vi.fn(), getLogs: vi.fn(), simulateContract: vi.fn(), getTransactionCount: vi.fn(), getBalance: vi.fn(), sendRawTransaction: vi.fn(), chain: undefined as unknown },
  wallet: { prepareTransactionRequest: vi.fn(), signTransaction: vi.fn() },
  intent: vi.fn(), product: vi.fn(), confirm: vi.fn(), alert: vi.fn(), eval: vi.fn(),
  // 本物の confirmLicenseRegistration (既定の h.confirm は固定値を返す・B3-2 の describe だけ本物に差し替える) と、
  // その商品 snapshot の読込。afterSnapshot は読込の直後 (= 確認の RPC の間) に 1 回だけ実行する。
  realConfirm: null as typeof import('@/lib/license/registration').confirmLicenseRegistration | null,
  snapshot: vi.fn(), afterSnapshot: null as (() => void) | null,
  // kvEval の応答の差し替え (kvEval の契約は Redis の値の形まで・script ごとの意味は呼出側が確かめる)。
  // run() を呼べば本物の Lua を実行した結果、呼ばなければ Lua を走らせずに返した値がそのまま ok:true で届く。
  reply: null as ((script: string, run: () => Promise<unknown>) => Promise<unknown>) | null,
  // true を返した script の kvEval を KV 障害 (ok:false) にする。
  failEval: null as ((script: string) => boolean) | null,
}));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled }));
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => h.rpc.chain, customRpcUrlForChain: () => undefined }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(), createPublicClient: () => h.rpc, createWalletClient: () => h.wallet }));
vi.mock('@/lib/x402/purchaseIntent', () => ({ getPurchaseIntent: h.intent }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProduct: h.product, getHostedProductUpdateSnapshot: h.snapshot }));
vi.mock('@/lib/license/registration', async (original) => {
  h.realConfirm = (await original<typeof import('@/lib/license/registration')>()).confirmLicenseRegistration;
  return { confirmLicenseRegistration: h.confirm };
});
vi.mock('@/lib/x402/reverify', () => ({ sendReverifyAlert: h.alert }));
vi.mock('@/lib/kv', () => ({
  kvExists: async (keys: string[]) => ({ ok: true, value: keys.filter((k) => h.store!.keys().includes(k)).length }),
  kvGet: async (key: string) => ({ ok: true, value: h.store!.strings.get(key) ?? null }),
  kvSetNxGet: async (key: string, value: string, ttl: number) => {
    if (h.lockError) return { ok: false };
    h.store!.purgeExpired(); const old = h.store!.strings.get(key) ?? null;
    if (old === null) { h.store!.strings.set(key, value); h.store!.setTtl(key, ttl); }
    return { ok: true, value: old };
  },
  kvEval: async (script: string, keys: string[], args: string[]) => {
    h.eval(script, keys, args);
    if (h.failEval?.(script)) return { ok: false, reason: 'network_error' };
    const isSubmit = script.includes('local active=') && JSON.parse(args[2]!).submission;
    if (isSubmit && h.failSave === 'before') { h.failSave = ''; return { ok: false }; }
    const run = () => runRedisLua(script, keys, args, h.store!);
    const value = h.reply ? await h.reply(script, run) : await run();
    if (isSubmit && h.failSave === 'after') { h.failSave = ''; return { ok: false }; }
    return { ok: true, value };
  },
}));
import { logger } from '@/lib/logger';
import { licenseBackoff, isLicenseRepairRun, runLicenseWorker, LICENSE_ABI } from '@/lib/license/minter';
import { repairLicenseIndexes } from '@/lib/license/repair';
import { LICENSE_ACTIVE_SUBMISSION, LICENSE_WORKER_LOCK, saveLicenseJob } from '@/lib/license/workerStore';
import { createLicenseDefinition } from '@/lib/license/definition';
import { computeLicensePaymentKey } from '@/lib/license/paymentKey';
import { LICENSE_DUE_INDEX, LICENSE_OBLIGATION_INDEX, licenseObligationKey } from '@/lib/license/stock';
import { licenseRegistrationJobKey } from '@/lib/license/product';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import { parseLicenseJob, type LicenseMintJob } from '@/lib/license/jobs';

const NOW = 1_800_000_000_000;
const ID = 'h_' + 'a'.repeat(32);
const CONTRACT = '0x3333333333333333333333333333333333333333';
const PAYER = '0x1111111111111111111111111111111111111111';
const FORWARDER = '0x2222222222222222222222222222222222222222';
const TX = toHex(7n, { size: 32 }); const BLOCK = toHex(8n, { size: 32 }); const SALT = toHex(9n, { size: 32 });
const KEY = toHex(1n, { size: 32 });
const definition = createLicenseDefinition(ID, { supply: 10, transferable: true, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 80002, CONTRACT);
const paymentAbi = parseAbi(['event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)', 'event Settled(address indexed from,bytes32 indexed nonce,address indexed merchant,uint256 merchantValue,address feeReceiver,uint256 feeValue)']);
function fixture(salt: Hex = SALT): LicenseMintJob {
  const claim = { payer: PAYER, token: JPYC_V3_ASSET.address, chainId: 80002, forwarder: FORWARDER, commitVersion: toHex(1n, { size: 32 }), merchant: CONTRACT, merchantValue: '1000', feeReceiver: PAYER, feeValue: '10', validAfter: '0', validBefore: '1800000600', nonce: TX, signatureFingerprint: 'a'.repeat(64), resourceId: ID, contentRevision: 1, deploymentVersion: 'v1', anchorBlock: '1' } as LicenseMintJob['payment'];
  claim.nonce = buildForwarderNonce({ from: PAYER, merchant: CONTRACT, merchantValue: 1000n, feeReceiver: PAYER, feeValue: 10n, validAfter: 0n, validBefore: 1800000600n, intentSalt: salt }, 80002, FORWARDER);
  const job: LicenseMintJob = { version: 1, kind: 'mint', productId: ID, license: definition, status: 'awaiting_finality', attempts: 0, nextAttemptAt: NOW, paymentKey: computeLicensePaymentKey({ paymentChainId: 80002n, paymentToken: claim.token, payer: PAYER, authorizationNonce: claim.nonce }), payer: PAYER, intentSalt: salt, payment: claim, txHash: TX, purchasedAt: NOW };
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
  h.enabled = true; h.lockError = false; h.failSave = ''; h.reply = null; h.failEval = null; h.afterSnapshot = null; h.rpc.chain = polygonAmoy; job = fixture(); seed();
  h.rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 100n, hash: BLOCK, timestamp: 1800000601n }));
  h.rpc.getBytecode.mockResolvedValue('0x6000');
  h.product.mockResolvedValue({ createdAt: NOW, license: definition });
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
  function consumedAt(paymentBlock: bigint, head = 80_000_000n) {
    const original = h.rpc.getTransactionReceipt.getMockImplementation()!;
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => ({ ...await original(args), blockNumber: paymentBlock }));
    h.rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? head, hash: BLOCK }));
    h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf'
      ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true }
      : { id: BigInt(definition.tokenId), to: PAYER });
  }

  it.each([undefined, '0', '79999000'])('G1: restored consumed mint bounds cursor %s by finalized payment block', async (scanFromBlock) => {
    seed({ ...job, scanFromBlock });
    consumedAt(79_998_000n);
    await run();
    const fromBlock = scanFromBlock === '79999000' ? 79_999_000n : 79_998_000n;
    expect(h.rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock, toBlock: fromBlock + 1999n > 80_000_000n ? 80_000_000n : fromBlock + 1999n }));
    expect(current().scanFromBlock).toBe((fromBlock + 1999n > 80_000_000n ? 80_000_001n : fromBlock + 2000n).toString());
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
    expect(h.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('G1: restored consumed mint recovers the event in the payment block without signing', async () => {
    consumedAt(79_999_000n);
    const replacement = toHex(55n, { size: 32 });
    h.rpc.getLogs.mockImplementation(async ({ fromBlock, toBlock }) => fromBlock <= 79_999_000n && toBlock >= 79_999_000n ? [{ transactionHash: replacement }] : []);
    const original = h.rpc.getTransactionReceipt.getMockImplementation()!;
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash === replacement
      ? { ...mintReceipt(replacement), blockNumber: 79_999_000n } : original(args));
    await run();
    expect(current()).toMatchObject({ status: 'minted', mintTxHash: replacement });
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('G1: repeated scan misses advance the cursor and reach repair with an alert', async () => {
    consumedAt(79_000_000n);
    for (let attempt = 1; attempt <= 10; attempt++) {
      await run();
      advance();
    }
    expect(current()).toMatchObject({ status: 'needs_repair', attempts: 0, scanAttempts: 10, lastError: 'event_not_found', scanFromBlock: '79020000', alertPending: false });
    expect(h.rpc.getLogs).toHaveBeenCalledTimes(10);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
    await run();
    expect(h.rpc.getLogs).toHaveBeenCalledTimes(10);
  });

  function restoredRegistration(createdBlock = 79_990_000n, overrides = {}, milliseconds = 0) {
    const member = 'registration:' + ID;
    const key = licenseRegistrationJobKey(ID);
    h.store!.strings.set(key, JSON.stringify({ version: 1, kind: 'register', productId: ID, license: definition, status: 'pending', attempts: 0, nextAttemptAt: NOW, ...overrides }));
    h.product.mockResolvedValue({ createdAt: Number(1_600_000_000n + createdBlock * 2n) * 1000 + milliseconds, license: definition });
    h.rpc.getBlock.mockImplementation(async ({ blockNumber }) => {
      const number = blockNumber ?? 80_000_000n;
      return { number, hash: BLOCK, timestamp: 1_600_000_000n + number * 2n };
    });
    h.rpc.getBytecode.mockRejectedValue(new Error('archive state unavailable'));
    return { member, key, read: () => JSON.parse(h.store!.strings.get(key)!) };
  }

  it.each([[0n, 0], [79_999_000n, 0], [79_999_000n, 999]] as const)('G1 review: registration maps product creation block %s + %sms using headers only', async (createdBlock, milliseconds) => {
    const registration = restoredRegistration(createdBlock, {}, milliseconds);
    const lowerBound = createdBlock === 0n ? 0n : createdBlock - 1n;
    h.rpc.getLogs.mockImplementation(async ({ fromBlock, toBlock }) => fromBlock <= createdBlock && toBlock >= createdBlock ? [{ transactionHash: TX }] : []);
    h.rpc.getTransactionReceipt.mockResolvedValue({ ...mintReceipt(TX), blockNumber: createdBlock });
    await runLicenseWorker({ member: registration.member });
    expect(h.rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: lowerBound }));
    expect(registration.read()).toMatchObject({ status: 'registered', mintTxHash: TX });
    expect(h.confirm).toHaveBeenCalledWith(ID, TX, h.rpc);
    expect(h.product).toHaveBeenCalledWith(ID);
    expect(h.rpc.getBytecode).not.toHaveBeenCalled();
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('G1 review: registration clamps a legacy genesis cursor and keeps scan retries independent of funding retries', async () => {
    const registration = restoredRegistration(79_990_000n, { attempts: 9, scanFromBlock: '0' });
    for (let scanAttempts = 1; scanAttempts <= 3; scanAttempts++) {
      await runLicenseWorker({ member: registration.member });
      expect(registration.read()).toMatchObject({ status: 'pending', attempts: 9, scanAttempts, scanFromBlock: String(79_989_999 + scanAttempts * 2000) });
      expect(h.alert).not.toHaveBeenCalled();
      advance();
    }
    expect(h.product).toHaveBeenCalledTimes(1);
    expect(h.rpc.getBytecode).not.toHaveBeenCalled();
    expect(h.rpc.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 79_993_999n, toBlock: 79_995_998n }));
  });

  it('G1 review: restored mint keeps pending while its separate scan budget is available', async () => {
    seed({ ...job, attempts: 9 });
    consumedAt(79_000_000n);
    await run();
    expect(current()).toMatchObject({ status: 'pending', attempts: 9, scanAttempts: 1 });
    expect(h.alert).not.toHaveBeenCalled();
    advance(); await run();
    expect(current()).toMatchObject({ status: 'pending', attempts: 9, scanAttempts: 2 });
  });

  it('G1 review: submitted mint keeps its submission and independent scan budget', async () => {
    await run();
    const signed = current(); seed({ ...signed, attempts: 9 }); advance();
    consumedAt(50n);
    h.rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 80_000_000n, hash: BLOCK }));
    await run();
    expect(current()).toMatchObject({ status: 'submitted', attempts: 9, scanAttempts: 1, submission: signed.submission });
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(h.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('G1 review: slow header lookup persists partial bounds and finishes after multiple deadlines', async () => {
    const registration = restoredRegistration(79_990_000n);
    const original = h.rpc.getBlock.getMockImplementation()!;
    h.rpc.getBlock.mockImplementation(async (args) => { advance(1500); return original(args); });
    await runLicenseWorker({ member: registration.member, deadline: NOW + 12_000 });
    const partial = registration.read().scanSearch;
    expect(partial).toBeDefined();
    expect(BigInt(partial.low)).toBeGreaterThan(0n);
    expect(BigInt(partial.high)).toBeLessThanOrEqual(80_000_000n);
    expect(h.rpc.getLogs).not.toHaveBeenCalled();
    advance();
    await runLicenseWorker({ member: registration.member });
    expect(registration.read()).toMatchObject({ status: 'pending', scanAttempts: 1, scanFromBlock: '79991999' });
    expect(h.product).toHaveBeenCalledTimes(1);
    expect(h.rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 79_989_999n }));
    expect(h.rpc.getBlock.mock.calls.filter(([args]) => args.blockNumber === 40_000_000n)).toHaveLength(1);
  });

  it('G1 review: persisted timestamp bounds are rejected if their finalized anchor changes', async () => {
    const registration = restoredRegistration(79_990_000n);
    const original = h.rpc.getBlock.getMockImplementation()!;
    h.rpc.getBlock.mockImplementation(async (args) => { advance(1500); return original(args); });
    await runLicenseWorker({ member: registration.member, deadline: NOW + 12_000 });
    advance();
    h.rpc.getBlock.mockImplementation(async (args) => ({ ...await original(args), hash: TX }));
    await runLicenseWorker({ member: registration.member });
    expect(registration.read()).toMatchObject({ status: 'needs_repair', lastError: 'scan_anchor_changed' });
    expect(h.rpc.getLogs).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledTimes(1);
  });

  it('G1 review: scan RPC failures use the scan budget, retain progress and alert at its limit', async () => {
    const registration = restoredRegistration(79_990_000n, { attempts: 9, scanAttempts: 8 });
    h.rpc.getLogs.mockRejectedValue(new Error('logs unavailable'));
    await runLicenseWorker({ member: registration.member });
    expect(registration.read()).toMatchObject({ status: 'pending', attempts: 9, scanAttempts: 9 });
    expect(h.alert).not.toHaveBeenCalled();
    advance(); await runLicenseWorker({ member: registration.member });
    expect(registration.read()).toMatchObject({ status: 'needs_repair', attempts: 9, scanAttempts: 10, alertPending: false });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.product).toHaveBeenCalledTimes(1);
    expect(h.rpc.getBytecode).not.toHaveBeenCalled();
  });

  it.each([null, 'storage'])('G1 review: unavailable product %s never falls back to a genesis scan', async (product) => {
    const registration = restoredRegistration(); h.product.mockResolvedValue(product);
    await runLicenseWorker({ member: registration.member });
    expect(registration.read()).toMatchObject({ status: product === null ? 'needs_repair' : 'pending', scanAttempts: 1 });
    expect(h.rpc.getLogs).not.toHaveBeenCalled();
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('G1 review: parser accepts legacy counters and rejects corrupt scan counters and bounds', () => {
    const registration = restoredRegistration();
    expect(parseLicenseJob(JSON.stringify(job))).toEqual(job);
    for (const scanAttempts of [-1, 1.5, '5', null]) {
      expect(parseLicenseJob(JSON.stringify({ ...job, scanAttempts }))).toBeNull();
    }
    const valid = { createdAt: NOW, low: '1', high: '10', anchor: { blockNumber: '10', blockHash: BLOCK } };
    expect(parseLicenseJob(JSON.stringify({ ...registration.read(), scanSearch: valid }))).not.toBeNull();
    for (const scanSearch of [null, { ...valid, createdAt: -1 }, { ...valid, low: '11' }, { ...valid, high: '11' }, { ...valid, low: 'bad' }, { ...valid, anchor: null }]) {
      expect(parseLicenseJob(JSON.stringify({ ...registration.read(), scanSearch }))).toBeNull();
    }
  });

  it('persists finality evidence, nonce and signed hash before broadcast, then polls in the next run', async () => {
    expect(await run()).toMatchObject({ ok: true, processed: 1, failed: 0 });
    const submitted = current(); expect(submitted).toMatchObject({ status: 'submitted', attempts: 0, nextAttemptAt: NOW + 60_000, paymentBlock: { blockNumber: '50', blockHash: BLOCK }, submission: { nonce: 7 } });
    expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.get(job.paymentKey)).toBe(NOW + 60_000);
    expect(submitted.lease?.token).toBe(h.store!.strings.get(LICENSE_WORKER_LOCK));
    const original = h.rpc.getTransactionReceipt.getMockImplementation()!;
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash === TX ? original(args) : mintReceipt(args.hash));
    h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf' ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true } : { id: BigInt(definition.tokenId), to: PAYER });
    advance(60_000); await run();
    expect(current()).toMatchObject({ status: 'minted', mintTxHash: submitted.submission!.hash, mintBlock: { blockNumber: '90', blockHash: BLOCK } });
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.store!.strings.has(LICENSE_ACTIVE_SUBMISSION)).toBe(false);
  });
  it('does not poll before the 60s due time and retains the 55s worker lock', async () => {
    await run(); const submitted = current();
    advance(59_999); await run();
    expect(current()).toEqual(submitted); expect(h.rpc.getTransactionReceipt).toHaveBeenCalledTimes(1);
    advance(1); expect(await run()).toMatchObject({ skipped: 'locked' });
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
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
  it.each(['submission_unconfirmed', 'receipt_not_finalized', 'alternating'] as const)('uses five persisted 60s waits then backoff for %s without counting failures', async (reason) => {
    await run(); const submitted = current();
    const original = h.rpc.getTransactionReceipt.getMockImplementation()!;
    let receiptAvailable = false;
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash !== TX && receiptAvailable
      ? { ...mintReceipt(args.hash), blockNumber: 101n }
      : original(args));
    const delays = [60_000, 60_000, 60_000, 60_000, 60_000, 300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000];
    for (const [index, delay] of delays.entries()) {
      receiptAvailable = reason === 'receipt_not_finalized' || (reason === 'alternating' && index % 2 === 1);
      advance(current().nextAttemptAt - h.store!.now()); await run();
      expect(current()).toMatchObject({ status: 'submitted', submission: submitted.submission, attempts: 0, finalityWaitAttempts: index + 1,
        lastError: receiptAvailable ? 'receipt_not_finalized' : 'submission_unconfirmed', nextAttemptAt: h.store!.now() + delay });
      expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.get(job.paymentKey)).toBe(h.store!.now() + delay);
      expect(current().alertPending).not.toBe(true); expect(h.alert).not.toHaveBeenCalled();
      expect(h.store!.strings.get(LICENSE_ACTIVE_SUBMISSION)).toBe(job.paymentKey);
    }
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
    for (const [args] of h.rpc.sendRawTransaction.mock.calls) expect(args.serializedTransaction).toBe(submitted.submission!.serializedTransaction);
  });
  it.each([true, false])('keeps the real attempt-10 repair/alert boundary across finality waits (submission: %s)', async (submitted) => {
    seed({ ...job, attempts: 8 });
    if (submitted) await run();
    else {
      h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf'
        ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true }
        : { id: BigInt(definition.tokenId), to: PAYER });
      h.rpc.getLogs.mockResolvedValue([{ transactionHash: KEY }]);
    }
    const original = h.rpc.getTransactionReceipt.getMockImplementation()!;
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash === TX ? original(args) : { ...mintReceipt(args.hash), blockNumber: 101n });
    for (let count = 1; count <= 6; count++) {
      advance(current().nextAttemptAt - h.store!.now()); await run();
      expect(current()).toMatchObject({ attempts: count <= 2 ? 8 : 9, finalityWaitAttempts: count,
        status: submitted ? 'submitted' : 'retryable', nextAttemptAt: h.store!.now() + (count <= 5 ? 60_000 : 300_000) });
      expect(h.alert).not.toHaveBeenCalled(); expect(current().alertPending).not.toBe(true);
      if (count === 2) {
        advance(current().nextAttemptAt - h.store!.now()); h.rpc.getBlock.mockRejectedValueOnce(new Error('RPC unavailable')); await run();
        expect(current()).toMatchObject({ attempts: 9, finalityWaitAttempts: 2, nextAttemptAt: h.store!.now() + licenseBackoff(9) });
        expect(h.alert).not.toHaveBeenCalled();
      }
    }
    advance(current().nextAttemptAt - h.store!.now()); h.rpc.getBlock.mockRejectedValueOnce(new Error('RPC unavailable')); await run();
    expect(current()).toMatchObject({ status: submitted ? 'submitted' : 'needs_repair', attempts: 10, finalityWaitAttempts: 6,
      nextAttemptAt: h.store!.now() + licenseBackoff(10), alertedAt: h.store!.now(), alertPending: false });
    expect(h.alert).toHaveBeenCalledTimes(1); expect(h.wallet.signTransaction).toHaveBeenCalledTimes(submitted ? 1 : 0);
  });
  it('accepts legacy jobs without a wait counter and isolates corrupt wait counters', () => {
    expect(parseLicenseJob(JSON.stringify(job))).toEqual(job);
    for (const finalityWaitAttempts of [-1, 1.5, '5', null]) {
      expect(parseLicenseJob(JSON.stringify({ ...job, finalityWaitAttempts }))).toBeNull();
    }
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
  it('runs the index repair only in the first run of each UTC hour (KV command budget)', async () => {
    // REBUILD always writes its cursor key, so the key's presence shows whether the repair ran.
    // NOW = 2027-01-15T08:00Z。08:20 は窓 (0〜14 分) の外 → 09:05 で修復。
    const cursor = 'store:license:repair:mint';
    advance(20 * 60_000);
    await runLicenseWorker();
    expect(h.store!.strings.has(cursor)).toBe(false);
    advance(45 * 60_000);
    await runLicenseWorker();
    expect(h.store!.strings.get(cursor)).toBeDefined();
  });
  // kvEval は Redis の値の形までしか確かめない。REBUILD の件数 (数) でない応答は `< 0` が false になるが、修復済みと読まない。
  it('repairLicenseIndexes: a non-numeric REBUILD reply is a failed repair, not success', async () => {
    h.reply = async (script, run) => script.includes('nextOffset') ? null : run();
    expect(await repairLicenseIndexes(NOW)).toBe(false);
    h.reply = null;
    expect(await repairLicenseIndexes(NOW)).toBe(true);
  });
  // REBUILD が拾うのは 1 ページ (最大 limit 件) だけ。limit を超える件数・整数でない件数は script の応答ではない。
  it.each([101, 2.5])('repairLicenseIndexes: a REBUILD count outside 0..limit (%s for limit 50) is a failed repair', async (count) => {
    h.reply = async (script, run) => script.includes('nextOffset') ? count : run();
    expect(await repairLicenseIndexes(NOW, 50)).toBe(false);
  });
  it('isLicenseRepairRun: true only for minutes 0-14 of each UTC hour (15-minute cron・hourly repair)', () => {
    expect([0, 14, 15, 30, 45, 59].map((minute) => isLicenseRepairRun(Date.UTC(2026, 8, 26, 10, minute)))).toEqual([true, true, false, false, false, false]);
    expect([0, 5, 13, 23].every((hour) => isLicenseRepairRun(Date.UTC(2026, 8, 26, hour, 3)))).toBe(true);
  });
  it('isolates corrupt jobs and leaves them in the permanent index', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const bad = toHex(123n, { size: 32 }); h.store!.zsets.set(LICENSE_DUE_INDEX, new Map([[bad, NOW - 1], [job.paymentKey, NOW]]));
    expect(await runLicenseWorker()).toMatchObject({ failed: 1, processed: 1 }); expect(current().status).toBe('submitted');
    expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.has(bad)).toBe(false);
    expect(h.store!.zsets.get('store:license:repair:quarantine')?.has('mint:' + bad)).toBe(true);
    expect(warn).not.toHaveBeenCalledWith('license.worker_quarantine_failed', expect.anything());
  });
  // 2026-10-12 (Grok 再レビュー): 隔離 (QUARANTINE) の応答を捨てない。1 以外 (0 = worker lock を失った・-1 = key の型/時刻が
  // 不正・KV 障害・想定外の応答) は隔離されていないので warn を残す。挙動は従来どおり (job_corrupt で次の member へ進む)。
  it.each([
    [0, 'lock_lost'], [-1, 'invalid_state'], ['1', 'unexpected_reply'], ['kv-failure', 'storage'],
  ] as const)('warns when a corrupt job is not quarantined (reply %s → %s) and keeps processing the next member', async (reply, outcome) => {
    const warn = vi.spyOn(logger, 'warn');
    const bad = toHex(123n, { size: 32 }); h.store!.zsets.set(LICENSE_DUE_INDEX, new Map([[bad, NOW - 1], [job.paymentKey, NOW]]));
    const isQuarantine = (script: string) => script.includes('ipairs({2,3})');
    if (reply === 'kv-failure') h.failEval = isQuarantine;
    else h.reply = async (script, run) => isQuarantine(script) ? reply : run();
    expect(await runLicenseWorker()).toMatchObject({ failed: 1, processed: 1 }); expect(current().status).toBe('submitted');
    expect(warn).toHaveBeenCalledWith('license.worker_quarantine_failed', expect.objectContaining({ member: bad, outcome }));
    expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.has(bad)).toBe(true);
    expect(h.store!.zsets.get('store:license:repair:quarantine')?.has('mint:' + bad) ?? false).toBe(false);
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
    await runLicenseWorker({ member }); const submitted = JSON.parse(h.store!.strings.get(key)!); expect(submitted).toMatchObject({ kind: 'register', status: 'submitted', attempts: 0, nextAttemptAt: NOW + 60_000 });
    const args = [BigInt(definition.tokenId), BigInt(definition.supply), definition.transferable, 'https://open-pay.jp/api/license/metadata/' + ID, definition.definitionHash];
    expect(h.rpc.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'registerLicense', args }));
    expect(decodeFunctionData({ abi: LICENSE_ABI, data: h.wallet.prepareTransactionRequest.mock.calls[0][0].data })).toEqual({ functionName: 'registerLicense', args });
    expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.get(member)).toBe(NOW + 60_000);
    advance(60_000); h.rpc.readContract.mockResolvedValue({ exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true }); h.rpc.getTransactionReceipt.mockResolvedValue(mintReceipt(submitted.submission.hash));
    await runLicenseWorker({ member }); expect(h.confirm).toHaveBeenCalledWith(ID, submitted.submission.hash, h.rpc); expect(JSON.parse(h.store!.strings.get(key)!).status).toBe('registered');
  });
  it('flag OFF never acquires a lock or dispatches RPC; relay key reuse never signs', async () => {
    h.enabled = false; await run(); expect(h.store!.strings.has(LICENSE_WORKER_LOCK)).toBe(false); expect(h.rpc.getBlock).not.toHaveBeenCalled();
    h.enabled = true; vi.stubEnv('RELAYER_PRIVATE_KEY', KEY); await run(); expect(current()).toMatchObject({ status: 'needs_repair', lastError: 'minter_must_differ_from_relayer' }); expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });
});

// 第 10 回レビュー B3-1。送信枠 (worker:active) は「結果が未確定の署名」の nonce を隔離するためのもの。修復待ち (needs_repair) の
// ジョブが枠を持ったままだと、後続の全部の mint と登録が黙って止まる。結果が finalized で確定した回だけ枠を返し、
// needs_repair になった回は必ず warn (license.job_needs_repair) を残す。
describe('license worker: needs_repair の warn と送信枠 (B3-1)', () => {
  const lane = () => h.store!.strings.get(LICENSE_ACTIVE_SUBMISSION) ?? null;
  const repairWarns = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(([event]) => event === 'license.job_needs_repair');
  const licenseOf = { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true };
  // 自分の送信 (submission.hash) と scan で見つかる hash の receipt を差し替える。支払いの receipt (TX) は元のまま。
  function otherReceipts(make: (hash: Hex) => unknown) {
    const original = h.rpc.getTransactionReceipt.getMockImplementation()!;
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash === TX ? original(args) : make(args.hash));
  }
  const paymentKeyOf = (record: { id: bigint; to: string }) =>
    h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf' ? licenseOf : record);

  it('自分の送信が finalized で revert: needs_repair・枠を返す・warn は 1 回 (秘密なし)・次のジョブが送信できる', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await run(); const first = job; const signed = current();
    expect(lane()).toBe(first.paymentKey); expect(repairWarns(warn)).toHaveLength(0);
    otherReceipts((hash) => ({ ...mintReceipt(hash), status: 'reverted', logs: [] }));
    advance(60_000); await run();
    expect(current()).toMatchObject({ status: 'needs_repair', lastError: 'transaction_reverted', submission: signed.submission });
    expect(lane()).toBeNull();
    expect(repairWarns(warn)).toEqual([['license.job_needs_repair', { member: first.paymentKey, kind: 'mint', lastError: 'transaction_reverted', lane: 'release' }]]);
    const logged = JSON.stringify(repairWarns(warn));
    expect(logged).not.toContain(signed.submission!.serializedTransaction); expect(logged).not.toContain(KEY.slice(2));

    // 修復待ちのジョブ自身は二度と署名・送信しない (枠を返した後に同じ nonce を使い回す道が無い)。warn も繰り返さない。
    advance(); await run();
    expect(current()).toMatchObject({ status: 'needs_repair', submission: signed.submission });
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(repairWarns(warn)).toHaveLength(1);

    // 次の購入の発行は、止まらずに新しい nonce で送信できる。
    advance(); job = fixture(toHex(10n, { size: 32 })); seed(); h.rpc.getTransactionCount.mockResolvedValue(8);
    expect(job.paymentKey).not.toBe(first.paymentKey);
    await run();
    expect(current()).toMatchObject({ status: 'submitted', submission: { nonce: 8 } });
    expect(lane()).toBe(job.paymentKey);
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(2); expect(h.rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.store!.strings.get(licenseObligationKey(first.paymentKey))!)).toMatchObject({ status: 'needs_repair', submission: signed.submission });
  });

  it('finalized の nonce が進んだ置き換え (license なし): needs_repair・枠を返す・warn は 1 回', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await run(); const signed = current(); advance(); h.rpc.getTransactionCount.mockResolvedValue(8); await run();
    expect(current()).toMatchObject({ status: 'needs_repair', lastError: 'nonce_replaced_without_license', submission: signed.submission });
    expect(lane()).toBeNull();
    expect(repairWarns(warn)).toEqual([['license.job_needs_repair', { member: job.paymentKey, kind: 'mint', lastError: 'nonce_replaced_without_license', lane: 'release' }]]);
    expect(h.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  // Codex SHOULD 1: 自分の送信の finalized・canonical な receipt から出た不一致は、license の検証としては未解決 (needs_repair の
  // まま・運営の修復待ち) だが、nonce は使用済みと確定している。枠は返す。
  it('自分の送信の receipt から出た mint_receipt_mismatch: needs_repair のまま、nonce は確定しているので枠を返す', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await run(); const signed = current();
    otherReceipts((hash) => ({ ...mintReceipt(hash), logs: [] }));
    advance(); await run();
    expect(current()).toMatchObject({ status: 'needs_repair', lastError: 'mint_receipt_mismatch', submission: signed.submission });
    expect(lane()).toBeNull();
    expect(repairWarns(warn)).toEqual([['license.job_needs_repair', { member: job.paymentKey, kind: 'mint', lastError: 'mint_receipt_mismatch', lane: 'release' }]]);
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  // 自分の送信の nonce の結果が確定したと言えない修復理由は、今までどおり枠を保持する (署名済みの tx がまだ取り込まれうる・
  // 決め手の読み取り自体が矛盾している・または送信の前の照合で止まっている)。
  it.each([
    ['signed_transaction_mismatch', () => { const s = current(); seed({ ...s, submission: { ...s.submission!, nonce: s.submission!.nonce + 1 } }); }],
    // 自分の送信は成功で license もあるが、成功を保存する前の head の確認 (stableHead) で head が変わった (finality の不整合)。
    ['finality_changed', () => {
      paymentKeyOf({ id: BigInt(definition.tokenId), to: PAYER }); otherReceipts((hash) => mintReceipt(hash));
      let headReads = 0;
      h.rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 100n, hash: blockNumber === 100n && ++headReads === 2 ? TX : BLOCK }));
    }],
    ['receipt_reorg_or_mismatch', () => otherReceipts((hash) => ({ ...mintReceipt(hash), blockHash: TX }))],
    ['definition_mismatch', () => h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true : functionName === 'licenseOf' ? { ...licenseOf, maxSupply: 9n } : { id: 0n, to: zeroAddress })],
    ['consumed_key_mismatch', () => paymentKeyOf({ id: BigInt(definition.tokenId), to: CONTRACT })],
    ['payment_tuple_mismatch', () => h.rpc.getTransactionReceipt.mockResolvedValue({ transactionHash: TX, blockNumber: 50n, blockHash: BLOCK, status: 'success', logs: [] })],
    // scan で見つけた別の hash の revert (イベントがあるのに revert = RPC の矛盾)。自分の送信の結果は分からないまま。
    ['transaction_reverted', () => {
      const found = toHex(55n, { size: 32 });
      paymentKeyOf({ id: BigInt(definition.tokenId), to: PAYER }); h.rpc.getLogs.mockResolvedValue([{ transactionHash: found }]);
      otherReceipts((hash) => { if (hash !== found) throw new Error('not found'); return { ...mintReceipt(found), status: 'reverted', logs: [] }; });
    }],
  ] as const)('未確定の %s: needs_repair でも枠は保持し、warn は lane keep', async (lastError, arrange) => {
    const warn = vi.spyOn(logger, 'warn');
    await run(); const signed = current(); arrange(); advance(); await run();
    expect(current()).toMatchObject({ status: 'needs_repair', lastError, submission: { hash: signed.submission!.hash } });
    expect(lane()).toBe(job.paymentKey);
    expect(repairWarns(warn)).toEqual([['license.job_needs_repair', { member: job.paymentKey, kind: 'mint', lastError, lane: 'keep' }]]);
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('送信していないジョブの 10 回目の失敗も warn を 1 回残す (枠には触れない)', async () => {
    const warn = vi.spyOn(logger, 'warn');
    h.store!.strings.set(LICENSE_ACTIVE_SUBMISSION, job.paymentKey);
    seed({ ...job, attempts: 9 }); h.rpc.simulateContract.mockRejectedValue(new Error('receiver revert 0xdeadbeef')); await run();
    expect(current()).toMatchObject({ status: 'needs_repair', attempts: 10, lastError: 'rpc_or_funding_failure' });
    expect(repairWarns(warn)).toEqual([['license.job_needs_repair', { member: job.paymentKey, kind: 'mint', lastError: 'rpc_or_funding_failure', lane: 'keep' }]]);
    expect(JSON.stringify(repairWarns(warn))).not.toContain('deadbeef');
    // RPC・資金不足の失敗は job の中で再試行に回り、license.worker_job_failed には出ない。運営に届くのはこの warn だけ。
    expect(warn).not.toHaveBeenCalledWith('license.worker_job_failed', expect.anything());
    expect(lane()).toBe(job.paymentKey);
  });

  // Codex SHOULD 2: 送信済みで結果を確かめられないジョブは submitted のまま枠を持ち続ける (nonce の安全のため返さない)。
  // needs_repair の warn の対象外なので、attempt 10 に届いた回に 1 回だけ license.job_submission_stalled を残す。
  const stalledWarns = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(([event]) => event === 'license.job_submission_stalled');
  it('送信済みで結果を確かめられないまま attempt 10: submitted のまま枠を保持し、stalled の warn は 1 回だけ (秘密なし)', async () => {
    const warn = vi.spyOn(logger, 'warn');
    h.rpc.sendRawTransaction.mockRejectedValue(new Error('network disconnected 0xdeadbeef')); await run(); const submitted = current();
    seed({ ...submitted, attempts: 8 });
    for (const attempts of [9, 10, 11, 12]) {
      advance(); await run();
      expect(current()).toMatchObject({ status: 'submitted', attempts, lastError: 'rpc_or_funding_failure', submission: submitted.submission });
    }
    expect(stalledWarns(warn)).toEqual([['license.job_submission_stalled', { member: job.paymentKey, kind: 'mint', lastError: 'rpc_or_funding_failure', attempts: 10 }]]);
    const logged = JSON.stringify(stalledWarns(warn));
    expect(logged).not.toContain('deadbeef'); expect(logged).not.toContain(submitted.submission!.serializedTransaction);
    expect(repairWarns(warn)).toHaveLength(0);
    expect(lane()).toBe(job.paymentKey);
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.alert).toHaveBeenCalledTimes(1);
  });

  // scan の道 (自分の送信の receipt を直接読めず、ログで別の hash を見つけた回) は、見つけた hash が自分の送信と言えないので
  // 枠を返さない。complete の後の return で、attempt 10 に届いた回の通知を飛ばさない。
  it('scan で見つけた hash の登録の確認が保留のまま attempt 10: 枠は保持し、その run で通知と stalled の warn を出す', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const member = 'registration:' + ID; const key = licenseRegistrationJobKey(ID);
    const read = () => JSON.parse(h.store!.strings.get(key)!);
    h.store!.strings.set(key, JSON.stringify({ version: 1, kind: 'register', productId: ID, license: definition, status: 'pending', attempts: 0, nextAttemptAt: NOW }));
    h.rpc.readContract.mockResolvedValue({ exists: false }); h.rpc.sendRawTransaction.mockResolvedValue(TX);
    await runLicenseWorker({ member });
    const signed = read(); expect(lane()).toBe(member);
    h.store!.strings.set(key, JSON.stringify({ ...signed, attempts: 9 }));
    const found = toHex(55n, { size: 32 });
    h.rpc.readContract.mockResolvedValue(licenseOf); h.rpc.getLogs.mockResolvedValue([{ transactionHash: found }]);
    h.rpc.getTransactionReceipt.mockImplementation(async ({ hash }) => { if (hash !== found) throw new Error('not found'); return mintReceipt(found); });
    h.confirm.mockResolvedValue('pending');
    advance(); await runLicenseWorker({ member });
    expect(h.confirm).toHaveBeenCalledWith(ID, found, h.rpc);
    expect(read()).toMatchObject({ status: 'submitted', attempts: 10, lastError: 'registration_pending', alertPending: false, submission: signed.submission });
    expect(lane()).toBe(member);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(stalledWarns(warn)).toEqual([['license.job_submission_stalled', { member, kind: 'register', lastError: 'registration_pending', attempts: 10 }]]);
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
  });
});

// 第 10 回レビュー Codex MUST 1 の再現。最初の finalized の head の読み取りは履歴 A (既定の mock どおり全 block の hash が BLOCK)、
// その後の決め手の読み取り (自分の送信の receipt・finalized の nonce) からは、91 番から分かれた履歴 B に当たる (負荷分散の先の
// ノードが変わる)。B では自分の送信が revert している・nonce が進んでいるが、A の head の高さで finalized と見なして枠を返すと、
// B が巻き戻った後に nonce 7 が空き、ほかのジョブが同じ nonce を署名する。関所の head の確認で見つけ、修復待ちにせず枠を
// 保持したまま次の run でやり直す。次の nonce は固定せず、場面ごとの pending の数 (巻き戻った後 7・確定した後 8) から取る。
describe('license worker: 枠を返す関所の head の確認 (Codex MUST 1)', () => {
  const lane = () => h.store!.strings.get(LICENSE_ACTIVE_SUBMISSION) ?? null;
  const ID2 = 'h_' + 'b'.repeat(32);
  const definition2 = createLicenseDefinition(ID2, { supply: 10, transferable: true, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 80002, CONTRACT);
  const member2 = 'registration:' + ID2;
  const hashOnB = (n: bigint) => toHex(1000n + n, { size: 32 });
  const nonces = () => h.wallet.signTransaction.mock.calls.map(([tx]) => tx.nonce);

  it.each([['mint', 'reverted'], ['mint', 'nonce'], ['register', 'reverted'], ['register', 'nonce']] as const)(
    '%s・%s: 決め手を別の履歴で読んだ回は枠を返さず修復待ちにもしない → 巻き戻った nonce をほかのジョブが署名しない → 一貫した回に返す',
    async (kind, branch) => {
      const warn = vi.spyOn(logger, 'warn');
      // 1) 自分のジョブ (job1) が nonce 7 を署名・送信し、枠を持つ。
      let member1: string; let key1: string;
      if (kind === 'mint') {
        member1 = job.paymentKey; key1 = licenseObligationKey(job.paymentKey);
        await run();
      } else {
        member1 = 'registration:' + ID; key1 = licenseRegistrationJobKey(ID);
        h.store!.strings.set(key1, JSON.stringify({ version: 1, kind: 'register', productId: ID, license: definition, status: 'pending', attempts: 0, nextAttemptAt: NOW }));
        h.rpc.readContract.mockResolvedValue({ exists: false }); h.rpc.sendRawTransaction.mockResolvedValue(TX);
        await runLicenseWorker({ member: member1 });
      }
      const read1 = () => JSON.parse(h.store!.strings.get(key1)!);
      const signed = read1(); const hash1 = signed.submission.hash as Hex;
      expect(signed).toMatchObject({ status: 'submitted', submission: { nonce: 7 } }); expect(lane()).toBe(member1);

      let onB = false;
      h.rpc.getBlock.mockImplementation(async ({ blockNumber }) => blockNumber === undefined
        ? { number: 100n, hash: BLOCK } : { number: blockNumber, hash: onB && blockNumber > 90n ? hashOnB(blockNumber) : BLOCK });
      // mint の商品 (ID) は登録済み。登録ジョブの商品 (kind が register の ID・ほかのジョブの ID2) は未登録。
      h.rpc.readContract.mockImplementation(async ({ functionName, args }) => functionName === 'authorizationState' ? true
        : functionName === 'licenseOf' ? kind === 'mint' && args[0] === BigInt(definition.tokenId) ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true } : { exists: false }
          : { id: 0n, to: zeroAddress });
      h.rpc.sendRawTransaction.mockImplementation(async ({ serializedTransaction }) => keccak256(serializedTransaction));
      const paymentReceipt = h.rpc.getTransactionReceipt.getMockImplementation()!;
      const ownReceipt = (blockHash: Hex | null) => h.rpc.getTransactionReceipt.mockImplementation(async (args) => {
        if (args.hash !== hash1) return paymentReceipt(args);
        if (blockHash === null) throw new Error('not found');
        if (blockHash !== BLOCK) onB = true;
        return { transactionHash: hash1, blockNumber: 95n, blockHash, status: 'reverted', logs: [] };
      });

      // 2) 決め手を B で読む: revert は B の 95 番の receipt、nonce は B の高さ 100 で 8。
      ownReceipt(branch === 'reverted' ? hashOnB(95n) : null);
      h.rpc.getTransactionCount.mockImplementation(async ({ blockTag }) => { if (blockTag === 'pending') return 7; onB = true; return 8; });
      advance(); await runLicenseWorker({ member: member1 });
      expect(onB).toBe(true);
      expect(read1()).toMatchObject({ status: 'submitted', attempts: 1, lastError: 'finalized_head_changed', submission: signed.submission });
      expect(lane()).toBe(member1);
      expect(warn).not.toHaveBeenCalledWith('license.job_needs_repair', expect.anything());

      // 3) B が巻き戻った後 (読み取りは A・job1 の tx は無い・nonce 7 は空き)。ほかのジョブ (登録 job2) は枠が空かず署名しない。
      onB = false; ownReceipt(null); h.rpc.getTransactionCount.mockResolvedValue(7);
      h.store!.strings.set(licenseRegistrationJobKey(ID2), JSON.stringify({ version: 1, kind: 'register', productId: ID2, license: definition2, status: 'pending', attempts: 0, nextAttemptAt: h.store!.now() }));
      advance(); await runLicenseWorker({ member: member2 });
      expect(nonces()).toEqual([7]); expect(lane()).toBe(member1);

      // 4) RPC が一貫した回 (A で job1 の結果が確定): 関所を通って修復待ちになり枠を返す → job2 は次の nonce 8 で送信できる。
      ownReceipt(branch === 'reverted' ? BLOCK : null); h.rpc.getTransactionCount.mockResolvedValue(8);
      advance(); await runLicenseWorker({ member: member1 });
      expect(read1()).toMatchObject({ status: 'needs_repair', lastError: branch === 'reverted' ? 'transaction_reverted' : 'nonce_replaced_without_license', submission: signed.submission });
      expect(lane()).toBeNull();
      expect(warn).toHaveBeenCalledWith('license.job_needs_repair', expect.objectContaining({ member: member1, lane: 'release' }));
      advance(); await runLicenseWorker({ member: member2 });
      expect(nonces()).toEqual([7, 8]); expect(lane()).toBe(member2);
    });
});

// 第 10 回レビュー B3-2。登録 tx は finalized で成功しているのに、確認の RPC の間に出品者が商品 (題など) を編集すると、
// registered を書く CAS が 0 を返す。これを不一致 (conflict → needs_repair) にすると、登録済みの商品が登録待ちのまま固まる。
// ここは本物の confirmLicenseRegistration と CONFIRM の Lua を通す (fake は RPC・商品 snapshot の読込・KV の store だけ)。
describe('license worker: 登録の確認と出品者の編集の競合 (B3-2)', () => {
  const member = 'registration:' + ID; const jobKey = licenseRegistrationJobKey(ID); const productKey = 'x402:hosted:' + ID;
  const readJob = () => JSON.parse(h.store!.strings.get(jobKey)!);
  const readProduct = () => JSON.parse(h.store!.strings.get(productKey)!);
  const lane = () => h.store!.strings.get(LICENSE_ACTIVE_SUBMISSION) ?? null;
  const registrationReceipt = (hash: Hex, withEvent = true) => ({ transactionHash: hash, blockNumber: 90n, blockHash: BLOCK, status: 'success', logs: withEvent ? [{ address: CONTRACT,
    topics: encodeEventTopics({ abi: LICENSE_ABI, eventName: 'LicenseRegistered', args: { id: BigInt(definition.tokenId) } }),
    data: encodeAbiParameters([{ type: 'uint64' }, { type: 'bool' }, { type: 'bytes32' }], [10n, true, definition.definitionHash]) }] : [] });
  /** 登録 tx を送信済み (枠を保持) にして、その hash を返す。 */
  async function submitRegistration(): Promise<Hex> {
    h.confirm.mockImplementation(h.realConfirm!);
    h.snapshot.mockImplementation(async (id: string) => {
      const token = h.store!.strings.get('x402:hosted:' + id);
      if (token === undefined) return null;
      const snapshot = { product: JSON.parse(token), token };
      const hook = h.afterSnapshot; h.afterSnapshot = null; hook?.();
      return snapshot;
    });
    h.store!.strings.set(productKey, JSON.stringify({ id: ID, productKind: 'license', title: 'License', license: definition, saleActive: false, registration: { status: 'pending', attempts: 0 }, updatedAt: 1 }));
    h.store!.strings.set(jobKey, JSON.stringify({ version: 1, kind: 'register', productId: ID, license: definition, status: 'pending', attempts: 0, nextAttemptAt: NOW }));
    h.rpc.readContract.mockResolvedValue({ exists: false }); h.rpc.sendRawTransaction.mockResolvedValue(TX);
    await runLicenseWorker({ member });
    expect(readJob().status).toBe('submitted'); expect(lane()).toBe(member);
    h.rpc.readContract.mockResolvedValue({ exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true });
    return readJob().submission.hash;
  }

  it('確認の RPC の間に商品が書き換わった回は保留で、nonce は確定しているので枠はその回に返す → 次の run で registered (編集は残る)', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const hash = await submitRegistration();
    h.rpc.getTransactionReceipt.mockImplementation(async () => registrationReceipt(hash));
    h.afterSnapshot = () => h.store!.strings.set(productKey, h.store!.strings.get(productKey)!.replace('"title":"License"', '"title":"Edited"'));
    advance(60_000); await runLicenseWorker({ member });
    expect(readJob()).toMatchObject({ status: 'submitted', attempts: 1, lastError: 'registration_pending' });
    expect(readProduct()).toMatchObject({ title: 'Edited', registration: { status: 'pending', attempts: 0 } });
    expect(lane()).toBeNull();
    expect(warn).not.toHaveBeenCalledWith('license.job_needs_repair', expect.anything());

    advance(); await runLicenseWorker({ member });
    expect(readJob()).toMatchObject({ status: 'registered', mintTxHash: hash });
    expect(readProduct()).toMatchObject({ title: 'Edited', saleActive: false, registration: { status: 'registered', txHash: hash, attempts: 0 } });
    expect(lane()).toBeNull();
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
  });

  // Codex SHOULD 1: 自分の送信の receipt から出た不一致は license の検証として未解決 (needs_repair・商品は登録待ち) だが、
  // nonce は finalized の receipt で使用済みと確定している。
  it('自分の送信の receipt に LicenseRegistered が無い (本物の不一致) は needs_repair で商品は登録待ちのまま、枠は返す', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const hash = await submitRegistration();
    h.rpc.getTransactionReceipt.mockImplementation(async () => registrationReceipt(hash, false));
    advance(60_000); await runLicenseWorker({ member });
    expect(readJob()).toMatchObject({ status: 'needs_repair', lastError: 'registration_receipt_mismatch' });
    expect(readProduct()).toMatchObject({ title: 'License', registration: { status: 'pending' } });
    expect(lane()).toBeNull();
    expect(warn).toHaveBeenCalledWith('license.job_needs_repair', { member, kind: 'register', lastError: 'registration_receipt_mismatch', lane: 'release' });
  });

  // Codex MUST 2 の再現: 登録の tx は finalized で成功しているのに、確認の CAS が出品者の編集と 12 回続けて衝突する。枠を持った
  // ままだと後続の全部の発行と登録が止まり、submitted のままなので needs_repair の warn も出ず、complete の後の return で
  // 通知も飛んでいた。枠は最初の確認の回で返し、確認のやり直しは続け、attempt 10 で warn と通知を 1 回ずつ出す。
  it('確認の CAS が 12 回続けて衝突: 枠は最初の回に返り、ほかのジョブが送信でき、登録ジョブは署名し直さず、stalled の warn と通知が 1 回ずつ', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const paymentReceipt = h.rpc.getTransactionReceipt.getMockImplementation()!;
    const hash = await submitRegistration();
    h.rpc.getTransactionReceipt.mockImplementation(async (args) => args.hash === hash ? registrationReceipt(hash) : paymentReceipt(args));
    h.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'authorizationState' ? true
      : functionName === 'licenseOf' ? { exists: true, definitionHash: definition.definitionHash, maxSupply: 10n, transferable: true } : { id: 0n, to: zeroAddress });
    // 登録の nonce 7 は finalized で使用済みなので、ほかのジョブの次の nonce は 8。
    h.rpc.getTransactionCount.mockResolvedValue(8);
    for (let collision = 1; collision <= 12; collision++) {
      h.afterSnapshot = () => h.store!.strings.set(productKey, h.store!.strings.get(productKey)!.replace(/"title":"[^"]*"/, `"title":"Edited ${collision}"`));
      advance(Math.max(60_000, readJob().nextAttemptAt - h.store!.now())); await runLicenseWorker({ member });
      expect(readJob()).toMatchObject({ status: 'submitted', attempts: collision, lastError: 'registration_pending', submission: { hash } });
      expect(readProduct()).toMatchObject({ title: `Edited ${collision}`, registration: { status: 'pending' } });
      if (collision === 1) {
        expect(lane()).toBeNull();
        // ほかのジョブ (発行) が止まらずに次の nonce で送信できる。以後の登録ジョブの回は、その枠を消さない (Lua は持ち主だけ消す)。
        advance(); await runLicenseWorker({ member: job.paymentKey });
        expect(JSON.parse(h.store!.strings.get(licenseObligationKey(job.paymentKey))!)).toMatchObject({ status: 'submitted', submission: { nonce: 8 } });
      }
      expect(lane()).toBe(job.paymentKey);
    }
    // 枠を返した後の登録ジョブは、送った hash の確認だけを続け、署名・送信をし直していない (2 回目はほかのジョブの発行)。
    expect(h.wallet.signTransaction.mock.calls.map(([tx]) => tx.nonce)).toEqual([7, 8]); expect(h.rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.filter(([event]) => event === 'license.job_submission_stalled'))
      .toEqual([['license.job_submission_stalled', { member, kind: 'register', lastError: 'registration_pending', attempts: 10 }]]);
    expect(warn).not.toHaveBeenCalledWith('license.job_needs_repair', expect.anything());
    expect(h.alert).toHaveBeenCalledTimes(1); expect(h.alert).toHaveBeenCalledWith('https://alerts.example', expect.stringContaining(member));
    expect(readJob()).toMatchObject({ alertPending: false, alertedAt: expect.any(Number) });

    // 編集が止まれば、その回に registered (最後の編集は残る)。ほかのジョブの枠はそのまま。
    advance(readJob().nextAttemptAt - h.store!.now()); await runLicenseWorker({ member });
    expect(readJob()).toMatchObject({ status: 'registered', mintTxHash: hash });
    expect(readProduct()).toMatchObject({ title: 'Edited 12', registration: { status: 'registered', txHash: hash } });
    expect(lane()).toBe(job.paymentKey);
  });
});
