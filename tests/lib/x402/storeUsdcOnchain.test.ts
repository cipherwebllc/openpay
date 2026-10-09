import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';

const claimState = vi.hoisted(() => ({
  value: null as string | null,
  legacy: null as string | null,
  fail: false,
}));

vi.mock('server-only', () => ({}));
const chainsMock = vi.hoisted(() => ({ transportForChain: vi.fn() }));
vi.mock('@/lib/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains')>();
  chainsMock.transportForChain.mockImplementation(actual.transportForChain);
  return { ...actual, transportForChain: chainsMock.transportForChain };
});
vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async (key: string) =>
    claimState.fail
      ? { ok: false as const }
      : {
          ok: true as const,
          value: key.startsWith('billing:settled:')
            ? claimState.legacy
            : claimState.value,
        },
  ),
}));

import { kvGet } from '@/lib/kv';
import {
  findStoreUsdcAuthorizationTransactions,
  STORE_USDC_ADDRESS,
  storeUsdcBoundedClient,
  type StoreUsdcPublicClient,
  verifyStoreUsdcOnchain,
} from '@/lib/x402/storeUsdcOnchain';

// B4 follow-up 2 (2): deadline 付き reconcile の全 RPC が使う、retry なし・timeout を絞った Base client。
describe('Store USDC bounded client', () => {
  it('builds a retry-free Base client bounded by the given timeout', () => {
    chainsMock.transportForChain.mockClear();
    const client = storeUsdcBoundedClient({ timeoutMs: 4_321, deadlineAt: 1_900_000_000_000 });
    expect(typeof client.getLogs).toBe('function');
    expect(chainsMock.transportForChain).toHaveBeenCalledWith(8453, { timeout: 4_321, retryCount: 0, deadline: 1_900_000_000_000 });
  });
});

// 第 7 回レビュー B4 (follow-up): deadline 付きの page 取得だけ、retry なし・残り時間で切った timeout の client を使う。
describe('Store USDC page fetch transport bound', () => {
  it('builds a retry-free transport bounded by timeoutMs only when one is given; a custom client is used as-is', async () => {
    const getLogs = vi.fn(async () => []);
    const client = { getLogs } as unknown as StoreUsdcPublicClient;
    chainsMock.transportForChain.mockClear();
    const budget = { timeoutMs: 1_234, deadlineAt: 1_900_000_000_000 };
    await findStoreUsdcAuthorizationTransactions({ payer: PAYER, nonce: NONCE, fromBlock: 1n, toBlock: 2n, client, budget });
    expect(getLogs).toHaveBeenCalledTimes(1); expect(chainsMock.transportForChain).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    try {
      expect(await findStoreUsdcAuthorizationTransactions({ payer: PAYER, nonce: NONCE, fromBlock: 1n, toBlock: 2n, budget })).toBe('unavailable');
      expect(chainsMock.transportForChain).toHaveBeenLastCalledWith(8453, { timeout: 1_234, retryCount: 0, deadline: 1_900_000_000_000 });
      expect(await findStoreUsdcAuthorizationTransactions({ payer: PAYER, nonce: NONCE, fromBlock: 1n, toBlock: 2n })).toBe('unavailable');
      expect(chainsMock.transportForChain).toHaveBeenLastCalledWith(8453);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);
const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const OTHER = getAddress('0x3333333333333333333333333333333333333333');
const NONCE = `0x${'44'.repeat(32)}` as Hex;
const OTHER_NONCE = `0x${'55'.repeat(32)}` as Hex;
const TX = `0x${'66'.repeat(32)}` as Hex;
const SALT = `0x${'77'.repeat(32)}` as Hex;
// receipt が属するブロックの hash と、同じ番号の「別フォーク」の hash (B6)。
const BLOCK_HASH = `0x${'88'.repeat(32)}` as Hex;
const FORK_HASH = `0x${'99'.repeat(32)}` as Hex;

function transferLog(input: {
  emitter?: Address;
  from?: Address;
  to?: Address;
  value?: bigint;
} = {}) {
  return {
    address: input.emitter ?? STORE_USDC_ADDRESS,
    topics: encodeEventTopics({
      abi: EVENTS,
      eventName: 'Transfer',
      args: {
        from: input.from ?? PAYER,
        to: input.to ?? MERCHANT,
      },
    }) as readonly Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }],
      [input.value ?? 2_000_000n],
    ),
  };
}

function authorizationLog(input: {
  emitter?: Address;
  authorizer?: Address;
  nonce?: Hex;
} = {}) {
  return {
    address: input.emitter ?? STORE_USDC_ADDRESS,
    topics: encodeEventTopics({
      abi: EVENTS,
      eventName: 'AuthorizationUsed',
      args: {
        authorizer: input.authorizer ?? PAYER,
        nonce: input.nonce ?? NONCE,
      },
    }) as readonly Hex[],
    data: '0x' as Hex,
  };
}

function client(input: {
  status?: 'success' | 'reverted';
  logs?: ReturnType<typeof transferLog>[];
  safe?: bigint | null | 'error';
  latest?: bigint;
  /** 同じ番号の正規ブロックの hash (既定 = receipt と同じ)。'error' は照会障害。 */
  canonicalHash?: Hex | 'error';
} = {}): StoreUsdcPublicClient {
  return {
    getTransactionReceipt: vi.fn(async () => ({
      status: input.status ?? 'success',
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      logs: input.logs ?? [transferLog(), authorizationLog()],
    })),
    getBlock: vi.fn(async (args: { blockTag: 'safe' | 'finalized' } | { blockNumber: bigint }) => {
      if ('blockNumber' in args) {
        if (input.canonicalHash === 'error') throw new Error('canonical lookup unavailable');
        return { number: args.blockNumber, hash: input.canonicalHash ?? BLOCK_HASH };
      }
      if (input.safe === 'error') throw new Error('safe unsupported');
      return { number: input.safe === undefined ? 100n : input.safe };
    }),
    getBlockNumber: vi.fn(async () => input.latest ?? 114n),
    readContract: vi.fn(async () => true),
    getLogs: vi.fn(async () => []),
  };
}

function intent(over: Record<string, unknown> = {}) {
  return {
    intentSalt: SALT,
    chainId: 8453,
    payer: PAYER,
    merchant: MERCHANT,
    nonce: NONCE,
    usdcQuoteAtomic: '2000000',
    anchorBlock: '90',
    ...over,
  } as Parameters<typeof verifyStoreUsdcOnchain>[0]['intent'];
}

beforeEach(() => {
  claimState.value = null;
  claimState.legacy = null;
  claimState.fail = false;
  vi.mocked(kvGet).mockClear();
});

describe('Store USDC on-chain entitlement gate', () => {
  it('条件1: Base(8453) 以外は receipt を読む前に拒否', async () => {
    const rpc = client();
    await expect(
      verifyStoreUsdcOnchain({ intent: intent({ chainId: 84532 }), txHash: TX, client: rpc }),
    ).resolves.toEqual({ ok: false, reason: 'chain_mismatch' });
    expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('条件2: reverted receipt は拒否', async () => {
    await expect(
      verifyStoreUsdcOnchain({ intent: intent(), txHash: TX, client: client({ status: 'reverted' }) }),
    ).resolves.toEqual({ ok: false, reason: 'receipt_reverted' });
  });

  it.each([
    ['別 token emitter', transferLog({ emitter: OTHER })],
    ['別 payer', transferLog({ from: OTHER })],
    ['第三者 recipient', transferLog({ to: OTHER })],
    ['額違い', transferLog({ value: 1_999_999n })],
  ])('条件3: native USDC Transfer の %s を拒否', async (_label, badTransfer) => {
    await expect(
      verifyStoreUsdcOnchain({
        intent: intent(),
        txHash: TX,
        client: client({ logs: [badTransfer, authorizationLog()] }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'transfer_missing' });
  });

  it.each([
    ['別 emitter', authorizationLog({ emitter: OTHER })],
    ['別 authorizer', authorizationLog({ authorizer: OTHER })],
    ['別 nonce', authorizationLog({ nonce: OTHER_NONCE })],
  ])('条件4: AuthorizationUsed の %s を拒否', async (_label, badAuthorization) => {
    await expect(
      verifyStoreUsdcOnchain({
        intent: intent(),
        txHash: TX,
        client: client({ logs: [transferLog(), badAuthorization] }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'authorization_missing' });
  });

  it('条件5: chain+txHash の他用途 global claim を拒否し、同 intent replay だけ許す', async () => {
    claimState.value = 'r:billing';
    await expect(
      verifyStoreUsdcOnchain({ intent: intent(), txHash: TX, client: client() }),
    ).resolves.toEqual({ ok: false, reason: 'transaction_consumed' });

    claimState.value = `r:store:${SALT}`;
    await expect(
      verifyStoreUsdcOnchain({ intent: intent(), txHash: TX, client: client() }),
    ).resolves.toMatchObject({ ok: true, state: 'confirmed' });

    claimState.value = null;
    claimState.legacy = 'legacy-billing-result';
    await expect(
      verifyStoreUsdcOnchain({ intent: intent(), txHash: TX, client: client() }),
    ).resolves.toEqual({ ok: false, reason: 'transaction_consumed' });
  });

  it('条件6: safe 未到達かつ14 confirmations は pending、safe または15 confirmations で confirmed', async () => {
    const fourteen = await verifyStoreUsdcOnchain({
      intent: intent(),
      txHash: TX,
      client: client({ safe: null, latest: 113n }),
    });
    expect(fourteen).toEqual({ ok: true, state: 'pending', reason: 'finality' });

    await expect(
      verifyStoreUsdcOnchain({
        intent: intent(),
        txHash: TX,
        client: client({ safe: 100n, latest: 100n }),
      }),
    ).resolves.toMatchObject({ ok: true, state: 'confirmed' });

    await expect(
      verifyStoreUsdcOnchain({
        intent: intent(),
        txHash: TX,
        client: client({ safe: 'error', latest: 114n }),
      }),
    ).resolves.toMatchObject({ ok: true, state: 'confirmed' });
  });

  // 第 7 回レビュー B6: finality は「高さ」だけで判定していた。RPC が旧フォークの成功 receipt (同じ番号・別 hash)
  // を返しても、safe 到達や 15 confirmations は高さの条件を満たすので confirmed になりうる。receipt の blockHash が
  // 今の正規チェーンの同じ番号のブロックと一致することを、confirmed の前の追加条件にする (license reconcile と同じ)。
  describe('条件7: receipt のブロックが今の正規チェーンに属する (blockHash の照合)', () => {
    it('safe 到達でも receipt の blockHash が同じ番号の正規ブロックと違えば pending (finality)・terminal にせず claim も読まない', async () => {
      const rpc = client({ safe: 100n, latest: 100n, canonicalHash: FORK_HASH });
      await expect(
        verifyStoreUsdcOnchain({ intent: intent(), txHash: TX, client: rpc }),
      ).resolves.toEqual({ ok: true, state: 'pending', reason: 'finality' });
      expect(rpc.getBlock).toHaveBeenCalledWith({ blockNumber: 100n });
      expect(kvGet).not.toHaveBeenCalled();
    });

    it('15 confirmations でも同じ (高さの条件は hash の照合を代替しない)', async () => {
      await expect(
        verifyStoreUsdcOnchain({
          intent: intent(),
          txHash: TX,
          client: client({ safe: null, latest: 114n, canonicalHash: FORK_HASH }),
        }),
      ).resolves.toEqual({ ok: true, state: 'pending', reason: 'finality' });
    });

    it('正規ブロックの照会が落ちたら rpc_unavailable (confirmed にも pending にもしない)', async () => {
      await expect(
        verifyStoreUsdcOnchain({
          intent: intent(),
          txHash: TX,
          client: client({ safe: 100n, canonicalHash: 'error' }),
        }),
      ).resolves.toEqual({ ok: false, reason: 'rpc_unavailable' });
      expect(kvGet).not.toHaveBeenCalled();
    });

    it('confirmed は finality の後に receipt の番号を hash で照合してから (照会順を固定)', async () => {
      const rpc = client({ safe: 100n });
      await expect(
        verifyStoreUsdcOnchain({ intent: intent(), txHash: TX, client: rpc }),
      ).resolves.toEqual({ ok: true, state: 'confirmed', blockNumber: 100n });
      expect(vi.mocked(rpc.getBlock).mock.calls.map(([args]) => args)).toEqual([
        { blockTag: 'safe' },
        { blockNumber: 100n },
      ]);
    });
  });
});
