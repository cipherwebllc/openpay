// 売上の移動の route を、実物の settle の経路と実署名で通す (plans/store-sales-move.md §2.1・§2.2・P1)。
//
// 外すのは KV (in-memory)・on-chain I/O (viem の createPublicClient)・broadcast (selfHostRelayer)・forwarder の health・
// push の送信だけ。route → purchaseSettleGate → forwarderSettleService → forwarderRecover (verifyForwarderSettle) →
// relayBroadcast → relayGuards (冪等・rate limit・日次予算) → metrics → salesMoveAbuse は実物を走らせる。
//   - 利用料は server 権威: floor でない feeValue は実署名でも 400 fee_value_mismatch
//   - forwarder・feeReceiver 宛ては共有の verifyForwarderSettle が拒む・上限は既存の MAX_VALUE
//   - 成功の副作用 (KV で見る): 冪等 relay:idem: + relay:recover:idem:・払い元の rate limit relay:rl:・日次予算 relay:budget: を
//     既存 relay と同じ key で使い、metrics は sales_move だけ (relay_jpyc は 0)。1% 回避・チップのメッセージ・push は無い
//   - route をまたぐ冪等: 同じ署名を /api/relay/jpyc と /api/relay/jpyc/move に並行で出しても broadcast は 1 本
//   - status の route (/api/relay/jpyc/status) で、/move の tx を復旧できる (署名つき・nonce だけ・KV の hash が無いとき)
//
// 並行の作り方 (vitest 5.0.3 の注意に従う): 1 本目を broadcast (submit) の中で止め、submit の mock が 1 回呼ばれたのを
// vi.waitFor で待ってから 2 本目を送る。route は静的 import で、mock の呼び出し回数 (submit・health) も assert して、
// 実物ではなく mock を通ったことを確かめる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const AMOY = 80002;
const JPY = 10n ** 18n;
const FLOOR = 2n * JPY;
const SENDER_PK = `0x${'4'.repeat(64)}` as Hex;
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0xdead000000000000000000000000000000001234');
const DEST = getAddress('0x1234567890123456789012345678901234567890');
const TX_HASH = `0x${'cd'.repeat(32)}` as Hex;

vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  delete process.env.GELATO_SPONSOR_API_KEY;
  process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY = '0x752b7aad0089286eb7b553d84d05233d80c9fcb4';
  process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS = '0xdead000000000000000000000000000000001234';
  // 上限 (MAX_VALUE) を小さくして value_exceeds_max を実物で見る (移す額 + 利用料 ≤ 1,000 JPYC)。
  process.env.RELAY_MAX_JPYC = '1000';
});

const io = vi.hoisted(() => ({
  submits: [] as string[],
  // 非 null の間、submit は解放されるまで止まる (1 本目を broadcast の途中に置く)。
  hold: null as Promise<void> | null,
}));

vi.mock('@/lib/relay/selfHostRelayer', () => ({
  submitSelfHost: vi.fn(async (_io: unknown, target: Address) => {
    io.submits.push(target);
    if (io.hold) await io.hold;
    return { taskId: TX_HASH };
  }),
  pollSelfHost: vi.fn(async () => ({ state: 'success' as const, txHash: TX_HASH })),
}));
vi.mock('@/lib/relay/forwarderHealth', () => ({
  verifyForwarderHealth: vi.fn(async () => null),
}));

const chain = vi.hoisted(() => ({
  authorizationUsed: false,
  balance: 10_000n * 10n ** 18n,
  receipts: new Map<string, { status: 'success' | 'reverted'; logs: unknown[] }>(),
  usedLogHash: null as string | null,
}));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === 'balanceOf') return chain.balance;
        if (args.functionName === 'authorizationState') return chain.authorizationUsed;
        return 0n;
      },
      getBalance: async () => 10n ** 18n,
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        const receipt = chain.receipts.get(hash);
        if (!receipt) throw new Error('receipt not found');
        return receipt;
      },
      getBlockNumber: async () => 50_000n,
      getLogs: async () => (chain.usedLogHash ? [{ transactionHash: chain.usedLogHash }] : []),
    }),
    createWalletClient: () => ({}),
  };
});

const kv = vi.hoisted(() => ({
  values: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  counters: new Map<string, number>(),
  touched: new Set<string>(),
}));
vi.mock('@/lib/kv', () => {
  const touch = (key: string) => void kv.touched.add(key);
  const incr = (key: string, by: number) => {
    touch(key);
    const value = (kv.counters.get(key) ?? 0) + by;
    kv.counters.set(key, value);
    return { ok: true as const, value };
  };
  return {
    isKvConfigured: () => true,
    kvGet: async (key: string) => {
      touch(key);
      return { ok: true as const, value: kv.values.get(key) ?? null };
    },
    kvSet: async (key: string, value: string, opts: { nx?: boolean } = {}) => {
      touch(key);
      if (opts.nx && kv.values.has(key)) return { ok: true as const, value: null };
      kv.values.set(key, value);
      return { ok: true as const, value: 'OK' as const };
    },
    kvDel: async (key: string) => {
      touch(key);
      return { ok: true as const, value: kv.values.delete(key) ? 1 : 0 };
    },
    kvLpush: async (key: string, value: string) => {
      touch(key);
      const list = kv.lists.get(key) ?? [];
      list.unshift(value);
      kv.lists.set(key, list);
      return { ok: true as const, value: list.length };
    },
    kvLrange: async (key: string, start: number, stop: number) => ({
      ok: true as const,
      value: (kv.lists.get(key) ?? []).slice(start, stop + 1),
    }),
    kvIncr: async (key: string) => incr(key, 1),
    kvIncrBy: async (key: string, by: number) => incr(key, by),
    kvDecr: async (key: string) => incr(key, -1),
    kvExpire: async () => ({ ok: true as const, value: 1 }),
  };
});

const post = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  push: vi.fn(async () => undefined),
  tipStore: vi.fn(async () => undefined),
}));
// 応答後の処理を貯めて、テストが明示的に流す (after に回っていることも見る)。
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => unknown) => void post.afterTasks.push(cb) };
});
vi.mock('@/lib/push/notify', () => ({
  notifyPaymentReceived: (...args: unknown[]) => post.push(...(args as [])),
}));
vi.mock('@/lib/tipMessages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tipMessages')>()),
  storeTipMessage: (...args: unknown[]) => post.tipStore(...(args as [])),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableJpycEip3009: true,
      enableSalesMove: true,
      feeReceiver: '0xdead000000000000000000000000000000001234',
      feeReceiverConfigured: true,
      enableUsageFee: false,
      enableMobileOrderFee: false,
      // 決済の経路なら push・チップのメッセージ・1% 回避 (bps 100 で 1,000 JPYC のチップは回避の件) が動く設定。
      enablePushNotify: true,
      enableTipMessage: true,
      recoverFeeBps: 100,
    },
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST as movePost } from '@/app/api/relay/jpyc/move/route';
import { POST as relayPost } from '@/app/api/relay/jpyc/route';
import { POST as statusPost } from '@/app/api/relay/jpyc/status/route';
import {
  buildForwarderNonce,
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { jpycAddressFor } from '@/lib/relay/relayProvider';
import { SHARED_RECOVER_IDEM_PREFIX } from '@/lib/relay/relayGuards';
import { submitSelfHost } from '@/lib/relay/selfHostRelayer';
import { verifyForwarderHealth } from '@/lib/relay/forwarderHealth';
import { currentMetricMonth } from '@/lib/metrics';

const sender = privateKeyToAccount(SENDER_PK);
const SENDER = getAddress(sender.address);
const SETTLED_ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

function makeParams(over: Partial<ForwarderSettleParams> = {}): ForwarderSettleParams {
  return {
    from: SENDER,
    merchant: DEST,
    merchantValue: 500n * JPY,
    feeReceiver: FEE_RECEIVER,
    feeValue: FLOOR,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
    intentSalt: `0x${'5a'.repeat(32)}` as Hex,
    ...over,
  };
}

async function sign(params: ForwarderSettleParams): Promise<Hex> {
  const jpyc = jpycAddressFor(AMOY);
  if (!jpyc) throw new Error('JPYC address unresolved for Amoy');
  return sender.signTypedData(buildReceiveWithAuthorizationTypedData(params, AMOY, jpyc, FORWARDER));
}

function payload(params: ForwarderSettleParams, signature: Hex, extra: Record<string, unknown> = {}) {
  return {
    chainId: AMOY,
    from: params.from,
    merchant: params.merchant,
    merchantValue: params.merchantValue.toString(),
    feeValue: params.feeValue.toString(),
    validAfter: params.validAfter.toString(),
    validBefore: params.validBefore.toString(),
    intentSalt: params.intentSalt,
    signature,
    ...extra,
  };
}

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const move = (body: unknown) => movePost(request('/api/relay/jpyc/move', body));
const relay = (body: unknown) => relayPost(request('/api/relay/jpyc', body));
const status = (body: unknown) => statusPost(request('/api/relay/jpyc/status', body));

async function flushAfter(): Promise<void> {
  while (post.afterTasks.length > 0) {
    const tasks = post.afterTasks.splice(0);
    await Promise.all(tasks.map((task) => task()));
  }
}

const month = () => currentMetricMonth();
const metric = (kind: string) => kv.counters.get(`metrics:${month()}:${kind}`) ?? 0;
const touched = (prefix: string) => [...kv.touched].filter((k) => k.startsWith(prefix));
const idemKey = (prefix: string, params: ForwarderSettleParams) =>
  `${prefix}${AMOY}:${params.from.toLowerCase()}:${buildForwarderNonce(params, AMOY, FORWARDER).toLowerCase()}`;

function settledReceipt(params: ForwarderSettleParams) {
  return {
    status: 'success' as const,
    logs: [
      {
        address: FORWARDER,
        topics: encodeEventTopics({
          abi: SETTLED_ABI,
          eventName: 'Settled',
          args: {
            from: params.from,
            nonce: buildForwarderNonce(params, AMOY, FORWARDER),
            merchant: params.merchant,
          },
        }) as Hex[],
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
          [params.merchantValue, params.feeReceiver, params.feeValue],
        ),
      },
    ],
  };
}

beforeEach(() => {
  kv.values.clear();
  kv.lists.clear();
  kv.counters.clear();
  kv.touched.clear();
  io.submits.length = 0;
  io.hold = null;
  chain.authorizationUsed = false;
  chain.balance = 10_000n * JPY;
  chain.receipts.clear();
  chain.usedLogHash = null;
  post.afterTasks.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/relay/jpyc/move — 実署名で実物の settle の経路を通す', () => {
  it('成功: forwarder.settle を 1 本送り、既存 relay と同じ key の守りを通り、sales_move だけを数える', async () => {
    const params = makeParams();
    const res = await move(payload(params, await sign(params), { tipMessage: 'thanks', gasMode: 'customer' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, txHash: TX_HASH });
    // mock を通った証拠 (実物の broadcast・RPC ではない)。
    expect(vi.mocked(verifyForwarderHealth)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitSelfHost)).toHaveBeenCalledTimes(1);
    expect(io.submits).toEqual([FORWARDER]);

    // 既存 relay と同じ key: 冪等 (route 別 + 入口をまたぐ共有)・払い元の rate limit・日次予算。
    expect(kv.values.get(idemKey('relay:idem:', params))).toBe(TX_HASH);
    expect(kv.values.get(idemKey(SHARED_RECOVER_IDEM_PREFIX, params))).toBe(TX_HASH);
    expect(kv.lists.get(`relay:rl:${SENDER}`)).toHaveLength(1);
    expect(touched(`relay:budget:${AMOY}:`)).toHaveLength(1);

    // 記録は応答後 (after) に回る。流す前は何も数えていない。
    expect(metric('sales_move')).toBe(0);
    await flushAfter();
    expect(metric('sales_move')).toBe(1);
    expect(metric('relay_jpyc')).toBe(0);
    const base = `relay:move:${month()}:${AMOY}:${DEST.toLowerCase()}`;
    expect(kv.values.get(`${base}:${SENDER.toLowerCase()}`)).toBe('1');
    expect(kv.counters.get(`${base}:senders`)).toBe(1);

    // 決済・チップの後処理は走らない (push・チップのメッセージは ON・bps 100 で 1% 回避の件に当たる額でも)。
    expect(post.push).not.toHaveBeenCalled();
    expect(post.tipStore).not.toHaveBeenCalled();
    expect(touched('relay:fee-avoid:')).toEqual([]);
    expect(touched('tipmsg:')).toEqual([]);
    expect(touched('push:')).toEqual([]);
  });

  it('利用料は server 権威の floor: 少なくても多くても、実署名でも 400 fee_value_mismatch (gasMode=merchant でも同じ)', async () => {
    for (const feeValue of [1n * JPY, 3n * JPY, 0n]) {
      const params = makeParams({ feeValue });
      const res = await move(payload(params, await sign(params), { gasMode: 'merchant' }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'fee_value_mismatch' });
    }
    expect(io.submits).toHaveLength(0);
    await flushAfter();
    expect(metric('sales_move')).toBe(0);
  });

  it('forwarder・feeReceiver 宛ては共有の verifyForwarderSettle が拒む (broadcast しない)', async () => {
    const toForwarder = makeParams({ merchant: FORWARDER });
    let res = await move(payload(toForwarder, await sign(toForwarder)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'merchant_is_forwarder' });

    const toFeeReceiver = makeParams({ merchant: FEE_RECEIVER });
    res = await move(payload(toFeeReceiver, await sign(toFeeReceiver)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'merchant_is_fee_receiver' });
    expect(io.submits).toHaveLength(0);
  });

  it('上限は既存の MAX_VALUE (移す額 + 利用料): 1,000 JPYC を超えると 400 value_exceeds_max', async () => {
    const over = makeParams({ merchantValue: 999n * JPY });
    let res = await move(payload(over, await sign(over)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'value_exceeds_max' });

    const edge = makeParams({ merchantValue: 998n * JPY });
    res = await move(payload(edge, await sign(edge)));
    expect(res.status).toBe(200);
    expect(io.submits).toHaveLength(1);
  });

  it('ウォレットにある JPYC が移す額 + 利用料に足りなければ 400 insufficient_balance', async () => {
    chain.balance = 501n * JPY;
    const params = makeParams();
    const res = await move(payload(params, await sign(params)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'insufficient_balance' });
    expect(io.submits).toHaveLength(0);
  });

  it('別の人の署名 (from と一致しない) は 400 signature_mismatch', async () => {
    const params = makeParams();
    const other = privateKeyToAccount(`0x${'6'.repeat(64)}` as Hex);
    const jpyc = jpycAddressFor(AMOY)!;
    const signature = await other.signTypedData(
      buildReceiveWithAuthorizationTypedData(params, AMOY, jpyc, FORWARDER),
    );
    const res = await move(payload(params, signature));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'signature_mismatch' });
  });
});

describe('route をまたぐ冪等: 同じ署名を /api/relay/jpyc と /api/relay/jpyc/move に並行で出しても broadcast は 1 本', () => {
  async function inFlight(first: () => Promise<Response>) {
    let release!: () => void;
    io.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = first();
    // 1 本目が claim を取り、broadcast (submit) の中で止まったのを待ってから 2 本目を送る。
    await vi.waitFor(() => expect(vi.mocked(submitSelfHost)).toHaveBeenCalledTimes(1));
    return { pending, release };
  }

  it('既存 relay が broadcast 中に /move → 202 pending (broadcast しない)・記録は決済側だけ (受容した限界)', async () => {
    const params = makeParams();
    const signature = await sign(params);
    const { pending, release } = await inFlight(() =>
      relay(payload(params, signature, { gasMode: 'customer' })),
    );

    const second = await move(payload(params, signature));
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ ok: false, pending: true, txHash: null });
    expect(io.submits).toHaveLength(1);

    release();
    const first = await pending;
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, txHash: TX_HASH });
    expect(vi.mocked(submitSelfHost)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyForwarderHealth)).toHaveBeenCalledTimes(2);

    await flushAfter();
    // 同じ署名が既存 relay で通ると、記録は決済・チップ側 (relay_jpyc・push・1% 回避) になる。
    expect(metric('relay_jpyc')).toBe(1);
    expect(metric('sales_move')).toBe(0);
    expect(post.push).toHaveBeenCalledTimes(1);
    expect(touched('relay:fee-avoid:').length).toBeGreaterThan(0);
    expect(touched('relay:move:')).toEqual([]);
  });

  it('/move が broadcast 中に既存 relay → 202 pending (broadcast しない)・記録は sales_move だけ', async () => {
    const params = makeParams();
    const signature = await sign(params);
    const { pending, release } = await inFlight(() => move(payload(params, signature)));

    const second = await relay(payload(params, signature, { gasMode: 'customer' }));
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ ok: false, pending: true, txHash: null });
    expect(io.submits).toHaveLength(1);

    release();
    const first = await pending;
    expect(first.status).toBe(200);
    expect(vi.mocked(submitSelfHost)).toHaveBeenCalledTimes(1);

    await flushAfter();
    expect(metric('sales_move')).toBe(1);
    expect(metric('relay_jpyc')).toBe(0);
    expect(post.push).not.toHaveBeenCalled();
    expect(touched('relay:fee-avoid:')).toEqual([]);
  });

  it('/move の後に同じ署名を既存 relay へ出すと、記録済みの txHash つきの 202 pending (再 broadcast しない)', async () => {
    const params = makeParams();
    const signature = await sign(params);
    expect((await move(payload(params, signature))).status).toBe(200);
    const again = await relay(payload(params, signature, { gasMode: 'customer' }));
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ ok: false, pending: true, txHash: TX_HASH });
    const moveAgain = await move(payload(params, signature));
    expect(moveAgain.status).toBe(202);
    expect(await moveAgain.json()).toEqual({ ok: false, pending: true, txHash: TX_HASH });
    expect(io.submits).toHaveLength(1);
  });
});

describe('status の route で /move の tx を復旧できる (応答が失われた後)', () => {
  async function settledMove(): Promise<{ params: ForwarderSettleParams; signature: Hex }> {
    const params = makeParams();
    const signature = await sign(params);
    expect((await move(payload(params, signature))).status).toBe(200);
    chain.authorizationUsed = true;
    chain.receipts.set(TX_HASH, settledReceipt(params));
    return { params, signature };
  }

  it('署名つきの照会 (recover の形のまま) は settled と txHash を返す', async () => {
    const { params, signature } = await settledMove();
    const res = await status(payload(params, signature));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: TX_HASH });
  });

  it('nonce だけの照会 (再読み込みの後) も settled と txHash を返す', async () => {
    const { params } = await settledMove();
    const res = await status({
      lookup: 'nonce',
      chainId: AMOY,
      from: params.from,
      nonce: buildForwarderNonce(params, AMOY, FORWARDER),
    });
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: TX_HASH });
  });

  it('KV の hash が消えていても、チェーンの AuthorizationUsed から tx を見つけて settled を返す', async () => {
    const { params, signature } = await settledMove();
    kv.values.delete(idemKey('relay:idem:', params));
    chain.usedLogHash = TX_HASH;
    const res = await status(payload(params, signature));
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: TX_HASH });
  });

  it('broadcast 前 (未使用) は unused で、別の分割の Settled を成功と取り違えない', async () => {
    const params = makeParams();
    const signature = await sign(params);
    let res = await status(payload(params, signature));
    expect(await res.json()).toEqual({ ok: true, state: 'unused' });

    // 移した後に、receipt の Settled が別の送り先 (分割が違う) なら settled にしない。
    expect((await move(payload(params, signature))).status).toBe(200);
    chain.authorizationUsed = true;
    chain.receipts.set(TX_HASH, settledReceipt({ ...params, merchant: getAddress(`0x${'9'.repeat(40)}`) }));
    res = await status(payload(params, signature));
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
  });
});
