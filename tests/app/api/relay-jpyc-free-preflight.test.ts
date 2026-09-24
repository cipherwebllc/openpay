// 決済 relay (/api/relay/jpyc) free 経路の preflight read 障害の実配線テスト (B-R5・A4)。
// route → relayFreeAuthorization → relayJpycAuthorization → relayBroadcast を実走させ、broadcast 前の
// on-chain read (balanceOf / authorizationState) が RPC 例外を投げたときに、recover 経路と同じ
// JSON 503 `preflight_unavailable` を返し、claim / per-from rate-limit / 日次予算 / submit の
// いずれにも到達しないことを endpoint 入口から固定する。外すのは KV と on-chain I/O のみ。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const AMOY = 80002;
const CUSTOMER_PK = (`0x${'2'.repeat(64)}`) as Hex;
const RELAYER_PK = `0x${'1'.repeat(64)}`;
const NONCE = (`0x${'cd'.repeat(32)}`) as Hex;
const MERCHANT = getAddress('0x000000000000000000000000000000000000beef');
const JPYC_AMOY = getAddress('0x0000000000000000000000000000000000000abc');

const io = vi.hoisted(() => ({
  // 例外を投げさせる read (null = 全 read 正常)。
  failRead: null as null | 'balanceOf' | 'authorizationState',
  readFunctions: [] as string[],
  sentRaw: [] as Hex[],
}));

vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  delete process.env.GELATO_SPONSOR_API_KEY;
});

// provider が組み立てる viem clients の I/O だけを固定する。署名 recover / calldata は実物。
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: async (args: { functionName: string }) => {
        io.readFunctions.push(args.functionName);
        if (args.functionName === io.failRead) {
          throw new Error('rpc timeout');
        }
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

const kv = vi.hoisted(() => ({
  values: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  counters: new Map<string, number>(),
  setCalls: [] as string[],
  delCalls: [] as string[],
  incrKeys: [] as string[],
  decrKeys: [] as string[],
}));

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
    kv.setCalls.push(key);
    if (opts.nx && kv.values.has(key)) return { ok: true as const, value: null };
    kv.values.set(key, value);
    return { ok: true as const, value: 'OK' as const };
  },
  kvDel: async (key: string) => {
    kv.delCalls.push(key);
    return { ok: true as const, value: kv.values.delete(key) ? 1 : 0 };
  },
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
    kv.decrKeys.push(key);
    const value = (kv.counters.get(key) ?? 0) - 1;
    kv.counters.set(key, value);
    return { ok: true as const, value };
  },
  kvExpire: async () => ({ ok: true as const, value: 1 }),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableJpycEip3009: true,
      enableUsageFee: false,
      enablePushNotify: false,
    },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/relay/jpyc/route';
import { buildTransferWithAuthorizationTypedData } from '@/lib/jpycEip3009';
import { logger } from '@/lib/logger';
import { hashIp } from '@/lib/net/ipHash';

const customer = privateKeyToAccount(CUSTOMER_PK);

async function post(): Promise<Response> {
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 200);
  const auth = {
    from: customer.address,
    to: MERCHANT,
    value: 300n * 10n ** 18n,
    validAfter: 0n,
    validBefore,
    nonce: NONCE,
  };
  const typed = buildTransferWithAuthorizationTypedData(auth, AMOY, JPYC_AMOY);
  const signature = await customer.signTypedData(typed);
  return POST(
    new Request('http://localhost/api/relay/jpyc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.42',
      },
      body: JSON.stringify({
        chainId: AMOY,
        from: auth.from,
        to: auth.to,
        value: auth.value.toString(),
        validAfter: '0',
        validBefore: validBefore.toString(),
        nonce: NONCE,
        signature,
      }),
    }),
  );
}

beforeEach(() => {
  expect(process.env.RELAYER_PRIVATE_KEY).toBe(RELAYER_PK);
  io.failRead = null;
  io.readFunctions.length = 0;
  io.sentRaw.length = 0;
  kv.values.clear();
  kv.lists.clear();
  kv.counters.clear();
  kv.setCalls.length = 0;
  kv.delCalls.length = 0;
  kv.incrKeys.length = 0;
  kv.decrKeys.length = 0;
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/relay/jpyc free 経路の preflight read 障害 (B-R5)', () => {
  it('前提: 障害なしなら free 経路で claim → rate-limit → 予算 → submit まで進む', async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(io.readFunctions).toEqual(
      expect.arrayContaining(['balanceOf', 'authorizationState']),
    );
    expect(kv.setCalls.some((key) => key.startsWith('relay:idem:'))).toBe(true);
    expect(kv.lists.has(`relay:rl:${customer.address}`)).toBe(true);
    expect(kv.incrKeys.some((key) => key.startsWith(`relay:budget:${AMOY}:`))).toBe(true);
    expect(io.sentRaw).toEqual(['0x1234']);
  });

  it.each([
    ['balanceOf', ['balanceOf']],
    ['authorizationState', ['balanceOf', 'authorizationState']],
  ] as const)(
    '%s の RPC 例外は JSON 503 preflight_unavailable にし、claim / rate-limit / 予算 / submit に進まない',
    async (failRead, expectedReads) => {
      io.failRead = failRead;
      // 入口の IP limiter (iprl:v1:relay-admission) を実際に KV で数えさせ、INCR が
      // それ 1 件だけ = 日次予算には触れていないことを IP_HASH_SECRET の有無に依存せず固定する。
      vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');
      const ipKey = `iprl:v1:relay-admission:${hashIp('203.0.113.42')}`;

      const res = await post();

      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({
        ok: false,
        error: 'preflight_unavailable',
      });
      // preflight read で止まり、以降の on-chain read / broadcast は起きない。
      expect(io.readFunctions).toEqual(expectedReads);
      expect(io.sentRaw).toHaveLength(0);
      // idempotency claim (SET NX) も release (DEL) もしない = false tombstone を作らない。
      expect(kv.setCalls).toEqual([]);
      expect(kv.delCalls).toEqual([]);
      // per-from rate-limit (sliding window list) を消費しない。
      expect(kv.lists.size).toBe(0);
      // 日次予算を INCR も refund (DECR) もしない (INCR は入口 IP limiter の 1 件のみ)。
      expect(kv.incrKeys).toEqual([ipKey]);
      expect(kv.decrKeys).toEqual([]);
      // 握った RPC 障害は warn で観測でき、例外の中身は応答 body に出ない (上の toEqual)。
      expect(logger.warn).toHaveBeenCalledWith('relay.jpyc.preflight_unavailable', {
        chainId: AMOY,
        step: failRead,
        error: expect.objectContaining({ message: 'rpc timeout' }),
      });
    },
  );
});
