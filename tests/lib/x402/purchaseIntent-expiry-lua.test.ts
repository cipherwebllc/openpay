// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, getAddress, toHex, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  failTerminalCas: false,
  client: {
    getBlock: vi.fn(),
    getBlockNumber: vi.fn(),
    readContract: vi.fn(),
    getLogs: vi.fn(),
    getTransactionReceipt: vi.fn(),
  },
}));
vi.mock('viem', async (original) => ({
  ...await original<typeof import('viem')>(),
  createPublicClient: () => h.client,
}));
vi.mock('@/lib/env', () => ({ env: { enableCreatorStore: true, networkEnv: 'testnet' } }));
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => ({}), transportForChain: () => ({}) }));
vi.mock('@/lib/x402/hostedStore', () => ({ hostedContentKey: (id: string, revision: number) => 'x402:hosted:' + id + ':content:' + revision }));
vi.mock('@/lib/x402/facilitatorSettle', () => ({ parseFacilitatorRequest: vi.fn() }));
vi.mock('@/lib/x402/paymentRedelivery', () => ({ paymentRedeliveryIdentity: vi.fn() }));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: h.store!.strings.get(key) ?? null }),
  kvSet: async (key: string, value: string, options?: { nx?: boolean; ttlSec?: number }) => {
    if (options?.nx && h.store!.strings.has(key)) return { ok: true, value: null };
    h.store!.strings.set(key, value);
    if (options?.ttlSec) h.store!.setTtl(key, options.ttlSec);
    return { ok: true, value: 'OK' };
  },
  kvEval: async (script: string, keys: string[], args: string[]) => {
    if (h.failTerminalCas && args.some((arg) => arg.includes('"state":"failed_prebroadcast"'))) {
      return { ok: false, reason: 'network_error' };
    }
    return { ok: true, value: await runRedisLua(script, keys, args, h.store!) };
  },
}));

import {
  claimPurchaseSettlement, claimSignedPurchaseIntent, createQuotedPurchaseIntent,
  getPurchaseIntent, markPurchaseIndeterminate, purchaseIntentKey,
  reconcilePurchaseIntent, recordPurchaseTransaction, type PurchaseAuthorizationClaim,
} from '@/lib/x402/purchaseIntent';
import {
  claimSignedStoreUsdcIntent, claimStoreUsdcSettlement, createQuotedStoreUsdcIntent,
  getStoreUsdcIntent, markStoreUsdcIndeterminate, reconcileStoreUsdcIntent,
  recordStoreUsdcTransaction, storeUsdcAuthorizationHash, storeUsdcIntentKey,
} from '@/lib/x402/storeUsdcIntent';
import { associateStoreRailIntent, claimStoreRailSelection, railParentArchiveKey } from '@/lib/x402/storeRailSelection';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { AUTHORIZATION_CANCELED_EVENT } from '@/lib/x402/authorizationCancel';
import { JPYC_V3_ASSET } from '@/lib/x402/types';

const NOW = 1_800_000_000_000;
const SALT = toHex(1n, { size: 32 });
const TX = toHex(2n, { size: 32 });
const REPLACEMENT = toHex(3n, { size: 32 });
const BLOCK_HASH = toHex(4n, { size: 32 });
const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FORWARDER = getAddress('0x3333333333333333333333333333333333333333');
const RESOURCE = 'h_' + 'a'.repeat(32);
const META = { owner: MERCHANT, payTo: MERCHANT, title: 'Product', priceJpyc: '1000', contentKind: 'text' as const, label: 'prompt' as const };
type Rail = 'jpyc' | 'usdc';
type State = 'signed' | 'settling' | 'indeterminate';

async function setup(rail: Rail, state: State, withHash = true) {
  let nonce: Hex;
  let authorizationHash: string;
  let validBefore: bigint;
  const key = rail === 'jpyc' ? purchaseIntentKey(SALT) : storeUsdcIntentKey(SALT);
  if (rail === 'jpyc') {
    const quoted = await createQuotedPurchaseIntent({
      resourceId: RESOURCE, contentRevision: 1, metadata: META, payer: PAYER,
      token: JPYC_V3_ASSET.address, chainId: 80002, forwarder: FORWARDER,
      merchant: MERCHANT, merchantValue: 1000n, feeReceiver: FORWARDER, feeValue: 10n,
      anchorBlock: 1n, now: NOW, intentSalt: SALT,
    });
    if (!quoted.ok) throw new Error(quoted.reason);
    const q = quoted.intent;
    validBefore = BigInt(q.authorizationValidBeforeMax);
    nonce = buildForwarderNonce({ from: PAYER, merchant: MERCHANT, merchantValue: 1000n, feeReceiver: FORWARDER, feeValue: 10n, validAfter: 0n, validBefore, intentSalt: SALT }, q.chainId, FORWARDER);
    const claim: PurchaseAuthorizationClaim = { payer: PAYER, token: q.token, chainId: q.chainId, forwarder: FORWARDER, commitVersion: q.commitVersion, merchant: MERCHANT, merchantValue: q.merchantValue, feeReceiver: FORWARDER, feeValue: q.feeValue, validAfter: '0', validBefore: String(validBefore), nonce, signatureFingerprint: 'a'.repeat(64), resourceId: RESOURCE, contentRevision: 1, deploymentVersion: q.deploymentVersion, anchorBlock: '1' };
    authorizationHash = createHash('sha256').update(JSON.stringify(claim)).digest('hex');
    expect(await claimSignedPurchaseIntent({ intentSalt: SALT, claim, authorizationHash, now: NOW + 1000 })).toMatchObject({ ok: true });
    if (state !== 'signed') {
      const started = await claimPurchaseSettlement({ intentSalt: SALT, claim, now: NOW + 2000 });
      if (!started.ok || started.kind !== 'claimed') throw new Error('settlement claim failed');
      const attempt = { intentSalt: SALT, attemptId: started.intent.attemptId, now: NOW + 3000 };
      if (withHash) expect(await recordPurchaseTransaction({ ...attempt, txHash: TX })).toBe('updated');
      if (state === 'indeterminate') expect(await markPurchaseIndeterminate(attempt)).toBe('updated');
    }
  } else {
    const quoted = await createQuotedStoreUsdcIntent({ resourceId: RESOURCE, contentRevision: 1, metadata: META, payer: PAYER, usdcQuoteAtomic: '2000000', rateScaled: '150000000', rateFetchedAt: NOW, rounding: 'ceil', fxQuoteExpiresAt: NOW + 180_000, anchorBlock: 1n, now: NOW, intentSalt: SALT });
    if (!quoted.ok) throw new Error(quoted.reason);
    validBefore = BigInt(quoted.intent.authorizationValidBeforeMax);
    nonce = quoted.intent.nonce;
    const claim = { payer: PAYER, to: MERCHANT, value: quoted.intent.usdcQuoteAtomic, validAfter: '0', validBefore: String(validBefore), nonce, signatureFingerprint: 'a'.repeat(64) };
    authorizationHash = storeUsdcAuthorizationHash(claim);
    expect(await claimSignedStoreUsdcIntent({ intentSalt: SALT, claim, authorizationHash, now: NOW + 1000 })).toMatchObject({ ok: true });
    if (state !== 'signed') {
      const started = await claimStoreUsdcSettlement({ intentSalt: SALT, now: NOW + 2000 });
      if (!started.ok || started.kind !== 'claimed') throw new Error('settlement claim failed');
      const attempt = { intentSalt: SALT, attemptId: started.intent.attemptId, now: NOW + 3000 };
      if (withHash) expect(await recordStoreUsdcTransaction({ ...attempt, txHash: TX })).toBe('updated');
      if (state === 'indeterminate') expect(await markStoreUsdcIndeterminate(attempt)).toBe('updated');
    }
  }
  const parent = await associateStoreRailIntent({ intentSalt: SALT, intentKey: key, payer: PAYER, resourceId: RESOURCE, contentRevision: 1, now: NOW });
  if (!parent.ok) throw new Error(parent.reason);
  expect(await claimStoreRailSelection({ ...parent, intentSalt: SALT, intentKey: key, payer: PAYER, resourceId: RESOURCE, contentRevision: 1, rail, authorizationHash })).toMatchObject({ ok: true });
  h.client.getBlock.mockResolvedValue({ number: 500n, hash: BLOCK_HASH, timestamp: validBefore + 1n });
  const reconcile = (now = Number(validBefore + 100n) * 1000) => rail === 'jpyc'
    ? reconcilePurchaseIntent(SALT, { now })
    : reconcileStoreUsdcIntent(SALT, { now, client: h.client });
  const read = () => rail === 'jpyc' ? getPurchaseIntent(SALT) : getStoreUsdcIntent(SALT);
  return { key, nonce, validBefore, reconcile, read, parentId: parent.parentIntentId,
    pendingKey: rail === 'jpyc' ? 'store:intent:pending' : 'store:usdc:intent:pending',
    activeKey: `store:rail:active:${PAYER.toLowerCase()}:${RESOURCE}:1` };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.store = createFakeRedisStore(NOW);
  h.failTerminalCas = false;
  h.client.readContract.mockResolvedValue(false);
  h.client.getBlockNumber.mockResolvedValue(500n);
  h.client.getLogs.mockResolvedValue([]);
  h.client.getTransactionReceipt.mockResolvedValue({ status: 'reverted', blockNumber: 100n, logs: [] });
});
afterAll(closeRedisLuaEngine);

describe.each(['jpyc', 'usdc'] as const)('%s finalized authorization expiry (real Lua)', (rail) => {
  it.each([
    ['signed', false], ['settling', false], ['settling', true],
    ['indeterminate', false], ['indeterminate', true],
  ] as const)('terminalizes %s (hash=%s), removes pending and frees only its rail', async (state, withHash) => {
    const f = await setup(rail, state, withHash);
    expect(await f.reconcile()).toMatchObject({ ok: true, state: rail === 'jpyc' ? 'failed_prebroadcast' : 'failed' });
    expect(await f.read()).toMatchObject({ state: 'failed_prebroadcast', failureReason: 'authorization_expired_unused', ...(withHash ? { txHash: TX } : {}) });
    expect(h.store!.zsets.get(f.pendingKey)?.has(SALT) ?? false).toBe(false);
    expect(h.store!.strings.has(f.activeKey)).toBe(false);
    expect(h.store!.strings.has(railParentArchiveKey(f.parentId))).toBe(true);
    // state は finalized の「番号」ではなく「hash」に固定して読む (EIP-1898・第 7 回レビュー持ち越し①)。
    const stateRead = h.client.readContract.mock.calls.at(-1)![0];
    expect(stateRead).toMatchObject({ args: [PAYER, f.nonce], blockHash: BLOCK_HASH, requireCanonical: true });
    expect(stateRead).not.toHaveProperty('blockNumber');
    expect(h.client.getBlock).toHaveBeenNthCalledWith(1, { blockTag: 'finalized' });
    expect(h.client.getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 500n });
    expect(h.client.readContract.mock.invocationCallOrder.at(-1)).toBeLessThan(h.client.getBlock.mock.invocationCallOrder[1]!);
    const next = await associateStoreRailIntent({ intentSalt: REPLACEMENT, intentKey: 'new-intent', payer: PAYER, resourceId: RESOURCE, contentRevision: 1, now: NOW + 1_000_000 });
    expect(next.ok).toBe(true);
    expect(next.ok && next.parentIntentId).not.toBe(f.parentId);
  });

  it('allows a genuinely missing receipt only with finalized unused proof', async () => {
    const f = await setup(rail, 'indeterminate');
    h.client.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: TX }));
    expect(await f.reconcile()).toMatchObject({ ok: true, state: rail === 'jpyc' ? 'failed_prebroadcast' : 'failed' });
  });

  it.each(['signed', 'settling', 'indeterminate'] as const)('%s: server wall clock cannot outrun finalized chain time', async (state) => {
    const f = await setup(rail, state);
    h.client.getBlock.mockResolvedValue({ number: 500n, hash: BLOCK_HASH, timestamp: f.validBefore - 1n });
    expect(await f.reconcile()).toEqual({ ok: true, state: 'pending' });
    expect(await f.read()).toMatchObject({ state: rail === 'jpyc' && state === 'settling' ? 'indeterminate' : state });
    expect(h.store!.strings.has(f.activeKey)).toBe(true);
    expect(h.store!.zsets.get(f.pendingKey)?.has(SALT)).toBe(true);
  });

  it('keeps unresolved expiry pending and locked with the existing rail retry state', async () => {
    const f = await setup(rail, 'settling');
    h.client.getBlock.mockRejectedValue(new Error('finalized unavailable'));
    expect(await f.reconcile()).toEqual({ ok: true, state: 'pending' });
    expect(await f.read()).toMatchObject({ state: rail === 'jpyc' ? 'indeterminate' : 'settling', txHash: TX });
    expect(h.store!.strings.has(f.activeKey)).toBe(true);
  });

  // 'cancelled-state-only' は旧 'cancelled' (finalized の state だけが true で、AuthorizationCanceled の log が無い)。
  // state だけでは取り消しの証拠にならないので従来どおり pending のまま。log のある取り消しは下の 'cancelAuthorization'。
  it.each(['used-by-replacement', 'cancelled-state-only', 'non-boolean', 'state-rpc', 'non-canonical-fork', 'finalized-rpc', 'missing-block-hash', 'missing-block-time', 'successful-candidate', 'receipt-rpc'] as const)('%s evidence keeps the payment pending and locked', async (scenario) => {
    const f = await setup(rail, 'indeterminate');
    if (scenario === 'used-by-replacement' || scenario === 'cancelled-state-only') h.client.readContract.mockImplementation(async (args) => args.blockHash !== undefined);
    if (scenario === 'non-boolean') h.client.readContract.mockResolvedValue(undefined);
    if (scenario === 'state-rpc') h.client.readContract.mockImplementation(async (args) => { if (args.blockHash !== undefined) throw new Error('archive unavailable'); return false; });
    // 前後 (finalized・canonical) は A なのに、中間の state だけ別フォーク B を正規とするノードに当たる: A の hash を
    // 指定した読み取りは requireCanonical で拒否される (番号指定なら B の unused を返して expired と証明してしまう)。
    if (scenario === 'non-canonical-fork') h.client.readContract.mockImplementation(async (args) => { if (args.blockHash === BLOCK_HASH) throw new Error('block not canonical'); return false; });
    if (scenario === 'finalized-rpc') h.client.getBlock.mockRejectedValue(new Error('finalized unsupported'));
    if (scenario === 'missing-block-hash') h.client.getBlock.mockResolvedValue({ number: 500n, timestamp: f.validBefore + 1n });
    if (scenario === 'missing-block-time') h.client.getBlock.mockResolvedValue({ number: 500n, hash: BLOCK_HASH });
    if (scenario === 'successful-candidate') h.client.getTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 100n, logs: [] });
    if (scenario === 'receipt-rpc') h.client.getTransactionReceipt.mockRejectedValue(new Error('timeout'));
    expect(await f.reconcile()).toEqual({ ok: true, state: 'pending' });
    expect(await f.read()).toMatchObject({ state: 'indeterminate', txHash: TX });
    expect(h.store!.strings.has(f.activeKey)).toBe(true);
    expect(h.store!.zsets.get(f.pendingKey)?.has(SALT)).toBe(true);
  });

  // 旧: 取り消し (cancelAuthorization) も「証拠にならず pending のまま・rail は lock」を fail-closed として固定していた。
  // 取り消しは authorizationState を true にするので照合が AuthorizationUsed を永久に探し続け、JPYC rail の lock と
  // pending が残り続けた。2026-10-12 の user 承認で、finalized・canonical な AuthorizationCanceled があり一致する
  // Settled / AuthorizationUsed が無いときは JPYC の購入を終端 (authorization_canceled) にして rail を解放する。
  // USDC rail (ライセンスを扱わない) の照合は今回変えていないので従来どおり pending。
  describe('cancelAuthorization', () => {
    const CANCEL_TX = toHex(901n, { size: 32 });
    const CANCEL_BLOCK_HASH = toHex(400n, { size: 32 });
    function cancelOnChain(f: Awaited<ReturnType<typeof setup>>, cancelBlock = 400n) {
      const topics = encodeEventTopics({ abi: [AUTHORIZATION_CANCELED_EVENT], eventName: 'AuthorizationCanceled', args: { authorizer: PAYER, nonce: f.nonce } }) as Hex[];
      const token = rail === 'jpyc' ? JPYC_V3_ASSET.address : getAddress('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582');
      const log = { address: token, topics, data: '0x' as Hex, blockNumber: cancelBlock, blockHash: CANCEL_BLOCK_HASH, transactionHash: CANCEL_TX, transactionIndex: 0, logIndex: 0, removed: false };
      // 取り消し後は latest・finalized とも authorizationState が true。AuthorizationUsed の log は無い。
      h.client.readContract.mockResolvedValue(true);
      h.client.getLogs.mockImplementation(async (args: { event?: { name?: string } }) => args.event?.name === 'AuthorizationCanceled' ? [log] : []);
      h.client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => hash === CANCEL_TX
        ? { status: 'success', blockNumber: cancelBlock, blockHash: CANCEL_BLOCK_HASH, transactionHash: CANCEL_TX, logs: [log] }
        : { status: 'reverted', blockNumber: 100n, blockHash: toHex(100n, { size: 32 }), transactionHash: hash, logs: [] });
      h.client.getBlock.mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint }) => args.blockTag === 'finalized'
        ? { number: 500n, hash: BLOCK_HASH, timestamp: f.validBefore - 100n }
        : { number: args.blockNumber, hash: args.blockNumber === cancelBlock ? CANCEL_BLOCK_HASH : BLOCK_HASH });
    }

    it.each(['signed', 'indeterminate'] as const)('a finalized cancel of a %s purchase terminalizes JPYC before validBefore and frees its rail', async (state) => {
      const f = await setup(rail, state);
      cancelOnChain(f);
      const result = await f.reconcile(Number(f.validBefore - 200n) * 1000);
      if (rail === 'usdc') {
        expect(result).toEqual({ ok: true, state: 'pending' });
        expect(h.store!.strings.has(f.activeKey)).toBe(true);
        expect(h.store!.zsets.get(f.pendingKey)?.has(SALT)).toBe(true);
        return;
      }
      expect(result).toEqual({ ok: true, state: 'failed_prebroadcast' });
      const stored = await f.read();
      expect(stored).toMatchObject({ state: 'failed_prebroadcast', failureReason: 'authorization_canceled' });
      expect(stored).not.toHaveProperty('txHash');
      expect(h.store!.zsets.get(f.pendingKey)?.has(SALT) ?? false).toBe(false);
      expect(h.store!.strings.has(f.activeKey)).toBe(false);
      expect(h.store!.strings.has(railParentArchiveKey(f.parentId))).toBe(true);
      // 終端の再照合は RPC を呼ばない。
      h.client.readContract.mockClear();
      expect(await f.reconcile()).toEqual({ ok: true, state: 'failed_prebroadcast' });
      expect(h.client.readContract).not.toHaveBeenCalled();
    });

    it.each(['not-finalized', 'used-log', 'stored-tx-succeeded'] as const)('%s keeps the payment pending and locked', async (scenario) => {
      const f = await setup(rail, 'indeterminate');
      cancelOnChain(f, scenario === 'not-finalized' ? 600n : 400n);
      if (scenario === 'not-finalized') h.client.getBlockNumber.mockResolvedValue(700n);
      if (scenario === 'used-log') {
        h.client.getLogs.mockImplementation(async (args: { event?: { name?: string } }) => args.event?.name === 'AuthorizationUsed' ? [{ transactionHash: REPLACEMENT, blockNumber: 300n }] : []);
      }
      if (scenario === 'stored-tx-succeeded') {
        const receipt = h.client.getTransactionReceipt.getMockImplementation()!;
        h.client.getTransactionReceipt.mockImplementation(async (args: { hash: Hex }) => args.hash === TX
          ? { status: 'success', blockNumber: 100n, blockHash: toHex(100n, { size: 32 }), transactionHash: TX, logs: [] }
          : receipt(args));
      }
      expect(await f.reconcile(Number(f.validBefore - 200n) * 1000)).toEqual({ ok: true, state: 'pending' });
      expect(await f.read()).toMatchObject({ state: 'indeterminate', txHash: TX });
      expect(h.store!.strings.has(f.activeKey)).toBe(true);
      expect(h.store!.zsets.get(f.pendingKey)?.has(SALT)).toBe(true);
    });

    it('a concurrent transaction write during the cancel lookup defeats the terminal CAS', async () => {
      const f = await setup(rail, 'indeterminate');
      cancelOnChain(f);
      const logs = h.client.getLogs.getMockImplementation()!;
      h.client.getLogs.mockImplementation(async (args: { event?: { name?: string } }) => {
        if (args.event?.name === 'AuthorizationCanceled') {
          const current = JSON.parse(h.store!.strings.get(f.key)!);
          h.store!.strings.set(f.key, JSON.stringify({ ...current, txHash: REPLACEMENT }));
        }
        return logs(args);
      });
      const result = await f.reconcile(Number(f.validBefore - 200n) * 1000);
      expect(result).not.toMatchObject({ state: 'failed_prebroadcast' });
      expect(await f.read()).toMatchObject({ state: 'indeterminate', txHash: rail === 'jpyc' ? REPLACEMENT : TX });
      expect(h.store!.strings.has(f.activeKey)).toBe(true);
      expect(h.store!.zsets.get(f.pendingKey)?.has(SALT)).toBe(true);
    });
  });

  it('a concurrent transaction write defeats terminal CAS and preserves the lock', async () => {
    const f = await setup(rail, 'indeterminate');
    h.client.readContract.mockImplementation(async (args) => {
      if (args.blockHash !== undefined) {
        const current = JSON.parse(h.store!.strings.get(f.key)!);
        h.store!.strings.set(f.key, JSON.stringify({ ...current, txHash: REPLACEMENT }));
      }
      return false;
    });
    const result = await f.reconcile();
    expect(result).not.toMatchObject({ state: rail === 'jpyc' ? 'failed_prebroadcast' : 'failed' });
    expect(await f.read()).toMatchObject({ state: 'indeterminate', txHash: REPLACEMENT });
    expect(h.store!.strings.has(f.activeKey)).toBe(true);
    expect(h.store!.zsets.get(f.pendingKey)?.has(SALT)).toBe(true);
  });

  it('terminal storage failure cannot release the rail or remove pending', async () => {
    const f = await setup(rail, 'indeterminate');
    h.failTerminalCas = true;
    expect(await f.reconcile()).toEqual({ ok: false, reason: 'storage' });
    expect(await f.read()).toMatchObject({ state: 'indeterminate', txHash: TX });
    expect(h.store!.strings.has(f.activeKey)).toBe(true);
    expect(h.store!.zsets.get(f.pendingKey)?.has(SALT)).toBe(true);
  });
});
