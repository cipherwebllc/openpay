// CSV パス relay の実配線テスト。route → relayFreeAuthorization → relayJpycAuthorization →
// relayGuards → self-host submit/poll を実走させ、KV key の名前空間を endpoint 入口から固定する。
// 外すのは KV と on-chain I/O のみで、relayProvider / relayGuards / jpycRelay はモックしない。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const AMOY = 80002;
const CUSTOMER_PK = (`0x${'2'.repeat(64)}`) as Hex;
const RELAYER_PK = `0x${'1'.repeat(64)}`;
const NONCE = (`0x${'ab'.repeat(32)}`) as Hex;
const FEE_RECEIVER = getAddress('0xdead000000000000000000000000000000001234');
const JPYC_AMOY = getAddress('0x0000000000000000000000000000000000000abc');

const io = vi.hoisted(() => ({
  readFunctions: [] as string[],
  sentRaw: [] as Hex[],
}));
const envConfig = vi.hoisted(() => ({
  feeReceiver: '0xdead000000000000000000000000000000001234',
}));

vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  delete process.env.GELATO_SPONSOR_API_KEY;
});

// provider が組み立てる viem clients の I/O だけを固定する。署名 recover / calldata / hash は実物。
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: async (args: { functionName: string }) => {
        io.readFunctions.push(args.functionName);
        if (args.functionName === 'balanceOf') return 10_000n * 10n ** 18n;
        if (args.functionName === 'authorizationState') return false;
        return 0n;
      },
      getBalance: async () => 10n ** 18n,
      estimateGas: async () => 100_000n,
      getTransactionCount: async () => 0,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        io.sentRaw.push(serializedTransaction);
        return (`0x${'f'.repeat(64)}`) as Hex;
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({
        status: 'success' as const,
        transactionHash: hash,
      }),
    }),
    createWalletClient: () => ({
      prepareTransactionRequest: async () => ({ maxFeePerGas: 1n }),
      signTransaction: async () => '0x1234' as Hex,
    }),
  };
});

const kv = vi.hoisted(() => {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const counters = new Map<string, number>();
  return {
    values,
    lists,
    counters,
    setCalls: [] as Array<{
      key: string;
      value: string;
      opts: { nx?: boolean; ttlSec?: number };
    }>,
    incrKeys: [] as string[],
    expireCalls: [] as Array<{ key: string; ttlSec: number }>,
  };
});

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  kvGet: async (key: string) => ({
    ok: true as const,
    value: kv.values.get(key) ?? null,
  }),
  kvSet: async (
    key: string,
    value: string,
    opts: { nx?: boolean; ttlSec?: number } = {},
  ) => {
    kv.setCalls.push({ key, value, opts: { ...opts } });
    if (opts.nx && kv.values.has(key)) return { ok: true as const, value: null };
    kv.values.set(key, value);
    return { ok: true as const, value: 'OK' as const };
  },
  kvDel: async (key: string) => ({
    ok: true as const,
    value: kv.values.delete(key) ? 1 : 0,
  }),
  kvLpush: async (key: string, value: string) => {
    const list = kv.lists.get(key) ?? [];
    list.unshift(value);
    kv.lists.set(key, list);
    return { ok: true as const, value: list.length };
  },
  kvLrange: async (key: string, start: number, stop: number) => ({
    ok: true as const,
    value: (kv.lists.get(key) ?? []).slice(start, stop + 1),
  }),
  kvLtrim: async (key: string, start: number, stop: number) => {
    kv.lists.set(key, (kv.lists.get(key) ?? []).slice(start, stop + 1));
    return { ok: true as const, value: 'OK' as const };
  },
  kvIncr: async (key: string) => {
    kv.incrKeys.push(key);
    const value = (kv.counters.get(key) ?? 0) + 1;
    kv.counters.set(key, value);
    return { ok: true as const, value };
  },
  kvDecr: async (key: string) => {
    const value = (kv.counters.get(key) ?? 0) - 1;
    kv.counters.set(key, value);
    return { ok: true as const, value };
  },
  kvExpire: async (key: string, ttlSec: number) => {
    kv.expireCalls.push({ key, ttlSec });
    return { ok: true as const, value: 1 };
  },
}));

const session = vi.hoisted(() => ({ address: '' }));
vi.mock('../../../app/api/auth/siwe/_session', () => ({
  requireSession: async () => ({ ok: true, address: session.address }),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableCsvPass: true,
      feeReceiver: envConfig.feeReceiver,
      feeReceiverConfigured: true,
    },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/csv-pass/relay/route';
import { csvPassPriceWei } from '@/lib/csvPass';
import { buildTransferWithAuthorizationTypedData } from '@/lib/jpycEip3009';
import { gasBudgetKey, IDEM_TTL_SEC } from '@/lib/relay/relayGuards';

const customer = privateKeyToAccount(CUSTOMER_PK);

beforeEach(() => {
  expect(process.env.RELAYER_PRIVATE_KEY).toBe(RELAYER_PK);
  session.address = customer.address;
  kv.values.clear();
  kv.lists.clear();
  kv.counters.clear();
  kv.setCalls.length = 0;
  kv.incrKeys.length = 0;
  kv.expireCalls.length = 0;
  io.readFunctions.length = 0;
  io.sentRaw.length = 0;
});

describe('POST /api/csv-pass/relay 実 provider 配線', () => {
  it('CSV 専用 idem と共有 rate-limit / budget key を real relay 経路で使う', async () => {
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 200);
    const auth = {
      from: customer.address,
      to: FEE_RECEIVER,
      value: csvPassPriceWei,
      validAfter: 0n,
      validBefore,
      nonce: NONCE,
    };
    const typed = buildTransferWithAuthorizationTypedData(auth, AMOY, JPYC_AMOY);
    const signature = await customer.signTypedData(typed);

    const res = await POST(
      new Request('http://localhost/api/csv-pass/relay', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.42',
        },
        body: JSON.stringify({
          chainId: AMOY,
          from: customer.address,
          value: csvPassPriceWei.toString(),
          validAfter: '0',
          validBefore: validBefore.toString(),
          nonce: NONCE,
          signature,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    const idemKey = `csvpassrelay:idem:${AMOY}:${customer.address.toLowerCase()}:${NONCE.toLowerCase()}`;
    expect(kv.setCalls).toContainEqual({
      key: idemKey,
      value: '1',
      opts: { nx: true, ttlSec: IDEM_TTL_SEC },
    });
    expect(kv.setCalls.some((call) => call.key.startsWith('relay:idem:'))).toBe(false);

    expect(kv.lists.has(`relay:rl:${customer.address}`)).toBe(true);
    expect(kv.lists.has('relay:rl:203.0.113.0/24')).toBe(true);
    expect([...kv.lists.keys()].every((key) => key.startsWith('relay:rl:'))).toBe(true);

    const budgetKey = gasBudgetKey(AMOY);
    expect(kv.incrKeys).toEqual([budgetKey]);
    expect(budgetKey.startsWith(`relay:budget:${AMOY}:`)).toBe(true);
    expect(io.readFunctions).toEqual(
      expect.arrayContaining(['balanceOf', 'authorizationState']),
    );
    expect(io.sentRaw).toEqual(['0x1234']);
  });
});
