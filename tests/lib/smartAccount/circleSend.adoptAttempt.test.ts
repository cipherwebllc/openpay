// 第 10 回レビュー 穴 B (H-V の scan 版・money-path): Circle Paymaster の経路 (USDC のガスレス) で、scan が **別の key の記録**
// (別のタブ・閉じたタブの支払い) の結果を受け取りに行くとき、いつ args.adoptAttempt (attemptId の対応の付け替え) を呼ぶか。
//
// 失敗シナリオ (直す前): 別のタブの支払い R の結果を scan で受け取りに行った押下は、自分の key の記録を作らない。その途中で
// 画面を離れる・確認待ちで終わると、hook の対応は記録の無い attemptId を指したまま残る。R が後から確定して 90 秒を過ぎると、
// 次の押下は R を「正規のリピート」とみなして 2 本目を払う (hook から通した再現は
// tests/hooks/useBatchPayment.circleAdopt.test.tsx)。
//
// 直した後: 受け取りに行く直前 (同期・await の前) に、対応を R の paymentAttemptId に付け替える。条件は
// lib/smartAccount/circleSend.ts の冒頭の「対応の付け替え」。ここは、呼ぶ / 呼ばないの条件と、呼ぶ位置 (await の前) を固定する。
//
// 本物: circleSend・circlePending (jsdom の localStorage)・pimlicoSend の isUserOpNonceConsumed / findUserOperationReceipt。
// 偽物は境界だけ: circleAccount (ウォレットの署名・bundler への送信と receipt の待ち)・bundlerClient.getUserOperationReceipt
// (bundler の照会)・account.client の readContract / getBlock (chain の RPC)。時計は now の注入。
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { getAddress, numberToHex, type Address, type Hex } from 'viem';
import {
  UserOperationReceiptNotFoundError,
  WaitForUserOperationReceiptTimeoutError,
} from 'viem/account-abstraction';

vi.mock('@/lib/smartAccount/circleAccount', () => {
  const broadcastCircleUserOp = vi.fn();
  return {
    signUsdcPermit: vi.fn(),
    prepareAndSignCircleUserOp: vi.fn(),
    broadcastCircleUserOp,
    // 自分の最初の送信は「用意 (prepareCircleBroadcast) → 返った関数で送る」の 2 段。偽物は同じ mock に流す。
    prepareCircleBroadcast: vi.fn(
      (bundle: unknown) => (signedUserOp: unknown) => broadcastCircleUserOp({ bundle, signedUserOp }),
    ),
    waitForCircleReceipt: vi.fn(),
  };
});

import {
  signUsdcPermit,
  prepareAndSignCircleUserOp,
  broadcastCircleUserOp,
  waitForCircleReceipt,
  type CircleSmartAccountBundle,
} from '@/lib/smartAccount/circleAccount';
import {
  executeCirclePayment,
  CirclePendingError,
  STALE_SUBMITTING_WINDOW_MS,
} from '@/lib/smartAccount/circleSend';
import {
  computeCallHash,
  computeIdempotencyKey,
  loadPendingRecord,
  reserveOrResume,
  markAwaitingSignature,
  markSigned,
  markSubmitting,
  markConfirmed,
  markResending,
  PENDING_KEY_PREFIX,
} from '@/lib/circlePending';
import { logger } from '@/lib/logger';
import jaMessages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';

const OWNER = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
const PAYMASTER = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966');
const MERCHANT = getAddress('0x4444444444444444444444444444444444444444');
const CHAIN_ID = 421614;
const CALLS = [{ to: MERCHANT, data: '0xabcd' as Hex }];
const CALL_HASH = computeCallHash(CALLS);
const PERMIT = { paymasterData: '0xpm' as Hex, permitSignature: ('0x' + 'cd'.repeat(65)) as Hex };

const SEC = 1_000;
const MIN = 60 * SEC;
const WINDOW = STALE_SUBMITTING_WINDOW_MS;
// 別のタブの支払い R を最後に bundler へ渡した時刻 = 記録の updatedAt。
const T0 = 1_700_000_000_000;
const CREATED = T0 - 10 * MIN;

// 試みごとに別の op。nonce は本番と同じ形 (上位 192 bit = 時刻由来の key・下位 64 bit = seq 0)。
function op(byte: string, nonceMs: number) {
  const nonce = BigInt(nonceMs) << 64n;
  return {
    nonceKey: nonce >> 64n,
    signedUserOp: { sender: OWNER, nonce: numberToHex(nonce), signature: '0x' + byte.repeat(65) },
    userOpHash: ('0x' + byte.repeat(32)) as Hex,
    txHash: ('0x' + byte.repeat(31) + 'ff') as Hex,
  };
}
type Op = ReturnType<typeof op>;
const OLD = op('aa', T0 - 5 * SEC);
const OLD2 = op('ab', T0 - 4 * SEC);
const NEW = op('bb', T0 + 31 * MIN);

const mockPermit = vi.mocked(signUsdcPermit);
const mockPrepare = vi.mocked(prepareAndSignCircleUserOp);
const mockBroadcast = vi.mocked(broadcastCircleUserOp);
const mockWait = vi.mocked(waitForCircleReceipt);
const mockLookup = vi.fn();
const mockRead = vi.fn();
const mockGetBlock = vi.fn();

const bundle = {
  provider: 'circle',
  entryPointVersion: '0.8',
  chainId: CHAIN_ID,
  paymasterAddress: PAYMASTER,
  account: { client: { readContract: mockRead, getBlock: mockGetBlock } },
  bundlerClient: { getUserOperationReceipt: (args: { hash: Hex }) => mockLookup(args) },
  deployment: {},
} as unknown as CircleSmartAccountBundle;

type FakeReceipt = {
  receipt: { transactionHash: Hex; blockNumber: bigint };
  success: boolean;
  actualGasCost: bigint;
};

// chain と bundler の状態 (偽物の中身)。
let chain: {
  consumed: Set<bigint>;
  blocks: Map<bigint, number>;
  latestMs: number;
  receipts: Map<Hex, FakeReceipt>;
};

// op が chain に取り込まれた (bundler も receipt を返す)。
function include(o: Op, at: { block: bigint; ms: number; success?: boolean }) {
  chain.consumed.add(o.nonceKey);
  chain.blocks.set(at.block, at.ms);
  chain.receipts.set(o.userOpHash, {
    receipt: { transactionHash: o.txHash, blockNumber: at.block },
    success: at.success ?? true,
    actualGasCost: 1000n,
  });
}

function keyOf(paymentAttemptId: string) {
  return computeIdempotencyKey({
    chainId: CHAIN_ID,
    sender: OWNER,
    paymentAttemptId,
    callHash: CALL_HASH,
  });
}
const stored = (attemptId: string) => loadPendingRecord(keyOf(attemptId));

// 別のタブの記録を、本物の遷移で作る。
function seed(
  status: 'signed' | 'submitting' | 'confirmed',
  opts: {
    attemptId?: string;
    o?: Op;
    handedOffAt?: number;
    confirmedAt?: number;
    success?: boolean;
  } = {},
) {
  const { attemptId = 'tab-1', o = OLD, handedOffAt = T0 } = opts;
  const key = keyOf(attemptId);
  reserveOrResume({
    key,
    chainId: CHAIN_ID,
    sender: OWNER,
    callHash: CALL_HASH,
    paymentAttemptId: attemptId,
    paymaster: PAYMASTER,
    now: CREATED,
  });
  markAwaitingSignature({ key, sender: OWNER, now: CREATED + SEC });
  markSigned({
    key,
    sender: OWNER,
    signedUserOp: o.signedUserOp,
    userOpHash: o.userOpHash,
    now: handedOffAt - SEC,
  });
  if (status === 'signed') return key;
  markSubmitting({ key, sender: OWNER, now: handedOffAt });
  if (status === 'submitting') return key;
  markConfirmed({
    key,
    sender: OWNER,
    txHash: o.txHash,
    success: opts.success ?? true,
    now: opts.confirmedAt ?? handedOffAt + SEC,
    userOpHash: o.userOpHash,
  });
  return key;
}

// 保存済みの記録を直接書き換える (本物の遷移では作れない、中身の崩れた記録)。undefined を渡した field は消える。
function rewrite(attemptId: string, patch: Record<string, unknown>) {
  const storageKey = PENDING_KEY_PREFIX + keyOf(attemptId);
  const current = JSON.parse(window.localStorage.getItem(storageKey)!) as Record<string, unknown>;
  window.localStorage.setItem(storageKey, JSON.stringify({ ...current, ...patch }));
}

// ウォレットは署名に応じ、新しい op は送るとすぐ取り込まれる。
function walletSigns(o: Op, landsAt: { block: bigint; ms: number }) {
  mockPermit.mockResolvedValue(PERMIT);
  mockPrepare.mockResolvedValue({ signedUserOp: o.signedUserOp, userOpHash: o.userOpHash });
  mockBroadcast.mockImplementation(async ({ signedUserOp }) => {
    if ((signedUserOp as { signature?: unknown }).signature === o.signedUserOp.signature) {
      include(o, landsAt);
    }
    return o.userOpHash;
  });
}

// 起きた順 (付け替え・receipt の待ち・receipt の照会)。付け替えが await の前であることを見る。
let events: string[];
// hook が渡す関数の偽物 (本物は sessionStorage に書く = tests/hooks/useBatchPayment.circleAdopt.test.tsx)。
const adoptAttempt = vi.fn<(paymentAttemptId: string) => void>();

// 場面の符号 (第 10 回レビュー PR-39c)。press() が確認待ち (CirclePendingError) で終わるたびに、その error の circleCode を
// ここに積む。各 test の後 (下の afterEach) で「'unconfirmed' 以外が残っていない」ことを確かめる = 明示していない確認待ちは
// すべて (a)。(a) 以外を期待する test は、takePendingCodes() で取り出して、その場で確かめる:
//   (e) 'unconfirmed_earlier' = scan が別の key の submitting の記録に当たり、対応を付け替えないまま確認待ちで終わった。
//   (b) 'busy_elsewhere' = 別の試みが署名の途中。
const pendingCodes: unknown[] = [];
const takePendingCodes = () => pendingCodes.splice(0);

// 押す (このタブの attemptId は tab-2)。時刻は固定 (この押下の中の now() は全部 at)。
function press(
  at: number,
  overrides: Partial<Parameters<typeof executeCirclePayment>[0]> = {},
) {
  const attempt = executeCirclePayment({
    bundle,
    publicClient: {} as never,
    walletClient: {} as never,
    owner: OWNER,
    calls: CALLS,
    permitAmount: 5_000_000n,
    paymentAttemptId: 'tab-2',
    now: () => at,
    adoptAttempt,
    ...overrides,
  });
  // 見るだけ (返す promise は元のまま = test の側の rejects・catch は今までどおり)。
  attempt.catch((error: unknown) => {
    if (error instanceof CirclePendingError) pendingCodes.push(error.circleCode);
  });
  return attempt;
}

const signatureRequests = () => mockPermit.mock.calls.length + mockPrepare.mock.calls.length;
const adopted = () => adoptAttempt.mock.calls.map((c) => c[0]);

let warnSpy: MockInstance<typeof logger.warn>;
let infoSpy: MockInstance<typeof logger.info>;

beforeEach(() => {
  window.localStorage.clear();
  pendingCodes.length = 0;
  for (const m of [mockPermit, mockPrepare, mockBroadcast, mockWait, mockLookup, mockRead, mockGetBlock]) {
    m.mockReset();
  }
  adoptAttempt.mockReset();
  events = [];
  adoptAttempt.mockImplementation(() => {
    events.push('adopt');
  });
  chain = { consumed: new Set(), blocks: new Map(), latestMs: T0, receipts: new Map() };

  // EntryPoint.getNonce(sender, key) = key を上位に持つ nonce。使用済みの key は seq が 1 進んでいる。
  mockRead.mockImplementation(async (params: { args: readonly [Address, bigint] }) => {
    const nonceKey = params.args[1];
    return (nonceKey << 64n) + (chain.consumed.has(nonceKey) ? 1n : 0n);
  });
  mockGetBlock.mockImplementation(async (params: { blockNumber?: bigint } = {}) => {
    if (params.blockNumber === undefined) {
      return { timestamp: BigInt(Math.floor(chain.latestMs / SEC)) };
    }
    const ms = chain.blocks.get(params.blockNumber);
    if (ms === undefined) throw new Error(`test: 知らない block ${params.blockNumber}`);
    return { timestamp: BigInt(Math.floor(ms / SEC)) };
  });
  mockLookup.mockImplementation(async ({ hash }: { hash: Hex }) => {
    events.push('lookup');
    const found = chain.receipts.get(hash);
    if (!found) throw new UserOperationReceiptNotFoundError({ hash });
    return found;
  });
  // receipt の待ち: bundler が receipt を持っていれば返し、無ければ 120 秒の timeout。
  mockWait.mockImplementation(async ({ hash }) => {
    events.push('wait');
    const found = chain.receipts.get(hash);
    if (!found) throw new WaitForUserOperationReceiptTimeoutError({ hash });
    return found as never;
  });
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();
  window.localStorage.clear();
  // 確認待ちで終わった押下は、(e)・(b) を期待する test が取り出した分を除いて、すべて (a) 'unconfirmed'。
  expect(pendingCodes.filter((code) => code !== 'unconfirmed')).toEqual([]);
});

describe('穴 B: 別の key の submitting の記録を復旧するとき', () => {
  it('窓の内 (10 分後) → 記録の paymentAttemptId を渡して 1 回呼ぶ。呼ぶのは receipt の待ち (await) の前', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });

    const res = await press(T0 + 10 * MIN);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(adopted()).toEqual(['tab-1']);
    expect(events).toEqual(['adopt', 'wait']);
    // 渡す値は、記録の key の attemptId と同じ (次の押下がその key を resume できる)。
    expect(keyOf(adopted()[0])).toBe(stored('tab-1')!.key);
    expect(signatureRequests()).toBe(0);
  });

  it('復旧が確認待ちで終わる (op がまだ取り込まれていない) ときも、付け替えは済んでいる', async () => {
    seed('submitting');

    const error = await press(T0 + 10 * MIN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CirclePendingError);
    // 場面 (a) (PR-39c): 付け替えたので、次の押下はこの記録の key を resume する (同じ支払いの結果を確かめ直す)。
    expect((error as CirclePendingError).circleCode).toBe('unconfirmed');
    expect((error as CirclePendingError).message).toBe(jaMessages.CircleErrors.unconfirmed);
    expect(adopted()).toEqual(['tab-1']);
    // 待ち → timeout → 同じ op の送り直し → 待ち。付け替えはその前。
    expect(events).toEqual(['adopt', 'wait', 'wait']);
    expect(stored('tab-2')).toBeUndefined();
  });

  it('ちょうど 30 分 → 窓の内: 付け替える (chain は読まない)', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });

    await press(T0 + WINDOW);

    expect(adopted()).toEqual(['tab-1']);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('30 分の 1 ms 後・nonce は未使用 → 今までどおり同じ op を復旧するが、付け替えない', async () => {
    seed('submitting');
    const at = T0 + WINDOW + 1;
    chain.latestMs = at;

    await expect(press(at)).rejects.toBeInstanceOf(CirclePendingError);

    // 場面 (e) (PR-39c): 付け替えていない。
    expect(takePendingCodes()).toEqual(['unconfirmed_earlier']);
    expect(mockRead).toHaveBeenCalledTimes(1);
    // 復旧はしている (待ち → 送り直し → 待ち)。
    expect(events).toEqual(['wait', 'wait']);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(adopted()).toEqual([]);
  });

  it('31 分後・使用済みで取り込みは 5 分前 → 今までどおり前の結果を返すが、付け替えない', async () => {
    seed('submitting');
    const at = T0 + 31 * MIN;
    include(OLD, { block: 100n, ms: at - 5 * MIN });
    chain.latestMs = at;

    const res = await press(at);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(adopted()).toEqual([]);
  });

  it('31 分後・使用済みで取り込みは 31 分前 (飛ばす記録) → 付け替えず、新しい支払いへ進む', async () => {
    seed('submitting');
    const at = T0 + 31 * MIN;
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    chain.latestMs = at + 20 * SEC;
    walletSigns(NEW, { block: 200n, ms: at });

    const res = await press(at);

    expect(res).toMatchObject({ userOpHash: NEW.userOpHash, txHash: NEW.txHash });
    expect(signatureRequests()).toBe(2);
    expect(adopted()).toEqual([]);
  });

  it('31 分後・nonce を読めない (確かめられない記録) → 付け替えず、確認待ち', async () => {
    seed('submitting');
    mockRead.mockRejectedValue(new Error('HTTP request failed. Status: 503'));

    await expect(press(T0 + 31 * MIN)).rejects.toBeInstanceOf(CirclePendingError);

    // 場面 (e) (PR-39c): 付け替えていない。
    expect(takePendingCodes()).toEqual(['unconfirmed_earlier']);
    expect(adopted()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('照合を待つ間に別のタブが同じ op を送り直した (記録の時刻が今になった) → 読み直した記録は窓の内なので、付け替える', async () => {
    const key = seed('submitting');
    const at = T0 + 31 * MIN;
    chain.latestMs = at;
    mockRead.mockImplementationOnce(async (params: { args: readonly [Address, bigint] }) => {
      markResending({ key, sender: OWNER, userOpHash: OLD.userOpHash, now: at });
      include(OLD, { block: 100n, ms: at });
      return params.args[1] << 64n; // 読んだ時点では未使用
    });

    const res = await press(at);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(adopted()).toEqual(['tab-1']);
    expect(events).toEqual(['adopt', 'wait']);
  });

  it.each([
    ['空の文字列', ''],
    ['field が無い', undefined],
  ])('記録の paymentAttemptId が %s → 今までどおり復旧するが、付け替えない', async (_name, value) => {
    seed('submitting');
    rewrite('tab-1', { paymentAttemptId: value });
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });

    const res = await press(T0 + 10 * MIN);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(adopted()).toEqual([]);
  });

  // 付け替えの直前に失効は確かめない。根拠は「ここに来る試みは生きている」= 呼び出し元 (hook) が失効を確かめた同じ tick から、
  // 付け替えまで await が無いこと。その「await が無い」を固定する: executeCirclePayment を呼んで promise が返った時点
  // (= 最初の await に着いた時点) で、付け替えはもう済んでいる。
  it('入口から付け替えまで await が無い: 呼び出しが promise を返した時点で、付け替えは済んでいる (待ちはまだ返っていない)', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });

    const pending = press(T0 + 10 * MIN);
    // ここは press と同じ tick (await していない)。
    expect(adopted()).toEqual(['tab-1']);
    expect(stored('tab-1')?.status).toBe('submitting');

    await expect(pending).resolves.toMatchObject({ userOpHash: OLD.userOpHash });
  });

  // 古い記録の照合 (await) があった押下では、その後の失効の確認 (e) から付け替えまで await が無い。確認の中で microtask を
  // 積み、付け替えがその microtask より前 (= 確認と同じ tick) に起きることを見る。
  it('照合の await の後の失効の確認から付け替えまで await が無い (確認と同じ tick で付け替える)', async () => {
    const key = seed('submitting');
    const at = T0 + 31 * MIN;
    chain.latestMs = at;
    mockRead.mockImplementationOnce(async (params: { args: readonly [Address, bigint] }) => {
      // 待つ間に別のタブが同じ op を送り直した (読み直した記録は窓の内 = 付け替える記録になる)。
      markResending({ key, sender: OWNER, userOpHash: OLD.userOpHash, now: at });
      include(OLD, { block: 100n, ms: at });
      return params.args[1] << 64n;
    });
    const isAlive = () => {
      events.push('alive-check');
      queueMicrotask(() => events.push('next-tick'));
      return true;
    };

    await press(at, { isAlive });

    expect(adopted()).toEqual(['tab-1']);
    expect(events.slice(0, 3)).toEqual(['alive-check', 'adopt', 'wait']);
    expect(events.indexOf('adopt')).toBeLessThan(events.indexOf('next-tick'));
  });

  it('古い記録の照合を待つ間に失効 → scan に着かず payment_cancelled で終わる (窓の内の記録があっても付け替えない)', async () => {
    seed('submitting'); // tab-1: 31 分前 (照合する)
    seed('submitting', { attemptId: 'tab-3', o: OLD2, handedOffAt: T0 + 25 * MIN }); // 窓の内
    const at = T0 + 31 * MIN;
    chain.latestMs = at;
    let alive = true;
    mockRead.mockImplementationOnce(async (params: { args: readonly [Address, bigint] }) => {
      alive = false; // RPC を待つ間に画面を離れた
      return params.args[1] << 64n;
    });

    await expect(press(at, { isAlive: () => alive })).rejects.toThrow('payment_cancelled');

    expect(adopted()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('adoptAttempt を渡さない呼び出し (明示の paymentAttemptId) → 今までどおり復旧する', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });

    const res = await press(T0 + 10 * MIN, { adoptAttempt: undefined });

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(events).toEqual(['wait']);
  });
});

describe('穴 B: 別の key の confirmed の記録の結果を返すとき (90 秒の dedup)', () => {
  const CONFIRMED_AT = T0 + SEC;

  it.each([
    ['30 秒後', CONFIRMED_AT + 30 * SEC],
    ['ちょうど 90 秒後', CONFIRMED_AT + 90 * SEC],
  ])('%s → 記録の paymentAttemptId を渡して 1 回呼ぶ。呼ぶのは receipt の照会 (await) の前', async (_name, at) => {
    seed('confirmed');
    include(OLD, { block: 100n, ms: T0 + SEC });

    const res = await press(at);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(adopted()).toEqual(['tab-1']);
    expect(events).toEqual(['adopt', 'lookup']);
    expect(signatureRequests()).toBe(0);
  });

  it('90 秒の 1 ms 後 (正規のリピート) → 付け替えず、新しい支払いへ進む', async () => {
    seed('confirmed');
    include(OLD, { block: 100n, ms: T0 + SEC });
    const at = CONFIRMED_AT + 90 * SEC + 1;
    walletSigns(NEW, { block: 200n, ms: at });

    const res = await press(at);

    expect(res).toMatchObject({ userOpHash: NEW.userOpHash, txHash: NEW.txHash });
    expect(signatureRequests()).toBe(2);
    expect(adopted()).toEqual([]);
  });

  it('revert した記録 (success: false) は 90 秒以内でも dedup しない → 付け替えず、新しい支払いへ進む', async () => {
    seed('confirmed', { success: false });
    const at = CONFIRMED_AT + 30 * SEC;
    walletSigns(NEW, { block: 200n, ms: at });

    const res = await press(at);

    expect(res).toMatchObject({ userOpHash: NEW.userOpHash, txHash: NEW.txHash });
    expect(adopted()).toEqual([]);
  });

  it('入口から付け替えまで await が無い: 呼び出しが promise を返した時点で、付け替えは済んでいる (照会はまだ返っていない)', async () => {
    seed('confirmed');
    include(OLD, { block: 100n, ms: T0 + SEC });

    const pending = press(CONFIRMED_AT + 30 * SEC);
    // ここは press と同じ tick (await していない)。
    expect(adopted()).toEqual(['tab-1']);

    await expect(pending).resolves.toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
  });

  it('古い confirmed (飛ばす) と窓の内の submitting が両方ある → 受け取りに行く submitting の記録に付け替える', async () => {
    seed('confirmed', { attemptId: 'tab-0', o: OLD2, handedOffAt: T0 - 20 * MIN });
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });

    const res = await press(T0 + 10 * MIN);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(adopted()).toEqual(['tab-1']);
  });
});

describe('穴 B: 付け替えない枝', () => {
  it('直近の pre-submit (別の試みが署名中・op を渡していない記録) → 確認待ち・付け替えない', async () => {
    seed('signed', { handedOffAt: T0 });

    const error = await press(T0 + MIN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CirclePendingError);
    // 場面 (b) (第 10 回レビュー PR-39c): この押下は何も始めていない (別のタブや画面で進行中)。
    expect((error as CirclePendingError).circleCode).toBe('busy_elsewhere');
    expect(takePendingCodes()).toEqual(['busy_elsewhere']);
    expect(adopted()).toEqual([]);
  });

  it('古い pre-submit (3 分より前) → abandoned にして新しい支払いへ進む・付け替えない', async () => {
    seed('signed', { handedOffAt: T0 });
    const at = T0 + 4 * MIN;
    walletSigns(NEW, { block: 200n, ms: at });

    const res = await press(at);

    expect(res).toMatchObject({ userOpHash: NEW.userOpHash, txHash: NEW.txHash });
    expect(stored('tab-1')?.status).toBe('abandoned');
    expect(adopted()).toEqual([]);
  });

  it('記録が何も無い新しい支払い → 付け替えない', async () => {
    walletSigns(NEW, { block: 200n, ms: T0 });

    const res = await press(T0);

    expect(res).toMatchObject({ userOpHash: NEW.userOpHash, txHash: NEW.txHash });
    expect(adopted()).toEqual([]);
  });

  it('自分の key の resume (submitting) → 付け替えない (対応はもうその記録を指している)', async () => {
    seed('submitting', { attemptId: 'tab-2' });
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });

    const res = await press(T0 + 10 * MIN);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(adopted()).toEqual([]);
  });
});

describe('穴 B: 付け替えた後の次の押下 (その記録の attemptId で押す = その key の resume)', () => {
  // 付け替えた後、このタブの attemptId は tab-1 (R の attemptId)。
  const pressAdopted = (at: number) => press(at, { paymentAttemptId: 'tab-1' });

  it('confirmed (2 時間前) → 時間の窓なしで既払いの結果 (署名なし)。自分の key なので、もう付け替えは呼ばない', async () => {
    seed('confirmed');
    include(OLD, { block: 100n, ms: T0 + SEC });

    const res = await pressAdopted(T0 + 120 * MIN);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash, success: true });
    expect(signatureRequests()).toBe(0);
    expect(adopted()).toEqual([]);
  });

  it('submitting (45 分前) → chain を読まずに同じ op を復旧する (resume は古い記録の照合を通らない)', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 44 * MIN });

    const res = await pressAdopted(T0 + 45 * MIN);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(mockRead).not.toHaveBeenCalled();
    expect(signatureRequests()).toBe(0);
  });

  it('記録が無い (24 時間の掃除の後) → 新しい予約 = 新しい支払い (署名 2 回)', async () => {
    seed('confirmed');
    const at = T0 + 25 * 60 * MIN;
    walletSigns(NEW, { block: 200n, ms: at });

    const res = await pressAdopted(at);

    expect(res).toMatchObject({ userOpHash: NEW.userOpHash, txHash: NEW.txHash });
    expect(signatureRequests()).toBe(2);
    expect(stored('tab-1')).toMatchObject({ status: 'confirmed', userOpHash: NEW.userOpHash });
  });

  // 第 10 回レビュー PR-39c (Codex の 2 回目): 場面 (a) の文は「24 時間以内にこのタブで同じ内容のままもう一度押すと、まず同じ
  // 支払いの結果を確かめ直します。それより後は、新しい支払いとして署名を求める場合があります。」と言う。この期限は、確定した
  // 記録を残す期間 (circleSend.ts の TERMINAL_RETENTION_MS・最後の updatedAt から。export していないので動きで固定する) と
  // 同じでなければならない。期間だけを変えて文が古くなる・文だけを変えて期間とずれるのを、ここで止める。
  // 動きは今までどおり (上の test と同じ。変えていない): 固定するのは「文の 24 時間 = 記録が残る期間」。
  it('(a) の文の「24 時間以内」= 確定した記録が残る期間: 確定からちょうど 24 時間は既払いの結果 (署名なし)・1 ms 過ぎると新しい支払い', async () => {
    expect(jaMessages.CircleErrors.unconfirmed).toContain('24 時間以内に');
    expect(jaMessages.CircleErrors.unconfirmed).toContain('それより後は、新しい支払いとして署名を求める場合があります。');
    expect(enMessages.CircleErrors.unconfirmed).toContain('within 24 hours');
    const DAY = 24 * 60 * MIN;

    seed('confirmed');
    const confirmedAt = stored('tab-1')!.updatedAt;
    include(OLD, { block: 100n, ms: confirmedAt });

    // ちょうど 24 時間: 記録は残っている → 同じ支払いの結果を返す (新しい署名を求めない)。
    const kept = await pressAdopted(confirmedAt + DAY);
    expect(kept).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(signatureRequests()).toBe(0);
    // 結果を返すだけで、記録の時刻は進めない (期限が延びない)。
    expect(stored('tab-1')).toMatchObject({ status: 'confirmed', userOpHash: OLD.userOpHash, updatedAt: confirmedAt });

    // 24 時間を 1 ms 過ぎた: 記録は掃除される → 新しい支払い (署名 2 回)。
    walletSigns(NEW, { block: 200n, ms: confirmedAt + DAY + 1 });
    const fresh = await pressAdopted(confirmedAt + DAY + 1);
    expect(fresh).toMatchObject({ userOpHash: NEW.userOpHash, txHash: NEW.txHash });
    expect(signatureRequests()).toBe(2);
  });
});

// 第 10 回レビュー PR-39c (Codex の指摘): 場面 (a) の文は「24 時間以内にこのタブで同じ内容のままもう一度押すと、まず同じ支払いの
// 結果を確かめ直します」と言う。それが成り立つのは、hook の対応が、確認待ちの op の記録の key を指しているときだけ。scan が別の key の
// submitting の記録に当たり、**対応を付け替えないまま** 確認待ちで終わった押下は、次の押下もまた scan から入る (前の支払いが
// その間に確定して 90 秒を過ぎていれば、新しい支払いに署名を求める = H-Z の設計。ここでは固定しない)。なので符号は (e)。
// 固定するのは符号と文だけ。class・name・userOpHash は (a) のときと同じ。
describe('PR-39c: scan の submitting の枝の確認待ち — 付け替えたら (a)・付け替えていなければ (e)', () => {
  async function pendingOf(attempt: Promise<unknown>) {
    const error = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CirclePendingError);
    return error as CirclePendingError;
  }
  function expectEarlier(error: CirclePendingError) {
    expect(error.circleCode).toBe('unconfirmed_earlier');
    expect(Object.hasOwn(error, 'circleCode')).toBe(true);
    expect(error.message).toBe(jaMessages.CircleErrors.unconfirmedEarlier);
    // 変わるのは符号と文だけ。
    expect(error.name).toBe('CirclePendingError');
    expect(error.userOpHash).toBe(OLD.userOpHash);
    expect(takePendingCodes()).toEqual(['unconfirmed_earlier']);
    // この押下は付け替えていない・新しい支払いを始めていない。
    expect(adopted()).toEqual([]);
    expect(signatureRequests()).toBe(0);
    expect(stored('tab-2')).toBeUndefined();
  }

  it('窓の内 (10 分後)・hook が対応を管理している → 付け替える → (a)', async () => {
    seed('submitting');

    const error = await pendingOf(press(T0 + 10 * MIN));

    expect(adopted()).toEqual(['tab-1']);
    expect(error.circleCode).toBe('unconfirmed');
    expect(error.message).toBe(jaMessages.CircleErrors.unconfirmed);
    expect(error.name).toBe('CirclePendingError');
    expect(error.userOpHash).toBe(OLD.userOpHash);
  });

  it('Codex の順 1: 31 分前の記録・確かめられない (nonce を読めない) → 付け替えない → (e)', async () => {
    seed('submitting');
    mockRead.mockRejectedValue(new Error('HTTP request failed. Status: 503'));

    const error = await pendingOf(press(T0 + 31 * MIN));

    expectEarlier(error);
    // 復旧にも進んでいない (待たない・送り直さない)。
    expect(events).toEqual([]);
  });

  it('Codex の順 2: 31 分前の記録・nonce は未使用 → 復旧 (待ち → 送り直し → 待ち) が確認待ちで終わる → 付け替えない → (e)', async () => {
    seed('submitting');
    const at = T0 + 31 * MIN;
    chain.latestMs = at;

    const error = await pendingOf(press(at));

    expectEarlier(error);
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['wait', 'wait']);
  });

  it('31 分前の記録・未使用 → 復旧の最初の待ちが失敗 (bundler の 5xx) → 付け替えない → (e)', async () => {
    seed('submitting');
    const at = T0 + 31 * MIN;
    chain.latestMs = at;
    mockWait.mockRejectedValueOnce(new Error('HTTP request failed. Status: 503'));

    const error = await pendingOf(press(at));

    expectEarlier(error);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('窓の内でも、hook が対応を管理していない呼び出し (adoptAttempt なし) → (e)', async () => {
    seed('submitting');

    const error = await pendingOf(press(T0 + 10 * MIN, { adoptAttempt: undefined }));

    expectEarlier(error);
  });

  it.each([
    ['空の文字列', ''],
    ['field が無い', undefined],
  ])('窓の内でも、記録の paymentAttemptId が %s → 付け替えられない → (e)', async (_name, value) => {
    seed('submitting');
    rewrite('tab-1', { paymentAttemptId: value });

    const error = await pendingOf(press(T0 + 10 * MIN));

    expectEarlier(error);
  });

  it('付け替えた後の次の押下 (その記録の key の resume) の確認待ちは (a)', async () => {
    seed('submitting');

    // 付け替えた記録の attemptId で押す = hook が、付け替えた対応から同じ key を引く。
    const error = await pendingOf(press(T0 + 10 * MIN, { paymentAttemptId: 'tab-1' }));

    expect(error.circleCode).toBe('unconfirmed');
    expect(error.userOpHash).toBe(OLD.userOpHash);
    expect(adopted()).toEqual([]);
  });
});
