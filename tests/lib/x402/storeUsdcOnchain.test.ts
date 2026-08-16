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

import {
  STORE_USDC_ADDRESS,
  type StoreUsdcPublicClient,
  verifyStoreUsdcOnchain,
} from '@/lib/x402/storeUsdcOnchain';

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
} = {}): StoreUsdcPublicClient {
  return {
    getTransactionReceipt: vi.fn(async () => ({
      status: input.status ?? 'success',
      blockNumber: 100n,
      logs: input.logs ?? [transferLog(), authorizationLog()],
    })),
    getBlock: vi.fn(async () => {
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
});
