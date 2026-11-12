// 第 10 回レビュー H-Z (money-path): Circle Paymaster の経路 (USDC のガスレス) で、別の key (別のタブ・タブを開き直した後) の
// **古い submitting の記録** を scan が拾ったときの扱い。
//
// 失敗シナリオ (直す前):
//  - 筋 1 (偽の成功): 送った後・成功を出す前にタブを閉じた支払いの記録が submitting のまま残る。何分・何日か後に、別のタブで
//    同じ内容 (同じ店・同じ額・同じウォレット・同じ chain) を押すと、scan が前の op の receipt をすぐ取り、署名を 1 回も
//    求めずに「前の支払い」を今回の成功として返す。
//  - 筋 2 (止まり続ける): 前の op の receipt を bundler が返さないと、押すたびに 120 秒待ち → 同じ op の送り直し → 120 秒、で
//    確認待ち。送り直しのたびに記録の時刻が進むので 7 日の掃除にも届かない。
//
// 直した後: 最後に bundler へ渡してから 30 分より後の、別の key の submitting の記録は、EntryPoint の nonce を読んで決める
// (lib/smartAccount/circleSend.ts の冒頭の「古い submitting の記録」)。
//
// 本物: circleSend・circlePending (jsdom の localStorage)・pimlicoSend の isUserOpNonceConsumed / findUserOperationReceipt。
// 偽物は境界だけ: circleAccount (ウォレットの署名・bundler への送信と receipt の待ち)・bundlerClient.getUserOperationReceipt
// (bundler の照会)・account.client の readContract / getBlock (chain の RPC)。時計は now の注入。
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import {
  entryPoint08Address,
  UserOperationReceiptNotFoundError,
  WaitForUserOperationReceiptTimeoutError,
} from 'viem/account-abstraction';

vi.mock('@/lib/smartAccount/circleAccount', () => {
  const broadcastCircleUserOp = vi.fn();
  return {
    signUsdcPermit: vi.fn(),
    prepareAndSignCircleUserOp: vi.fn(),
    broadcastCircleUserOp,
    // 自分の最初の送信は「用意 (prepareCircleBroadcast) → 返った関数で送る」の 2 段。偽物は同じ mock に流す (最初の送信も
    // 復旧の送り直しも mockBroadcast で見る)。
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
  markRejected,
  markResending,
  PENDING_KEY_PREFIX,
} from '@/lib/circlePending';
import { logger } from '@/lib/logger';

// EntryPoint 0.8 (viem の entryPoint08Address)。literal で固定する (0.7 の address を読む変更を落とす)。
const ENTRY_POINT_08 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

const OWNER = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
const OTHER_ACCOUNT = getAddress('0x9999999999999999999999999999999999999999');
const PAYMASTER = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966');
const MERCHANT = getAddress('0x4444444444444444444444444444444444444444');
const CHAIN_ID = 421614;
const CALLS = [{ to: MERCHANT, data: '0xabcd' as Hex }];
const CALL_HASH = computeCallHash(CALLS);
const PERMIT = { paymasterData: '0xpm' as Hex, permitSignature: ('0x' + 'cd'.repeat(65)) as Hex };

const SEC = 1_000;
const MIN = 60 * SEC;
const WINDOW = STALE_SUBMITTING_WINDOW_MS;
// 前の支払い (別のタブ) を最後に bundler へ渡した時刻 = 記録の updatedAt。
const T0 = 1_700_000_000_000;
// 前の支払いの記録を作った時刻。updatedAt と 10 分ずらす (窓の基準を createdAt にする変更を落とす)。
const CREATED = T0 - 10 * MIN;

// 試みごとに別の op。nonce は本番と同じ形 (上位 192 bit = 時刻由来の key・下位 64 bit = seq 0)。
function op(byte: string, nonceMs: number) {
  const nonce = BigInt(nonceMs) << 64n;
  return {
    nonce,
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
const NEW2 = op('bc', T0 + 32 * MIN);

const mockPermit = vi.mocked(signUsdcPermit);
const mockPrepare = vi.mocked(prepareAndSignCircleUserOp);
const mockBroadcast = vi.mocked(broadcastCircleUserOp);
const mockWait = vi.mocked(waitForCircleReceipt);
// bundler の receipt の照会 (1 回ずつ・待たない)。
const mockLookup = vi.fn();
// chain の RPC (account.client)。
const mockRead = vi.fn();
const mockGetBlock = vi.fn();

function bundleWith(account: unknown): CircleSmartAccountBundle {
  return {
    provider: 'circle',
    entryPointVersion: '0.8',
    chainId: CHAIN_ID,
    paymasterAddress: PAYMASTER,
    account,
    bundlerClient: { getUserOperationReceipt: (args: { hash: Hex }) => mockLookup(args) },
    deployment: {},
  } as unknown as CircleSmartAccountBundle;
}
const bundle = bundleWith({ client: { readContract: mockRead, getBlock: mockGetBlock } });

type FakeReceipt = {
  receipt: { transactionHash: Hex; blockNumber: bigint };
  success: boolean;
  actualGasCost: bigint;
};

// chain と bundler の状態 (偽物の中身)。
let chain: {
  // 使用済みの nonce の key (その key の op が 1 本取り込まれた)。
  consumed: Set<bigint>;
  // block 番号 → その block の時刻 (ms)。
  blocks: Map<bigint, number>;
  // 最新の block の時刻 (ms)。
  latestMs: number;
  // bundler が返せる receipt。
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

// 送られた op が o か (記録から読み直した op は別の object なので、署名で比べる)。
const isOp = (signedUserOp: unknown, o: Op) =>
  (signedUserOp as { signature?: unknown }).signature === o.signedUserOp.signature;

const timeoutOf = (hash: Hex) => new WaitForUserOperationReceiptTimeoutError({ hash });
// 待ち・照会・RPC そのものの失敗 (5xx)。
const rpcDown = () => new Error('HTTP request failed. Status: 503');

function keyOf(paymentAttemptId: string) {
  return computeIdempotencyKey({
    chainId: CHAIN_ID,
    sender: OWNER,
    paymentAttemptId,
    callHash: CALL_HASH,
  });
}
const stored = (attemptId: string) => loadPendingRecord(keyOf(attemptId));
const rawRecord = (attemptId: string) =>
  window.localStorage.getItem(PENDING_KEY_PREFIX + keyOf(attemptId));

// 別のタブの記録を、本物の遷移で作る。
function seed(
  status: 'signed' | 'submitting' | 'confirmed',
  opts: {
    attemptId?: string;
    o?: Op;
    createdAt?: number;
    handedOffAt?: number;
    resentAt?: number;
    confirmedAt?: number;
  } = {},
) {
  const { attemptId = 'tab-1', o = OLD, createdAt = CREATED, handedOffAt = T0 } = opts;
  const key = keyOf(attemptId);
  reserveOrResume({
    key,
    chainId: CHAIN_ID,
    sender: OWNER,
    callHash: CALL_HASH,
    paymentAttemptId: attemptId,
    paymaster: PAYMASTER,
    now: createdAt,
  });
  markAwaitingSignature({ key, sender: OWNER, now: createdAt + SEC });
  markSigned({
    key,
    sender: OWNER,
    signedUserOp: o.signedUserOp,
    userOpHash: o.userOpHash,
    now: handedOffAt - SEC,
  });
  if (status === 'signed') return key;
  markSubmitting({ key, sender: OWNER, now: handedOffAt });
  if (opts.resentAt !== undefined) {
    markResending({ key, sender: OWNER, userOpHash: o.userOpHash, now: opts.resentAt });
  }
  if (status === 'submitting') return key;
  markConfirmed({
    key,
    sender: OWNER,
    txHash: o.txHash,
    success: true,
    now: opts.confirmedAt ?? handedOffAt + SEC,
    userOpHash: o.userOpHash,
  });
  return key;
}

// 保存済みの記録を直接書き換える (本物の遷移では作れない、中身の崩れた記録)。
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
    if (isOp(signedUserOp, o)) include(o, landsAt);
    return ('0x' + String((signedUserOp as { signature: string }).signature).slice(2, 4).repeat(32)) as Hex;
  });
}

// 押す。時刻は固定 (この押下の中の now() は全部 at)。
function press(
  at: number,
  overrides: Partial<Parameters<typeof executeCirclePayment>[0]> = {},
) {
  return executeCirclePayment({
    bundle,
    publicClient: {} as never,
    walletClient: {} as never,
    owner: OWNER,
    calls: CALLS,
    permitAmount: 5_000_000n,
    paymentAttemptId: 'tab-2',
    now: () => at,
    ...overrides,
  });
}

const signatureRequests = () => mockPermit.mock.calls.length + mockPrepare.mock.calls.length;
const sentOps = () => mockBroadcast.mock.calls.map((c) => c[0].signedUserOp);
const waitedHashes = () => mockWait.mock.calls.map((c) => c[0].hash);
const lookedUpHashes = () => mockLookup.mock.calls.map((c) => (c[0] as { hash: Hex }).hash);
const nonceReads = () =>
  mockRead.mock.calls.map(
    (c) => c[0] as { address: Address; functionName: string; args: readonly [Address, bigint] },
  );

let warnSpy: MockInstance<typeof logger.warn>;
const warned = (msg: string) =>
  warnSpy.mock.calls.filter((c) => c[0] === msg).map((c) => c[1] as Record<string, unknown>);
const staleWarnings = () =>
  warnSpy.mock.calls.filter((c) => String(c[0]).startsWith('circle.stale_submitting.'));

beforeEach(() => {
  window.localStorage.clear();
  for (const m of [mockPermit, mockPrepare, mockBroadcast, mockWait, mockLookup, mockRead, mockGetBlock]) {
    m.mockReset();
  }
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
    const found = chain.receipts.get(hash);
    if (!found) throw new UserOperationReceiptNotFoundError({ hash });
    return found;
  });
  // receipt の待ち: bundler が receipt を持っていれば返し、無ければ 120 秒の timeout。
  mockWait.mockImplementation(async ({ hash }) => {
    const found = chain.receipts.get(hash);
    if (!found) throw timeoutOf(hash);
    return found as never;
  });
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  window.localStorage.clear();
});

describe('H-Z: 窓 (最後に bundler へ渡してから 30 分)', () => {
  it('窓は 30 分', () => {
    expect(STALE_SUBMITTING_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  // 前の op は最初に渡した 1 分後に取り込まれたが、receipt を取れないまま T0 に同じ op を送り直し、成功を出す前にタブが
  // 閉じた (記録は submitting のまま・updatedAt = T0)。取り込みは「最後に渡した時刻」より前なので、押下が窓の外なら取り込みも
  // 窓の外。
  function oldPaymentLanded() {
    seed('submitting', { handedOffAt: T0 - 5 * MIN, resentAt: T0 });
    expect(stored('tab-1')).toMatchObject({ createdAt: CREATED, updatedAt: T0 });
    include(OLD, { block: 100n, ms: T0 - 4 * MIN });
  }

  it.each([
    ['ちょうど 30 分', T0 + WINDOW],
    ['30 分の 1 ms 前', T0 + WINDOW - 1],
  ])('%s → 窓の内: chain を読まず、今までどおり前の op を復旧して前の結果を返す', async (_name, at) => {
    oldPaymentLanded();
    chain.latestMs = at;
    walletSigns(NEW, { block: 200n, ms: at });

    const res = await press(at);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash, success: true });
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(waitedHashes()).toEqual([OLD.userOpHash]);
    expect(signatureRequests()).toBe(0);
    expect(sentOps()).toEqual([]);
    expect(stored('tab-1')?.status).toBe('confirmed');
  });

  it('30 分の 1 ms 後 → EntryPoint 0.8 の getNonce(sender, key) を 1 回読む。使用済みで取り込みが 30 分より前 → 新しい支払い', async () => {
    oldPaymentLanded();
    const at = T0 + WINDOW + 1;
    chain.latestMs = at;
    walletSigns(NEW, { block: 200n, ms: at });

    const res = await press(at);

    expect(nonceReads()).toHaveLength(1);
    expect(nonceReads()[0].address).toBe(ENTRY_POINT_08);
    expect(nonceReads()[0].address).toBe(entryPoint08Address);
    expect(nonceReads()[0].functionName).toBe('getNonce');
    // sender は記録の sender (小文字にそろえた形)・key は保存した op の nonce の上位 192 bit。
    expect(nonceReads()[0].args).toEqual([OWNER.toLowerCase(), OLD.nonceKey]);
    expect(res).toMatchObject({ userOpHash: NEW.userOpHash, txHash: NEW.txHash, success: true });
    expect(signatureRequests()).toBe(2);
    expect(sentOps()).toEqual([NEW.signedUserOp]);
  });

  it('基準は updatedAt: 記録を作ったのは 40 分前でも、最後に渡した (送り直した) のが 10 分前なら窓の内 (chain を読まない)', async () => {
    seed('submitting', { createdAt: T0 - 30 * MIN, handedOffAt: T0 - 29 * MIN, resentAt: T0 });
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    const at = T0 + 10 * MIN;
    expect(at - stored('tab-1')!.createdAt).toBeGreaterThan(WINDOW);
    expect(at - stored('tab-1')!.updatedAt).toBeLessThan(WINDOW);

    const res = await press(at);

    expect(res.txHash).toBe(OLD.txHash);
    expect(mockRead).not.toHaveBeenCalled();
    expect(signatureRequests()).toBe(0);
  });

  it('同じ key の resume は古くても変えない: chain を読まず、今までどおり同じ op を復旧する', async () => {
    seed('submitting', { attemptId: 'tab-2' });
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    const at = T0 + 3 * 24 * 60 * MIN;
    chain.latestMs = at;

    const res = await press(at); // 同じ attemptId = 同じ key

    expect(res.txHash).toBe(OLD.txHash);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(waitedHashes()).toEqual([OLD.userOpHash]);
    expect(signatureRequests()).toBe(0);
  });
});

describe('H-Z: 窓の外・nonce が使用済み', () => {
  const AT = T0 + 31 * MIN;

  it('筋 1 の回帰: 前の支払いは 31 分前に成立済み → 前の結果を返さず、署名を求めて新しい op を 1 本送る。古い記録は書き換えない', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    chain.latestMs = AT + 20 * SEC; // chain の時計では、取り込みから 31 分 8 秒
    walletSigns(NEW, { block: 200n, ms: AT });
    const oldRecordBefore = rawRecord('tab-1');

    const res = await press(AT);

    expect(res).toMatchObject({ userOpHash: NEW.userOpHash, txHash: NEW.txHash, success: true });
    expect(signatureRequests()).toBe(2);
    expect(sentOps()).toEqual([NEW.signedUserOp]);
    // 古い op は待たない・送り直さない。
    expect(waitedHashes()).toEqual([NEW.userOpHash]);
    // 古い記録は 1 byte も変わらない (confirmed に直さない・時刻も書かない)。
    expect(rawRecord('tab-1')).toBe(oldRecordBefore);
    expect(stored('tab-1')?.status).toBe('submitting');
    expect(stored('tab-2')).toMatchObject({ status: 'confirmed', userOpHash: NEW.userOpHash });
    // 進んだことを warn に残す (最後に渡してからの経過・取り込みからの経過・receipt の有無)。
    expect(warned('circle.stale_submitting.proceed')).toEqual([
      {
        userOpHash: OLD.userOpHash,
        sinceHandoffMs: 31 * MIN,
        sinceInclusionMs: 31 * MIN + 8 * SEC,
        receiptFound: true,
      },
    ]);
  });

  it('筋 2 の回帰: 使用済みだが bundler が receipt を返さない → 待ちも送り直しもせずに新しい支払いへ。block は読まない', async () => {
    seed('submitting');
    chain.consumed.add(OLD.nonceKey); // 取り込まれたが、bundler はもう receipt を引けない
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });
    const oldRecordBefore = rawRecord('tab-1');

    const res = await press(AT);

    expect(res.txHash).toBe(NEW.txHash);
    expect(lookedUpHashes()).toEqual([OLD.userOpHash]);
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(waitedHashes()).toEqual([NEW.userOpHash]);
    expect(sentOps()).toEqual([NEW.signedUserOp]);
    expect(rawRecord('tab-1')).toBe(oldRecordBefore);
    expect(warned('circle.stale_submitting.proceed')).toEqual([
      { userOpHash: OLD.userOpHash, sinceHandoffMs: 31 * MIN, receiptFound: false },
    ]);
  });

  it('取り込みが新しい (5 分前) → 今までどおり復旧: 新しい署名なし・前の結果', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: AT - 5 * MIN });
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });

    const res = await press(AT);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(signatureRequests()).toBe(0);
    expect(sentOps()).toEqual([]);
    expect(waitedHashes()).toEqual([OLD.userOpHash]);
    expect(stored('tab-1')?.status).toBe('confirmed');
    expect(stored('tab-2')).toBeUndefined();
    expect(staleWarnings()).toEqual([]);
  });

  it.each([
    ['ちょうど 30 分 (1800 秒) → 窓の内 = 復旧', 30 * MIN, 'recover'],
    ['30 分と 1 秒 → 窓の外 = 新しい支払い', 30 * MIN + SEC, 'proceed'],
  ])('取り込みからの経過 (chain の時計) が %s', async (_name, sinceInclusion, expected) => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 20 * MIN });
    chain.latestMs = T0 + 20 * MIN + sinceInclusion;
    const at = T0 + 55 * MIN;
    walletSigns(NEW, { block: 200n, ms: at });

    const res = await press(at);

    if (expected === 'recover') {
      expect(res.txHash).toBe(OLD.txHash);
      expect(signatureRequests()).toBe(0);
    } else {
      expect(res.txHash).toBe(NEW.txHash);
      expect(signatureRequests()).toBe(2);
    }
  });

  it('取り込みからの経過は chain の時計で測る: 端末の時計が 6 日進んでいても、chain で 5 分前の取り込みなら復旧する', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 40 * MIN });
    chain.latestMs = T0 + 45 * MIN;
    // 端末の時計だけが 6 日進んでいる (7 日の掃除の線よりは前)。
    const at = T0 + 6 * 24 * 60 * MIN;
    walletSigns(NEW, { block: 200n, ms: at });

    const res = await press(at);

    expect(res.txHash).toBe(OLD.txHash);
    expect(signatureRequests()).toBe(0);
    // block は「取り込まれた block」→「最新」の順に 2 回読む。
    expect(mockGetBlock.mock.calls.map((c) => c[0])).toEqual([
      { blockNumber: 100n },
      { blockTag: 'latest' },
    ]);
  });

  it('最新の block の時刻が取り込みより前 (古い node が答えた) → 窓の内の側 = 復旧 (進まない)', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: AT - 10 * SEC });
    chain.latestMs = AT - 60 * MIN;
    walletSigns(NEW, { block: 200n, ms: AT });

    const res = await press(AT);

    expect(res.txHash).toBe(OLD.txHash);
    expect(signatureRequests()).toBe(0);
  });

  it('revert で取り込まれた古い op (success: false) も、終わった op として新しい支払いへ進む', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC, success: false });
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });

    const res = await press(AT);

    expect(res).toMatchObject({ txHash: NEW.txHash, success: true });
    expect(signatureRequests()).toBe(2);
  });

  it('順は nonce が先: 使用済みと分かってから receipt を照会する', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });

    await press(AT);

    expect(mockRead.mock.invocationCallOrder[0]).toBeLessThan(mockLookup.mock.invocationCallOrder[0]);
    expect(lookedUpHashes()[0]).toBe(OLD.userOpHash);
  });

  it('進んだ後に署名を取り消して押し直す → 前の結果を返さない (もう一度照合して、署名から)', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    chain.latestMs = AT;
    mockPermit.mockRejectedValueOnce(new Error('User rejected the request.'));

    await expect(press(AT)).rejects.toThrow('User rejected the request.');
    expect(stored('tab-2')?.status).toBe('abandoned');
    expect(sentOps()).toEqual([]);

    // hook は対応を消すので、次の押下は新しい key。
    walletSigns(NEW2, { block: 201n, ms: AT + MIN });
    chain.latestMs = AT + MIN;
    const res = await press(AT + MIN, { paymentAttemptId: 'tab-2b' });

    expect(res.txHash).toBe(NEW2.txHash);
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(sentOps()).toEqual([NEW2.signedUserOp]);
    expect(stored('tab-1')?.status).toBe('submitting');
  });
});

describe('H-Z: 窓の外・nonce が未使用 → 今までどおり同じ op を復旧する (新しい op を作らない)', () => {
  const AT = T0 + 45 * MIN;

  it('receipt を照会せず (nonce が先)、復旧の待ちで取れた receipt の結果を返す。新しい署名なし', async () => {
    seed('submitting');
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });
    // 押した時点では未使用。復旧の待ちの間に取り込まれる。
    mockWait.mockImplementationOnce(async ({ hash }) => {
      include(OLD, { block: 300n, ms: AT + 5 * SEC });
      return chain.receipts.get(hash) as never;
    });

    const res = await press(AT);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(nonceReads()).toHaveLength(1);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(signatureRequests()).toBe(0);
    expect(sentOps()).toEqual([]);
    expect(stored('tab-1')?.status).toBe('confirmed');
    expect(stored('tab-2')).toBeUndefined();
    expect(staleWarnings()).toEqual([]);
  });

  it('待ちが timeout → 今までどおり同じ op を送り直して待つ (新しい op は作らない)', async () => {
    seed('submitting');
    chain.latestMs = AT;
    mockBroadcast.mockImplementation(async ({ signedUserOp }) => {
      if (!isOp(signedUserOp, OLD)) throw new Error('test: 知らない op が送られた');
      include(OLD, { block: 300n, ms: AT + 130 * SEC });
      return OLD.userOpHash;
    });

    const res = await press(AT);

    expect(res.txHash).toBe(OLD.txHash);
    expect(sentOps()).toEqual([OLD.signedUserOp]);
    expect(waitedHashes()).toEqual([OLD.userOpHash, OLD.userOpHash]);
    expect(signatureRequests()).toBe(0);
  });

  it('古い記録が 2 件 (使用済みで取り込みが古い・未使用) → 未使用の方を復旧する (新しい署名なし)', async () => {
    seed('submitting', { attemptId: 'tab-1', o: OLD });
    seed('submitting', { attemptId: 'tab-1b', o: OLD2, handedOffAt: T0 + SEC });
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    chain.latestMs = AT;
    mockWait.mockImplementation(async ({ hash }) => {
      if (hash !== OLD2.userOpHash) throw new Error(`test: 待つはずのない hash ${hash}`);
      include(OLD2, { block: 300n, ms: AT + 5 * SEC });
      return chain.receipts.get(hash) as never;
    });

    const res = await press(AT);

    expect(res).toMatchObject({ userOpHash: OLD2.userOpHash, txHash: OLD2.txHash });
    expect(nonceReads().map((r) => r.args[1]).sort()).toEqual([OLD.nonceKey, OLD2.nonceKey].sort());
    expect(signatureRequests()).toBe(0);
    expect(stored('tab-1')?.status).toBe('submitting');
    expect(stored('tab-1b')?.status).toBe('confirmed');
  });
});

describe('H-Z: M1 — 未使用と確かめて復旧 → 確認待ち → その後に取り込まれた op', () => {
  const P1 = T0 + 45 * MIN;

  // 1 回目の押下: 窓の外・未使用 → 復旧の待ちが失敗 (bundler の 5xx) → 確認待ち。時刻は書かない。
  async function firstPressEndsPending() {
    seed('submitting');
    chain.latestMs = P1;
    mockWait.mockRejectedValueOnce(rpcDown());
    const before = rawRecord('tab-1');
    await expect(press(P1)).rejects.toBeInstanceOf(CirclePendingError);
    expect(rawRecord('tab-1')).toBe(before);
    expect(stored('tab-2')).toBeUndefined();
    expect(signatureRequests()).toBe(0);
    expect(sentOps()).toEqual([]);
    // その直後に、古い op が取り込まれる。
    include(OLD, { block: 300n, ms: P1 + 5 * SEC });
    mockRead.mockClear();
  }

  it('すぐ押し直す (10 秒後) → 「窓の外・使用済み」だが取り込みは 5 秒前 → 新しい署名なし・前の結果 (2 本目を払わない)', async () => {
    await firstPressEndsPending();
    chain.latestMs = P1 + 10 * SEC;
    walletSigns(NEW, { block: 400n, ms: P1 + 10 * SEC });

    const res = await press(P1 + 10 * SEC);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash, success: true });
    expect(nonceReads()).toHaveLength(1);
    expect(lookedUpHashes()).toEqual([OLD.userOpHash]);
    expect(signatureRequests()).toBe(0);
    expect(sentOps()).toEqual([]);
    expect(stored('tab-1')?.status).toBe('confirmed');
  });

  it('取り込みから 30 分を過ぎた後に押す → 新しい支払い (署名から)', async () => {
    await firstPressEndsPending();
    const at = P1 + 5 * SEC + 30 * MIN + SEC;
    chain.latestMs = at;
    walletSigns(NEW, { block: 400n, ms: at });

    const res = await press(at);

    expect(res.txHash).toBe(NEW.txHash);
    expect(signatureRequests()).toBe(2);
    expect(sentOps()).toEqual([NEW.signedUserOp]);
    expect(stored('tab-1')?.status).toBe('submitting');
  });
});

describe('H-Z: 照合の失敗 → すぐ確認待ち (待たない・送り直さない・進まない)', () => {
  const AT = T0 + 31 * MIN;

  async function expectPendingWithoutEffects() {
    const before = rawRecord('tab-1');
    walletSigns(NEW, { block: 200n, ms: AT });
    const error = await press(AT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CirclePendingError);
    expect((error as CirclePendingError).userOpHash).toBe(OLD.userOpHash);
    expect(mockWait).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(signatureRequests()).toBe(0);
    // 古い記録はそのまま・自分の記録は作らない。
    expect(rawRecord('tab-1')).toBe(before);
    expect(stored('tab-2')).toBeUndefined();
  }

  it('nonce の読み取りが失敗 (RPC の 5xx)', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    mockRead.mockRejectedValue(rpcDown());

    await expectPendingWithoutEffects();

    expect(mockLookup).not.toHaveBeenCalled();
    expect(warned('circle.stale_submitting.unverified')).toEqual([
      expect.objectContaining({ userOpHash: OLD.userOpHash, sinceHandoffMs: 31 * MIN, step: 'nonce' }),
    ]);
  });

  it('使用済みで、receipt の照会が「まだ無い」以外で失敗 (bundler の 5xx)', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    mockLookup.mockRejectedValue(rpcDown());

    await expectPendingWithoutEffects();

    expect(warned('circle.stale_submitting.unverified')).toEqual([
      expect.objectContaining({ step: 'receipt' }),
    ]);
  });

  it.each([
    ['取り込まれた block', 0],
    ['最新の block', 1],
  ])('使用済みで receipt もあるが、%s を読めない', async (_name, failingCall) => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    chain.latestMs = AT;
    const answer = mockGetBlock.getMockImplementation()!;
    let call = 0;
    mockGetBlock.mockImplementation(async (params) => {
      if (call++ === failingCall) throw rpcDown();
      return answer(params);
    });

    await expectPendingWithoutEffects();

    expect(warned('circle.stale_submitting.unverified')).toEqual([
      expect.objectContaining({ step: 'block' }),
    ]);
  });

  it('chain を読む client が bundle に無い', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    const before = rawRecord('tab-1');

    await expect(press(AT, { bundle: bundleWith({}) })).rejects.toBeInstanceOf(CirclePendingError);

    expect(mockWait).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(signatureRequests()).toBe(0);
    expect(rawRecord('tab-1')).toBe(before);
  });

  it('確認待ちの後、RPC が戻ってから押すと照合し直す (使用済み・古い取り込み → 新しい支払い)', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    chain.latestMs = AT;
    mockRead.mockRejectedValueOnce(rpcDown());
    await expect(press(AT)).rejects.toBeInstanceOf(CirclePendingError);

    walletSigns(NEW, { block: 200n, ms: AT + 10 * SEC });
    chain.latestMs = AT + 10 * SEC;
    const res = await press(AT + 10 * SEC);

    expect(res.txHash).toBe(NEW.txHash);
  });
});

describe('H-Z: 記録の中身が合わない → 照合の失敗 (chain を読まない・進まない)', () => {
  const AT = T0 + 31 * MIN;

  it.each([
    ['署名済みの op の sender が記録の sender でない', { sender: OTHER_ACCOUNT }],
    ['署名済みの op の sender が文字列でない', { sender: 123 }],
    ['nonce が 0x で始まらない', { nonce: '12' }],
    ['nonce が 0x だけ', { nonce: '0x' }],
    ['nonce に 16 進でない字がある', { nonce: '0x12zz' }],
    ['nonce が数値', { nonce: 12 }],
    ['nonce が無い', { nonce: undefined }],
  ])('%s → 確認待ち', async (_name, patch) => {
    seed('submitting');
    // 崩れていなければ「使用済み・古い取り込み」で新しい支払いへ進む状態にしておく。
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    chain.consumed.add(0n);
    chain.latestMs = AT;
    rewrite('tab-1', { signedUserOp: { ...OLD.signedUserOp, ...patch } });
    walletSigns(NEW, { block: 200n, ms: AT });
    const before = rawRecord('tab-1');

    const error = await press(AT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CirclePendingError);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockWait).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(signatureRequests()).toBe(0);
    expect(rawRecord('tab-1')).toBe(before);
    expect(warned('circle.stale_submitting.unverified')).toEqual([
      expect.objectContaining({ userOpHash: OLD.userOpHash, step: 'record' }),
    ]);
  });

  it('sender の大文字・小文字の違いは同じ account (記録は小文字・op は checksum の形)', async () => {
    seed('submitting');
    expect(stored('tab-1')!.sender).toBe(OWNER.toLowerCase());
    expect((stored('tab-1')!.signedUserOp as { sender: string }).sender).toBe(OWNER);
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });

    const res = await press(AT);

    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(res.txHash).toBe(NEW.txHash);
  });
});

describe('H-Z: 照合の結果は、scan がその記録に着いたときに使う', () => {
  const AT = T0 + 31 * MIN;

  it('直近の confirmed と、照合に失敗する古い submitting → confirmed の結果が勝つ (chain は読まない)', async () => {
    seed('submitting', { attemptId: 'tab-1', o: OLD });
    seed('confirmed', {
      attemptId: 'tab-3',
      o: OLD2,
      createdAt: AT - 2 * MIN,
      handedOffAt: AT - 40 * SEC,
      confirmedAt: AT - 30 * SEC,
    });
    include(OLD2, { block: 150n, ms: AT - 30 * SEC });
    mockRead.mockRejectedValue(rpcDown());

    const res = await press(AT);

    expect(res).toMatchObject({ userOpHash: OLD2.userOpHash, txHash: OLD2.txHash });
    expect(mockRead).not.toHaveBeenCalled();
    expect(signatureRequests()).toBe(0);
    expect(mockWait).not.toHaveBeenCalled();
  });

  it('照合を待つ間に別のタブがその記録を confirmed にし、照合は失敗 → 確認待ちにせず、既払いの結果を返す', async () => {
    seed('submitting');
    include(OLD, { block: 100n, ms: AT - SEC });
    mockRead.mockImplementation(async () => {
      markConfirmed({
        key: keyOf('tab-1'),
        sender: OWNER,
        txHash: OLD.txHash,
        success: true,
        now: AT,
        userOpHash: OLD.userOpHash,
      });
      throw rpcDown();
    });

    const res = await press(AT);

    expect(res).toMatchObject({ userOpHash: OLD.userOpHash, txHash: OLD.txHash });
    expect(signatureRequests()).toBe(0);
    expect(mockWait).not.toHaveBeenCalled();
  });

  it('照合を待つ間に別のタブが同じ op を送り直した (時刻が今になった) → 古い照合の結果を当てず、今までどおり復旧する', async () => {
    seed('submitting');
    chain.consumed.add(OLD.nonceKey); // 照合の結果は「使用済み・receipt なし」= 進む側
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });
    const answer = mockRead.getMockImplementation()!;
    mockRead.mockImplementation(async (params) => {
      markResending({ key: keyOf('tab-1'), sender: OWNER, userOpHash: OLD.userOpHash, now: AT });
      return answer(params);
    });
    mockWait.mockImplementationOnce(async ({ hash }) => {
      include(OLD, { block: 300n, ms: AT });
      return chain.receipts.get(hash) as never;
    });

    const res = await press(AT);

    expect(res.txHash).toBe(OLD.txHash);
    expect(waitedHashes()).toEqual([OLD.userOpHash]);
    expect(signatureRequests()).toBe(0);
    expect(sentOps()).toEqual([]);
  });

  it('使用済みの古い記録と、直近の pre-submit (別のタブが署名中) → 確認待ち (並行して送らない)', async () => {
    seed('submitting', { attemptId: 'tab-1', o: OLD });
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    seed('signed', { attemptId: 'tab-3', o: OLD2, createdAt: AT - MIN, handedOffAt: AT - 10 * SEC });
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });

    const error = await press(AT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CirclePendingError);
    expect((error as CirclePendingError).userOpHash).toBe(OLD2.userOpHash);
    expect(signatureRequests()).toBe(0);
    expect(sentOps()).toEqual([]);
  });

  // confirmed の 90 秒の線を、照合を飛ばす判断 (時刻を 1 回読む) と scan の判断 (もう 1 回読む) がまたぐ場合。時計は呼ぶたびに
  // 1 ms 進める。
  it('直近の confirmed で照合を飛ばした直後に、その confirmed が 90 秒の線を越えた → 照合していない古い記録は復旧しない (確認待ち)', async () => {
    seed('submitting', { attemptId: 'tab-1', o: OLD });
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    const start = T0 + 31 * MIN;
    // executeCirclePayment は、照合の判断の前に掃除で now() を 3 回読む (start, +1, +2)。照合の判断は start + 3・scan は start + 4。
    seed('confirmed', {
      attemptId: 'tab-3',
      o: OLD2,
      createdAt: start - 5 * MIN,
      handedOffAt: start - 2 * MIN,
      confirmedAt: start + 3 - 90 * SEC,
    });
    let clock = start;
    walletSigns(NEW, { block: 200n, ms: start });

    const error = await press(start, { now: () => clock++ }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CirclePendingError);
    expect((error as CirclePendingError).userOpHash).toBe(OLD.userOpHash);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockWait).not.toHaveBeenCalled();
    expect(signatureRequests()).toBe(0);
  });
});

describe('H-Z: 失効 (照合を待つ間に画面を離れた)', () => {
  it('照合の後は何も始めない: payment_cancelled・自分の記録を作らない・ほかの記録を abandon しない・署名を求めない', async () => {
    const AT = T0 + 31 * MIN;
    seed('submitting', { attemptId: 'tab-1', o: OLD });
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    // 3 分より古い pre-submit (scan が abandon する相手)。
    seed('signed', { attemptId: 'tab-3', o: OLD2, createdAt: T0, handedOffAt: T0 + MIN });
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });
    let alive = true;
    const answer = mockRead.getMockImplementation()!;
    mockRead.mockImplementation(async (params) => {
      alive = false; // RPC を待つ間に unmount
      return answer(params);
    });

    await expect(press(AT, { isAlive: () => alive })).rejects.toThrow('payment_cancelled');

    expect(stored('tab-2')).toBeUndefined();
    expect(stored('tab-3')?.status).toBe('signed');
    expect(stored('tab-1')?.status).toBe('submitting');
    expect(signatureRequests()).toBe(0);
    expect(sentOps()).toEqual([]);
  });
});

describe('H-Z: 最初の送信の検証拒否で閉じた記録 (failed) は scan の対象外', () => {
  it('failed の古い記録は読まない: chain も bundler も照会せず、新しい支払いへ進む', async () => {
    const AT = T0 + 31 * MIN;
    const key = seed('submitting');
    // 本物の markRejected で閉じる (署名済みの op は記録から消える)。
    markRejected({
      key,
      sender: OWNER,
      userOpHash: OLD.userOpHash,
      submittedAt: T0,
      errorMessage: 'bundler rejected (code -32500): AA21',
      now: T0 + SEC,
    });
    expect(stored('tab-1')?.status).toBe('failed');
    const before = rawRecord('tab-1');
    chain.latestMs = AT;
    walletSigns(NEW, { block: 200n, ms: AT });

    const res = await press(AT);

    expect(res.txHash).toBe(NEW.txHash);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(staleWarnings()).toEqual([]);
    expect(signatureRequests()).toBe(2);
    expect(rawRecord('tab-1')).toBe(before);
  });
});

describe('H-Z: 本物の viem の client (transport だけ偽物) で、RPC に出る中身を確かめる', () => {
  const GET_NONCE_ABI = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']);

  it('eth_call は EntryPoint 0.8 の getNonce(sender, key)・block は取り込まれた番号と latest', async () => {
    const AT = T0 + 31 * MIN;
    seed('submitting');
    include(OLD, { block: 100n, ms: T0 + 12 * SEC });
    walletSigns(NEW, { block: 200n, ms: AT });
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = createPublicClient({
      transport: custom(
        {
          request: async ({ method, params }: { method: string; params: unknown }) => {
            requests.push({ method, params });
            if (method === 'eth_call') {
              return encodeAbiParameters([{ type: 'uint256' }], [OLD.nonce + 1n]);
            }
            if (method === 'eth_getBlockByNumber') {
              const [tag] = params as [string, boolean];
              const ms = tag === 'latest' ? AT : T0 + 12 * SEC;
              return {
                number: tag === 'latest' ? numberToHex(999n) : tag,
                hash: '0x' + '00'.repeat(32),
                timestamp: numberToHex(Math.floor(ms / SEC)),
                transactions: [],
              };
            }
            throw new Error(`test: 知らない method ${method}`);
          },
        },
        { retryCount: 0 },
      ),
    });

    const res = await press(AT, { bundle: bundleWith({ client }) });

    expect(res.txHash).toBe(NEW.txHash);
    const calls = requests.filter((r) => r.method === 'eth_call');
    expect(calls).toHaveLength(1);
    const [tx] = calls[0].params as [{ to: Address; data: Hex }];
    expect(getAddress(tx.to)).toBe(ENTRY_POINT_08);
    expect(tx.data).toBe(
      encodeFunctionData({
        abi: GET_NONCE_ABI,
        functionName: 'getNonce',
        args: [OWNER, OLD.nonceKey],
      }),
    );
    expect(
      requests
        .filter((r) => r.method === 'eth_getBlockByNumber')
        .map((r) => (r.params as [string, boolean])[0]),
    ).toEqual([numberToHex(100n), 'latest']);
  });
});
