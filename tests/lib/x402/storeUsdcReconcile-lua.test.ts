// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, type Hex } from 'viem';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';

type LuaCall = { script: string; keys: string[]; args: string[] };
const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  calls: [] as LuaCall[],
  failGet: false,
  failClaimOnce: false,
  failReschedule: false,
}));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => {
    if (h.failClaimOnce && key.startsWith('payment:claimed:')) {
      h.failClaimOnce = false;
      return { ok: false };
    }
    return h.failGet ? { ok: false } : { ok: true, value: h.store!.strings.get(key) ?? null };
  },
  kvEval: async (script: string, keys: string[], args: string[]) => {
    const call = { script, keys, args };
    h.calls.push(call);
    if (h.failReschedule && script.includes('if current ~= ARGV[4]')) return { ok: false };
    try {
      return { ok: true, value: await runRedisLua(script, keys, args, h.store!) };
    } catch {
      // Match kvEval: script failures must be reported as storage failures to the caller.
      return { ok: false };
    }
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('@/lib/x402/hostedStore', () => ({
  hostedContentKey: (id: string, revision: number) => `x402:hosted:${id}:content:${revision}`,
}));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  PURCHASE_INTENT_VERSION: 1,
  PURCHASE_REVISION_POLICY: 'all-purchased-revisions',
  purchaseOwnershipKey: (payer: string, id: string) => `store:own:${payer.toLowerCase()}:${id}`,
  purchaseLibraryKey: (payer: string) => `store:lib:${payer.toLowerCase()}`,
  hostedPurchaseRecordKey: (chain: number, tx: string) => `store:purchase:${chain}:${tx.toLowerCase()}`,
  parsePurchaseOwnership: (raw: unknown) => {
    if (typeof raw !== 'string') return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    return Array.isArray(value.grants) && value.latestGrant ? value : null;
  },
}));
vi.mock('@/lib/x402/storeRailSelection', () => ({
  associateStoreRailIntent: vi.fn(async () => ({ ok: true, parentIntentId: '9'.repeat(64) })),
  claimStoreRailSelection: vi.fn(async () => ({ ok: true, kind: 'claimed' })),
  releaseActiveStoreRail: vi.fn(async () => true),
}));

import { logger } from '@/lib/logger';
import { paymentClaimKey } from '@/lib/paymentClaim';
import {
  claimSignedStoreUsdcIntent, claimStoreUsdcSettlement, createQuotedStoreUsdcIntent,
  getStoreUsdcIntent, markStoreUsdcIndeterminate, parseStoreUsdcIntent,
  readSettledStoreUsdcAccess, reconcilePendingStoreUsdcPurchases, reconcileStoreUsdcIntent,
  storeUsdcAuthorizationHash, storeUsdcIntentKey, storeUsdcPendingKey,
  STORE_USDC_RECONCILE_MAX_DEFERRED, STORE_USDC_RECONCILE_RETRY_MS,
} from '@/lib/x402/storeUsdcIntent';
import { STORE_USDC_ADDRESS, verifyStoreUsdcOnchain, type StoreUsdcPublicClient } from '@/lib/x402/storeUsdcOnchain';

const NOW = 1_900_000_000_000;
const CHECKED_AT = NOW + 200_000;
const SALT = `0x${'33'.repeat(32)}` as Hex;
const OLD = `0x${'44'.repeat(32)}` as Hex;
const TX = `0x${'55'.repeat(32)}` as Hex;
// 第 3 の候補 (同じ nonce のログに現れるが確定しない tx)。
const MID = `0x${'66'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'88'.repeat(32)}` as Hex;
// 旧フォークのブロック hash (同じ番号の正規ブロックは BLOCK_HASH)。
const FORK_HASH = `0x${'99'.repeat(32)}` as Hex;
const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const ID = `h_${'a'.repeat(32)}`;
const QUARANTINE = 'store:usdc:intent:quarantine';
const EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

async function active(storedHash?: Hex, signedOnly = false) {
  const quoted = await createQuotedStoreUsdcIntent({
    resourceId: ID, contentRevision: 1,
    metadata: { owner: MERCHANT, payTo: MERCHANT, title: 'USDC', priceJpyc: '300', contentKind: 'text', label: 'prompt' },
    payer: PAYER, usdcQuoteAtomic: '2000000', rateScaled: '150000000', rateFetchedAt: NOW,
    rounding: 'ceil', fxQuoteExpiresAt: NOW + 180_000, anchorBlock: 90n, now: NOW, intentSalt: SALT,
  });
  if (!quoted.ok) throw new Error(quoted.reason);
  const claim = {
    payer: PAYER, to: MERCHANT, value: quoted.intent.usdcQuoteAtomic, validAfter: '0',
    validBefore: quoted.intent.authorizationValidBeforeMax, nonce: quoted.intent.nonce,
    signatureFingerprint: '5'.repeat(64),
  };
  const signed = await claimSignedStoreUsdcIntent({
    intentSalt: SALT, claim, authorizationHash: storeUsdcAuthorizationHash(claim), now: NOW + 1_000,
  });
  if (!signed.ok) throw new Error(signed.reason);
  if (!signedOnly) {
    const settling = await claimStoreUsdcSettlement({ intentSalt: SALT, now: NOW + 2_000 });
    if (!settling.ok || settling.kind !== 'claimed') throw new Error('settle claim failed');
    expect(await markStoreUsdcIndeterminate({
      intentSalt: SALT, attemptId: settling.intent.attemptId, txHash: storedHash, now: NOW + 3_000,
    })).toBe('updated');
  }
  return quoted.intent;
}

function rawIntent() {
  return JSON.parse(h.store!.strings.get(storeUsdcIntentKey(SALT))!) as Record<string, unknown>;
}

function patchIntent(patch: Record<string, unknown>) {
  h.store!.strings.set(storeUsdcIntentKey(SALT), JSON.stringify({ ...rawIntent(), ...patch }));
}

function chain(nonce: Hex, input: {
  latest?: bigint; eventBlock?: bigint;
  /** 保存済み OLD の receipt: 既定 = 欠落。'noncanonical' = 成功だが旧フォーク (blockHash が正規と違う)。 */
  old?: 'missing' | 'reverted' | 'noncanonical';
  /** 候補 TX の証拠の欠陥。'canonical' = receipt は成功だが旧フォークのブロック。 */
  bad?: 'amount' | 'nonce' | 'emitter' | 'finality' | 'canonical';
} = {}): StoreUsdcPublicClient {
  const latest = input.latest ?? 114n;
  const eventBlock = input.eventBlock ?? 100n;
  return {
    readContract: vi.fn(async () => true),
    getBlockNumber: vi.fn(async () => latest),
    // 番号指定は「同じ番号の正規ブロック」(B6 の hash 照合) → receipt と同じ hash を返す。tag 指定は safe head。
    getBlock: vi.fn(async (args: { blockTag: 'safe' | 'finalized' } | { blockNumber: bigint }) =>
      'blockNumber' in args
        ? { number: args.blockNumber, hash: BLOCK_HASH }
        : { number: input.bad === 'finality' ? eventBlock - 1n : latest }),
    getTransactionReceipt: vi.fn(async ({ hash }) => {
      if (hash === OLD && (input.old === undefined || input.old === 'missing')) throw new Error('receipt missing');
      const fork = hash === OLD ? input.old === 'noncanonical' : input.bad === 'canonical';
      return {
        status: hash === OLD && input.old === 'reverted' ? 'reverted' as const : 'success' as const,
        blockNumber: eventBlock,
        blockHash: fork ? FORK_HASH : BLOCK_HASH,
        logs: [
          {
            address: input.bad === 'emitter' ? MERCHANT : STORE_USDC_ADDRESS,
            topics: encodeEventTopics({ abi: EVENTS, eventName: 'Transfer', args: { from: PAYER, to: MERCHANT } }) as Hex[],
            data: encodeAbiParameters([{ type: 'uint256' }], [input.bad === 'amount' ? 1n : 2_000_000n]),
          },
          {
            address: STORE_USDC_ADDRESS,
            topics: encodeEventTopics({ abi: EVENTS, eventName: 'AuthorizationUsed', args: { authorizer: PAYER, nonce: input.bad === 'nonce' ? OLD : nonce } }) as Hex[],
            data: '0x' as Hex,
          },
        ],
      };
    }),
    getLogs: vi.fn(async ({ fromBlock, toBlock }) => {
      if (typeof toBlock !== 'bigint' || toBlock - fromBlock + 1n > 2_000n) {
        throw new Error('RPC block range limit');
      }
      return eventBlock >= fromBlock && eventBlock <= toBlock ? [{ transactionHash: TX }] : [];
    }),
  };
}

async function expectSettled() {
  expect(await getStoreUsdcIntent(SALT)).toMatchObject({ state: 'settled', txHash: TX });
  expect(await readSettledStoreUsdcAccess(SALT)).toMatchObject({ ok: true, purchase: { txHash: TX } });
  expect(h.store!.zsets.get(storeUsdcPendingKey())?.has(SALT) ?? false).toBe(false);
}

beforeEach(() => {
  h.store = createFakeRedisStore(NOW);
  h.calls = [];
  h.failGet = false;
  h.failClaimOnce = false;
  h.failReschedule = false;
  vi.clearAllMocks();
});
afterAll(closeRedisLuaEngine);

describe('USDC reconciliation with real Lua and receipt verification', () => {
  // 'noncanonical' (#776 Codex P2): 保存済み OLD の receipt は成功だが旧フォーク (block 100 / hash A・正規は hash B)、
  // 同じ nonce の replacement TX が正規チェーンで支払い済み。条件 7 の不一致を finality 待ちにすると getLogs へ進まず、
  // RPC が古い receipt を返し続ける限り課金済みの購入を解錠できない → 'canonical' は欠落と同じく replacement 探索へ。
  it.each(['missing', 'reverted', 'noncanonical'] as const)('adopts a verified replacement when the stored receipt is %s', async (old) => {
    const intent = await active(OLD);
    const client = chain(intent.nonce, { old });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: OLD });
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      address: STORE_USDC_ADDRESS, args: { authorizer: PAYER, nonce: intent.nonce }, fromBlock: 90n, toBlock: 114n,
    }));
    await expectSettled();
  });

  it('adopts the verified hash even if a delayed worker writes the old hash during receipt verification', async () => {
    const intent = await active();
    const client = chain(intent.nonce);
    const receipt = client.getTransactionReceipt;
    client.getTransactionReceipt = vi.fn(async (args) => {
      patchIntent({ txHash: OLD, nextReconcileAt: CHECKED_AT + 1 });
      client.getTransactionReceipt = receipt;
      return receipt(args);
    });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    await expectSettled();
  });

  it('recovers a consumed authorization still in signed state', async () => {
    const intent = await active(undefined, true);
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client: chain(intent.nonce) })).toEqual({ ok: true, state: 'settled' });
    await expectSettled();
  });

  it('finalizes an already valid stored hash without scanning logs', async () => {
    const intent = await active(TX);
    const client = chain(intent.nonce);
    expect(await verifyStoreUsdcOnchain({ intent: { ...intent, payer: PAYER }, txHash: TX, client })).toMatchObject({ ok: true, state: 'confirmed' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).not.toHaveBeenCalled();
    await expectSettled();
  });

  // Codex 4 回目 P2 (1): 保存済み hash の待ち (finality / 照合不能 / 旧フォーク / receipt なし) が replacement の探索を
  // 止めない — 同じ回で getLogs も走らせ、保存 hash は候補として読み直さず (receipt は 1 回)、確定しなければ保持する。
  it('scans for a replacement while the stored hash awaits finality, checking the stored receipt once and keeping it', async () => {
    const intent = await active(TX);
    const client = chain(intent.nonce, { latest: 100n, bad: 'finality' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).toHaveBeenCalled();
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(rawIntent()).toMatchObject({ state: 'indeterminate', txHash: TX, nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
  });

  it('preserves the existing pending response and logs a reschedule storage failure', async () => {
    const intent = await active();
    const client = chain(intent.nonce);
    vi.mocked(client.readContract).mockRejectedValue(new Error('RPC unavailable'));
    h.failReschedule = true;
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(logger.warn).toHaveBeenCalledWith('creator_store.usdc_purchase_reschedule_failed', { intentSalt: SALT });
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.get(SALT)).toBe(NOW + 3_000);
    expect(h.store!.zsets.has(QUARANTINE)).toBe(false);
  });

  // 'canonical': 候補の receipt が旧フォークのブロック → 採らない (未払いを解錠しない)・terminal にもしない。
  it.each(['amount', 'nonce', 'emitter', 'finality', 'canonical', 'claimed'] as const)('does not adopt a candidate with invalid %s evidence', async (bad) => {
    const intent = await active(OLD);
    if (bad === 'claimed') h.store!.strings.set(paymentClaimKey(8453, TX), 'r:billing');
    const client = chain(intent.nonce, { latest: 100n, ...(bad === 'claimed' ? {} : { bad }) });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).toHaveBeenCalled();
    expect(rawIntent()).toMatchObject({ state: 'indeterminate', txHash: OLD, nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
    expect(h.store!.strings.has(`store:own:${PAYER.toLowerCase()}:${ID}`)).toBe(false);
  });

  it('reschedules expired unused authorizations with a stored hash', async () => {
    const intent = await active(OLD);
    const client = chain(intent.nonce);
    vi.mocked(client.readContract).mockResolvedValue(false);
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(rawIntent()).toMatchObject({ state: 'indeterminate', txHash: OLD, nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.get(SALT)).toBe(CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS);
  });

  it('scans at most 20 inclusive 2000-block pages and resumes beyond the saved cursor', async () => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 50_090n });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).toHaveBeenCalledTimes(20);
    expect(vi.mocked(client.getLogs).mock.calls.map(([args]) => [args.fromBlock, args.toBlock])).toEqual(
      Array.from({ length: 20 }, (_, page) => [90n + BigInt(page) * 2_000n, 2_089n + BigInt(page) * 2_000n]),
    );
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ reconcileFromBlock: '40090' });
    vi.mocked(client.getLogs).mockClear();
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 30_000, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).toHaveBeenCalledTimes(6);
    expect(client.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromBlock: 40_090n, toBlock: 42_089n }));
    expect(client.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 50_090n, toBlock: 50_090n }));
    await expectSettled();
  });

  // 'canonical' (正規ブロックが取れて hash が違う = 旧フォークと確定) は一時障害ではなく無効な候補として飛ばす
  // (下の「advances past ...」)。保留候補に持つのは正規と一致する finality 未到達・receipt 未取得・照合不能・読み取り障害だけ。
  it.each(['receipt', 'finality', 'rpc_unavailable', 'claim'] as const)('keeps the candidate deferred after transient %s failure and re-verifies it while the daily head outruns the scan', async (failure) => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 2_100n });
    if (failure === 'receipt') {
      vi.mocked(client.getTransactionReceipt).mockRejectedValueOnce(new Error('receipt unavailable'));
    } else if (failure === 'finality') {
      vi.mocked(client.getBlock).mockResolvedValueOnce({ number: 2_099n });
      vi.mocked(client.getBlockNumber).mockResolvedValueOnce(50_090n).mockResolvedValueOnce(2_113n);
    } else if (failure === 'rpc_unavailable') {
      vi.mocked(client.getBlock).mockRejectedValueOnce(new Error('safe unsupported'));
      vi.mocked(client.getBlockNumber).mockResolvedValueOnce(50_090n).mockRejectedValueOnce(new Error('latest unavailable'));
    } else {
      h.failClaimOnce = true;
    }
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).toHaveBeenCalledTimes(20);
    expect(client.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 38_090n, toBlock: 40_089n }));
    // 確定しない候補は保留候補 (cursor と別の可変メタ) に持ち、cursor は前進する (巻き戻さない・Codex 5 回目 P2)。
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ state: 'indeterminate', reconcileFromBlock: '40090', reconcileDeferred: [TX], nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
    expect(rawIntent().txHash).toBeUndefined();

    // Daily Base head growth exceeds the per-run 40k scan budget; recovery must not depend on wrapping.
    vi.mocked(client.getLogs).mockClear();
    vi.mocked(client.getBlockNumber).mockResolvedValue(93_290n);
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 86_400_000, client })).toEqual({ ok: true, state: 'settled' });
    // 保留候補は走査の前に再検証されるので、ログを取り直さずに確定する。
    expect(client.getLogs).not.toHaveBeenCalled();
    await expectSettled();
  });

  // Codex 2 回目 P2: RPC のページ読み取りが混在し、先のページに旧 hash (旧フォーク)・後のページに正規チェーンで
  // 支払い済みの replacement が返る。先の候補の pending で打ち切ると replacement が検証されず、課金済みの購入が
  // pending のまま残る → pending の候補は保留して残りを検証し、採用できる候補で確定する。
  function mixedPages(client: StoreUsdcPublicClient) {
    vi.mocked(client.getLogs).mockImplementation(async ({ fromBlock, toBlock }) => {
      if (100n >= fromBlock && 100n <= toBlock) return [{ transactionHash: OLD }];
      if (2_100n >= fromBlock && 2_100n <= toBlock) return [{ transactionHash: TX }];
      return [];
    });
  }

  it('verifies a later-page replacement even when an earlier-page candidate is noncanonical', async () => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 2_100n, old: 'noncanonical' });
    mixedPages(client);
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: OLD });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
    await expectSettled();
  });

  // 先のページの候補 OLD は receipt 未取得 (保留候補に持つ)・後のページの TX は旧フォークと確定 (飛ばす・保留しない)
  // → 採用できる候補が無く、cursor は前進・OLD だけが次回の再検証対象。
  it('advances the cursor and keeps only the unconfirmed candidate deferred when no candidate can be adopted', async () => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 2_100n, bad: 'canonical' });
    mixedPages(client);
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: OLD });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ state: 'indeterminate', reconcileFromBlock: '40090', reconcileDeferred: [OLD], nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
    expect(rawIntent().txHash).toBeUndefined();
    expect(h.store!.strings.has(`store:own:${PAYER.toLowerCase()}:${ID}`)).toBe(false);
  });

  // OLD の receipt は block 100・TX の receipt は block 2,100 (fixture は 1 つの eventBlock しか持たないので上書き)。
  function splitReceiptBlocks(client: StoreUsdcPublicClient) {
    const receipt = vi.mocked(client.getTransactionReceipt).getMockImplementation()!;
    vi.mocked(client.getTransactionReceipt).mockImplementation(async (args) => ({
      ...(await receipt(args)), blockNumber: args.hash === OLD ? 100n : 2_100n,
    }));
  }

  // Codex 3 回目 P2 (1) → 5 回目で保留候補に置き換え: 先の候補 (OLD・receipt 未取得) も後の候補 (TX・読み取り障害) も
  // 保留候補として持ち、cursor は前進する。障害が解けた次回は走査の前に両候補を再検証して replacement で確定する。
  it.each(['rpc', 'claim'] as const)('keeps both the unconfirmed and the read-failed candidate deferred when a later candidate hits a transient %s failure', async (failure) => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 2_100n });
    mixedPages(client);
    splitReceiptBlocks(client);
    let failCanonicalLookup = failure === 'rpc';
    vi.mocked(client.getBlock).mockImplementation(async (args) => {
      if ('blockNumber' in args) {
        if (failCanonicalLookup && args.blockNumber === 2_100n) throw new Error('canonical lookup unavailable');
        return { number: args.blockNumber, hash: BLOCK_HASH };
      }
      return { number: 50_090n };
    });
    // claim: OLD は receipt 未取得で止まるので claim を読まず、最初の claim 読み取り (= TX) だけが落ちる。
    if (failure === 'claim') h.failClaimOnce = true;
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: OLD });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ state: 'indeterminate', reconcileFromBlock: '40090', reconcileDeferred: [OLD, TX], nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
    expect(rawIntent().txHash).toBeUndefined();
    // 障害が解けた次回は、走査の前に保留候補を再検証して replacement で確定する (ログは取り直さない)。
    failCanonicalLookup = false;
    vi.mocked(client.getLogs).mockClear();
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 30_000, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).not.toHaveBeenCalled();
    await expectSettled();
  });

  // Codex 3 回目 P2 (2): 保存済みの旧フォーク receipt (block 101) が高さの条件を満たさない (safe=100 / latest=101) 間、
  // 条件 7 を高さの後に置くと 'finality' で同じ hash を待ち続け、正規チェーンで確定済み (block 100) の replacement の
  // 探索へ進まない → 照合を高さの前に置き、旧フォークは高さに関係なく replacement 探索へ。
  it('scans for the replacement when the stored noncanonical receipt lacks finality while the replacement is final', async () => {
    const intent = await active(OLD);
    const client = chain(intent.nonce, { latest: 101n, eventBlock: 100n, old: 'noncanonical' });
    const receipt = vi.mocked(client.getTransactionReceipt).getMockImplementation()!;
    vi.mocked(client.getTransactionReceipt).mockImplementation(async (args) => ({
      ...(await receipt(args)), blockNumber: args.hash === OLD ? 101n : 100n,
    }));
    vi.mocked(client.getBlock).mockImplementation(async (args) =>
      'blockNumber' in args ? { number: args.blockNumber, hash: BLOCK_HASH } : { number: 100n });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).toHaveBeenCalled();
    await expectSettled();
  });

  it.each(['amount', 'canonical'] as const)('advances past conclusively mismatched candidate evidence (%s)', async (bad) => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 2_100n, bad });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ reconcileFromBlock: '40090' });
    expect(rawIntent().txHash).toBeUndefined();
    expect(rawIntent().reconcileDeferred).toBeUndefined();
  });

  // Codex 4 回目 P2 (1) の反例: 保存済みの旧 receipt が block 101、safe=100 / latest=101 で、block 101 の正規照合だけが
  // 落ちる (照合不能)。これを finality 待ちと混同すると即再スケジュールするだけで、block 100 で確定済みの replacement を
  // 探索しない → 照合不能は 'unverified' として扱い、同じ回で replacement を探索して確定する。
  it('scans for the replacement when the stored stale receipt cannot be verified against the canonical chain', async () => {
    const intent = await active(OLD);
    const client = chain(intent.nonce, { latest: 101n, eventBlock: 100n, old: 'noncanonical' });
    const receipt = vi.mocked(client.getTransactionReceipt).getMockImplementation()!;
    vi.mocked(client.getTransactionReceipt).mockImplementation(async (args) => ({
      ...(await receipt(args)), blockNumber: args.hash === OLD ? 101n : 100n,
    }));
    vi.mocked(client.getBlock).mockImplementation(async (args) => {
      if ('blockNumber' in args) {
        if (args.blockNumber === 101n) throw new Error('block not found');
        return { number: args.blockNumber, hash: BLOCK_HASH };
      }
      return { number: 100n };
    });
    expect(await verifyStoreUsdcOnchain({ intent: { ...intent, payer: PAYER }, txHash: OLD, client })).toEqual({ ok: true, state: 'pending', reason: 'unverified' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).toHaveBeenCalled();
    await expectSettled();
  });

  // Codex 4 回目 P2 (2) の反例: 早いページ (block 100) が旧フォークの候補を返し続け、replacement は 1 回の走査上限
  // (20 ページ × 2,000 = 90..40,089) より先の block 42,100 にある。旧フォーク候補を保留して毎回同じページへ巻き戻すと
  // replacement に届かない → 旧フォークと確定した候補は飛ばし、cursor を前進させて次回に replacement を検証する。
  it('advances past a stale-fork candidate on the first page so a replacement beyond the page budget is reached', async () => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 42_100n, old: 'noncanonical' });
    vi.mocked(client.getLogs).mockImplementation(async ({ fromBlock, toBlock }) => {
      if (100n >= fromBlock && 100n <= toBlock) return [{ transactionHash: OLD }];
      if (42_100n >= fromBlock && 42_100n <= toBlock) return [{ transactionHash: TX }];
      return [];
    });
    const receipt = vi.mocked(client.getTransactionReceipt).getMockImplementation()!;
    vi.mocked(client.getTransactionReceipt).mockImplementation(async (args) => ({
      ...(await receipt(args)), blockNumber: args.hash === OLD ? 100n : 42_100n,
    }));
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: OLD });
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ state: 'indeterminate', reconcileFromBlock: '40090' });
    expect(rawIntent().txHash).toBeUndefined();
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 30_000, client })).toEqual({ ok: true, state: 'settled' });
    await expectSettled();
  });

  // 候補の receipt が読めない間だけ失敗する (省略時は常に読める) 受け取り口。
  function receiptGate(client: StoreUsdcPublicClient, missing: () => boolean) {
    const receipt = vi.mocked(client.getTransactionReceipt).getMockImplementation()!;
    vi.mocked(client.getTransactionReceipt).mockImplementation(async (args) => {
      if (missing()) throw new Error('receipt missing');
      return receipt(args);
    });
  }

  // Codex 5 回目 P2 (1) の再現: 保存 hash なし・anchor 90・正しい支払いが block 100・receipt は最初の 4 回だけ取得不能・
  // head は 50,090 から 1 日 43,200 ずつ伸び (走査は 1 回 40,000)・照合は 1 日 1 回。巻き戻しに上限を置いて前進させると、
  // receipt が戻っても cursor は head に追いつかず anchor へも戻らない → 保留候補は cursor と独立に毎回再検証する。
  it('re-verifies a deferred candidate every run after the cursor advanced, even when the head outruns the daily scan', async () => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 100n });
    let head = 50_090n;
    vi.mocked(client.getBlockNumber).mockImplementation(async () => head);
    let day = 1;
    receiptGate(client, () => day <= 4);
    for (; day <= 4; day += 1) {
      expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + day * 86_400_000, client })).toEqual({ ok: true, state: 'pending' });
      expect(rawIntent().txHash).toBeUndefined();
      head += 43_200n;
    }
    const afterOutage = rawIntent();
    // receipt が戻った: 当該 tx を直接検証すると confirmed。
    expect(await verifyStoreUsdcOnchain({ intent: { ...intent, payer: PAYER }, txHash: TX, client })).toMatchObject({ ok: true, state: 'confirmed' });
    vi.mocked(client.getLogs).mockClear();
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + day * 86_400_000, client })).toEqual({ ok: true, state: 'settled' });
    await expectSettled();
    // cursor は毎回 40,000 ずつ前進し (巻き戻さない)、TX は保留候補として持ち越され、走査の前に再検証されて確定した。
    expect(afterOutage).toMatchObject({ reconcileFromBlock: '160090', reconcileDeferred: [TX] });
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  // Codex 5 回目 P2 (2) の再現の fixture: block 100 の候補 OLD は receipt 取得不能・block 2,100 の別候補 MID は正規照合の
  // RPC 障害 (高さは足りている = 読み取り障害)・正しい replacement TX は 1 回の走査上限 (90..40,089) より先の block 42,100。
  function replacementBeyondFailures(nonce: Hex) {
    const client = chain(nonce, { latest: 50_090n, eventBlock: 42_100n });
    vi.mocked(client.getLogs).mockImplementation(async ({ fromBlock, toBlock }) => {
      if (100n >= fromBlock && 100n <= toBlock) return [{ transactionHash: OLD }];
      if (2_100n >= fromBlock && 2_100n <= toBlock) return [{ transactionHash: MID }];
      if (42_100n >= fromBlock && 42_100n <= toBlock) return [{ transactionHash: TX }];
      return [];
    });
    const receipt = vi.mocked(client.getTransactionReceipt).getMockImplementation()!;
    vi.mocked(client.getTransactionReceipt).mockImplementation(async (args) => {
      if (args.hash === OLD) throw new Error('receipt missing');
      return { ...(await receipt(args)), blockNumber: args.hash === MID ? 2_100n : 42_100n };
    });
    vi.mocked(client.getBlock).mockImplementation(async (args) => {
      if ('blockNumber' in args) {
        if (args.blockNumber === 2_100n) throw new Error('canonical lookup unavailable');
        return { number: args.blockNumber, hash: BLOCK_HASH };
      }
      return { number: 50_090n };
    });
    return client;
  }

  // 照合を最大 runs 回くり返し、各回の結果と各回の後の intent を返す (settled で止める)。
  async function reconcileRuns(client: StoreUsdcPublicClient, runs: number, options: { deadline?: () => number } = {}) {
    const results: string[] = [];
    const snapshots: Record<string, unknown>[] = [];
    for (let run = 0; run < runs; run += 1) {
      const result = await reconcileStoreUsdcIntent(SALT, {
        now: CHECKED_AT + run * 30_000, client, ...(options.deadline ? { deadline: options.deadline() } : {}),
      });
      results.push(result.ok ? result.state : result.reason);
      snapshots.push(rawIntent());
      if (result.ok && result.state === 'settled') break;
    }
    return { results, snapshots };
  }

  // Codex 5 回目 P2 (2) の再現: 後の候補 (MID) の読み取り障害で候補ループを中断して先に保留したページ (90) へ戻ると、
  // 巻き戻し上限の回数計算を通らず cursor が 90 のまま (8 回続けても replacement を一度も検証しない) → 読み取り障害の
  // 候補も保留候補に持ち、残りの候補を検証してから共通の処理 (cursor の前進) へ進む。
  it('keeps read-failed candidates deferred and still reaches a replacement beyond the page budget', async () => {
    const intent = await active();
    const client = replacementBeyondFailures(intent.nonce);
    const { results, snapshots } = await reconcileRuns(client, 8);
    expect(results).toEqual(['pending', 'settled']);
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
    await expectSettled();
    expect(snapshots[0]).toMatchObject({ state: 'indeterminate', reconcileFromBlock: '40090', reconcileDeferred: [OLD, MID] });
    expect(snapshots[0].txHash).toBeUndefined();
  });

  // 予算付き走査 (#788: 候補が出たページで止めて照合) と組み合わせても収束する: 1 回目は OLD のページ・2 回目は MID の
  // ページで止まり、それぞれ保留候補に持って cursor を次のページへ進める。3 回目は保留候補を再検証した後の 20 ページ目で
  // replacement に届いて確定する (保留ページへ戻す設計では 2,090 に留まり続けた)。
  it('converges with the budgeted scan that stops at each candidate page', async () => {
    const intent = await active();
    const client = replacementBeyondFailures(intent.nonce);
    const { results, snapshots } = await reconcileRuns(client, 10, { deadline: () => Date.now() + 60_000 });
    expect(results).toEqual(['pending', 'pending', 'settled']);
    await expectSettled();
    expect(snapshots[0]).toMatchObject({ reconcileFromBlock: '2090', reconcileDeferred: [OLD] });
    expect(snapshots[1]).toMatchObject({ reconcileFromBlock: '4090', reconcileDeferred: [OLD, MID] });
    expect(vi.mocked(client.getLogs).mock.calls.map(([args]) => args.fromBlock)).toEqual([
      90n, 2_090n, ...Array.from({ length: 20 }, (_, page) => 4_090n + BigInt(page) * 2_000n),
    ]);
  });

  // 保留候補が旧フォークと確定 (正規ブロックの hash が違う) したら列から外す (再検証を続けない・採らない)。
  it('drops a deferred candidate once it is conclusively on a stale fork', async () => {
    const intent = await active();
    patchIntent({ reconcileDeferred: [OLD] });
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 42_100n, old: 'noncanonical' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: OLD });
    expect(rawIntent()).toMatchObject({ state: 'indeterminate', reconcileFromBlock: '40090' });
    expect(rawIntent().reconcileDeferred).toBeUndefined();
    expect(rawIntent().txHash).toBeUndefined();
  });

  // 保留候補の列が上限まで埋まっていると新しい確定前の候補は列に入れられない → 見失わないよう cursor をその候補のページに
  // 留める (前進しない)。receipt が読めるようになった回に同じページから再発見して確定する。溢れは整合したチェーンでは
  // 起き得ない異常なので (その間はそのページから先へ進めない既知の制限)、溢れた回は warn を 1 回出して人が気づけるようにする。
  it('keeps the cursor at the page of a candidate that overflows the deferred list and warns once per run', async () => {
    const intent = await active();
    const stuck = Array.from({ length: STORE_USDC_RECONCILE_MAX_DEFERRED }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex);
    patchIntent({ reconcileDeferred: stuck });
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 2_100n });
    let txMissing = true;
    const receipt = vi.mocked(client.getTransactionReceipt).getMockImplementation()!;
    vi.mocked(client.getTransactionReceipt).mockImplementation(async (args) => {
      if (stuck.includes(args.hash) || (args.hash === TX && txMissing)) throw new Error('receipt missing');
      return receipt(args);
    });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(rawIntent()).toMatchObject({ state: 'indeterminate', reconcileFromBlock: '2090', reconcileDeferred: stuck });
    const overflowWarnings = () => vi.mocked(logger.warn).mock.calls.filter(([event]) => event === 'creator_store.usdc_purchase_deferred_overflow');
    expect(overflowWarnings()).toEqual([[
      'creator_store.usdc_purchase_deferred_overflow',
      { intentSalt: SALT, deferred: STORE_USDC_RECONCILE_MAX_DEFERRED, pageStart: '2090' },
    ]]);
    txMissing = false;
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 30_000, client })).toEqual({ ok: true, state: 'settled' });
    await expectSettled();
    expect(overflowWarnings()).toHaveLength(1);
  });

  // Codex 6 回目 P2 (2) の再現: 保留列 [OLD, MID, TX]・予算 25 秒・authorizationState 1 秒・先頭 2 件の receipt は各 10 秒で
  // timeout。毎回先頭から再検証すると 21 秒後に残りが 1 回の RPC に足りず TX の前で中断し、順序が変わらないので次回も
  // 同じ 2 件から (8 回で TX の照合 0 回・ログ走査 0 回)。→ round robin (未確定は末尾へ) と、保留候補の照合を始められるのは
  // その回の予算の半分までにする上限で、TX に順番が回り、走査の予算も残る。
  it('rotates slow deferred candidates and caps their budget so a later deferred candidate and the scan still run', async () => {
    const intent = await active();
    patchIntent({ reconcileDeferred: [OLD, MID, TX] });
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 100n });
    let clock = NOW;
    vi.mocked(client.readContract).mockImplementation(async () => { clock += 1_000; return true; });
    const receipt = vi.mocked(client.getTransactionReceipt).getMockImplementation()!;
    vi.mocked(client.getTransactionReceipt).mockImplementation(async (args) => {
      if (args.hash === OLD || args.hash === MID) {
        clock += 10_000;
        throw new Error('receipt timeout');
      }
      return receipt(args);
    });
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const results: string[] = [];
    const logPages: number[] = [];
    try {
      for (let run = 0; run < 8; run += 1) {
        vi.mocked(client.getLogs).mockClear();
        const result = await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + run * 30_000, client, deadline: clock + 25_000 });
        results.push(result.ok ? result.state : result.reason);
        logPages.push(vi.mocked(client.getLogs).mock.calls.length);
        if (result.ok && result.state === 'settled') break;
      }
    } finally {
      spy.mockRestore();
    }
    expect(results).toEqual(['pending', 'pending', 'settled']);
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
    // 保留候補の照合が予算の半分で打ち切られるので、走査も毎回走る (1 回目は TX のページで止まり、TX は保留候補なので
    // 走査では読み直さない・2 回目はその次のページから 20 ページ)。
    expect(logPages.slice(0, 2)).toEqual([1, 20]);
    await expectSettled();
  });

  it.each([
    ['not a list', TX],
    ['empty', []],
    ['not a tx hash', ['nope']],
    ['upper-case hash', [`0x${'AB'.repeat(32)}`]],
    ['duplicate', [TX, TX]],
    ['too many', Array.from({ length: STORE_USDC_RECONCILE_MAX_DEFERRED + 1 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`)],
  ])('rejects a malformed deferred list (%s) as corrupt without touching the immutable binding', async (_label, list) => {
    await active();
    patchIntent({ reconcileDeferred: list });
    expect(await getStoreUsdcIntent(SALT)).toBe('corrupt');
    patchIntent({ reconcileDeferred: [TX] });
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ state: 'indeterminate', reconcileDeferred: [TX] });
  });

  it.each([2_089n, 2_090n])('finds evidence at paging boundary %s', async (eventBlock) => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 2_090n, eventBlock });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromBlock: 90n, toBlock: 2_089n }));
    expect(client.getLogs).toHaveBeenNthCalledWith(2, expect.objectContaining({ fromBlock: 2_090n, toBlock: 2_090n }));
    await expectSettled();
  });

  it('clamps the cursor to the anchor and wraps a completed scan to retry nonfinal evidence', async () => {
    const intent = await active();
    patchIntent({ reconcileFromBlock: '1' });
    const client = chain(intent.nonce, { latest: 100n, bad: 'finality' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 90n, toBlock: 100n }));
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ reconcileFromBlock: '90' });
    vi.mocked(client.getBlock).mockImplementation(async (args) =>
      'blockNumber' in args ? { number: args.blockNumber, hash: BLOCK_HASH } : { number: 100n });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 30_000, client })).toEqual({ ok: true, state: 'settled' });
  });

  // B4 follow-up 2: 後のページが失敗しても、取得済みページの候補はその場で照合する (以前は候補を捨てて同じ cursor で待ち、
  // 次回に同じページを取り直して初めて settle していた)。候補が無いページの失敗は cursor をそのページの先頭に保存する。
  it('verifies the candidates of fetched pages even when a later page fails, and saves the failed page start otherwise', async () => {
    const intent = await active();
    patchIntent({ reconcileFromBlock: '2090' });
    const client = chain(intent.nonce, { latest: 5_000n, eventBlock: 2_090n });
    vi.mocked(client.getLogs)
      .mockResolvedValueOnce([{ transactionHash: TX }])
      .mockRejectedValueOnce(new Error('RPC unavailable'));
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    // 予算なしの走査は従来どおり全ページを集める (失敗する 2 ページ目も取りに行く)。候補が出たら止めるのは予算付きだけ。
    expect(client.getLogs).toHaveBeenCalledTimes(2);
  });

  it('a failed page without candidates saves the failed page start as the cursor (progress, not a stall)', async () => {
    const intent = await active();
    patchIntent({ reconcileFromBlock: '2090' });
    const client = chain(intent.nonce, { latest: 5_000n, eventBlock: 2_090n });
    vi.mocked(client.getLogs)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('RPC unavailable'));
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ reconcileFromBlock: '4090', nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
  });

  it.each(['-1', '01', 90, null])('rejects malformed cursor %s without changing the immutable binding', async (cursor) => {
    await active();
    expect(parseStoreUsdcIntent(JSON.stringify({ ...rawIntent(), reconcileFromBlock: cursor }))).toBeNull();
  });

  it.each(['attempt', 'authorization', 'settled', 'missing', 'corrupt', 'pending-type'] as const)('adoption CAS rejects %s changes without overwriting current data', async (mutation) => {
    const intent = await active(OLD);
    const original = h.store!.strings.get(storeUsdcIntentKey(SALT))!;
    await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client: chain(intent.nonce) });
    const adoption = h.calls.find(({ script }) => script.includes('current.authorizationHash ~= ARGV[7]'));
    expect(adoption).toBeDefined();
    h.store!.strings.set(storeUsdcIntentKey(SALT), original);
    if (mutation === 'attempt') patchIntent({ attemptId: 'f'.repeat(64) });
    if (mutation === 'authorization') patchIntent({ authorizationHash: 'f'.repeat(64) });
    if (mutation === 'settled') patchIntent({ state: 'settled', txHash: OLD });
    if (mutation === 'missing') h.store!.strings.delete(storeUsdcIntentKey(SALT));
    if (mutation === 'corrupt') h.store!.strings.set(storeUsdcIntentKey(SALT), '{broken');
    if (mutation === 'pending-type') {
      h.store!.zsets.delete(storeUsdcPendingKey());
      h.store!.strings.set(storeUsdcPendingKey(), 'wrong type');
    }
    const before = h.store!.strings.get(storeUsdcIntentKey(SALT));
    const pendingBefore = [...h.store!.zsets.get(storeUsdcPendingKey()) ?? []];
    const call = adoption!;
    const expected = mutation === 'missing' ? 0 : ['corrupt', 'pending-type'].includes(mutation) ? -3 : -1;
    expect(await runRedisLua(call.script, call.keys, call.args, h.store!)).toBe(expected);
    expect(h.store!.strings.get(storeUsdcIntentKey(SALT))).toBe(before);
    expect([...h.store!.zsets.get(storeUsdcPendingKey()) ?? []]).toEqual(pendingBefore);
  });
});

describe('USDC pending quarantine with real Lua', () => {
  it.each(['invalid_salt', 'not_found', 'corrupt'] as const)('quarantines %s so a limit-one batch reaches the next healthy member', async (reason) => {
    const intent = await active(TX);
    const member = reason === 'invalid_salt' ? 'bad-member' : `0x${'01'.repeat(32)}`;
    if (reason === 'corrupt') h.store!.strings.set(storeUsdcIntentKey(member), '{broken');
    h.store!.zsets.get(storeUsdcPendingKey())!.set(member, NOW - 1);
    const input = { now: CHECKED_AT, limit: 1, client: chain(intent.nonce) };
    expect(await reconcilePendingStoreUsdcPurchases(input)).toEqual({ checked: 1, settled: 0, failed: 0, pending: 0, storageErrors: 0, deferred: 0 });
    expect(h.store!.zsets.get(QUARANTINE)?.get(member)).toBe(CHECKED_AT);
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.has(member)).toBe(false);
    if (reason === 'corrupt') expect(h.store!.strings.get(storeUsdcIntentKey(member))).toBe('{broken');
    expect(logger.warn).toHaveBeenCalledWith('creator_store.usdc_purchase_pending_quarantined', { member, reason });
    expect(await reconcilePendingStoreUsdcPurchases(input)).toEqual({ checked: 1, settled: 1, failed: 0, pending: 0, storageErrors: 0, deferred: 0 });
    await expectSettled();
  });

  it('preserves pending evidence and reports storage failure if quarantine has the wrong type', async () => {
    h.store!.strings.set(QUARANTINE, 'wrong type');
    h.store!.zsets.set(storeUsdcPendingKey(), new Map([['bad-member', NOW]]));
    expect(await reconcilePendingStoreUsdcPurchases({ now: CHECKED_AT })).toMatchObject({ storageErrors: 1 });
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.get('bad-member')).toBe(NOW);
    expect(h.store!.strings.get(QUARANTINE)).toBe('wrong type');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps a valid member pending on storage read failure', async () => {
    await active();
    h.failGet = true;
    expect(await reconcilePendingStoreUsdcPurchases({ now: CHECKED_AT })).toMatchObject({ storageErrors: 1 });
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.has(SALT)).toBe(true);
    expect(h.store!.zsets.has(QUARANTINE)).toBe(false);
  });
});
