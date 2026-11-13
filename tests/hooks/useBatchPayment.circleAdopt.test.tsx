// 第 10 回レビュー 穴 B (H-V の scan 版・money-path): Circle Paymaster の経路 (USDC のガスレス) で、別のタブの支払いの結果を
// scan で受け取りに行った押下の後始末を、hook から本物の executeCirclePayment (lib/smartAccount/circleSend.ts) と本物の記録
// (lib/circlePending.ts・localStorage / sessionStorage) まで通して確かめる。
//
// 失敗シナリオ (直す前): 別のタブで払った支払い R (送った後・確定の前) がある。このタブで同じ内容を押すと、scan が R を見つけて
// 結果を受け取りに行く (自分の attemptId の記録は作らない)。その途中で画面を離れる (または確認待ちで終わる)。R は裏で確定するが、
// 成功はどの画面にも出ない。このタブの attemptId の対応は、記録の無い attemptId を指したまま残る。R の確定から 90 秒より後に
// 押すと、scan は R を「正規のリピート」とみなし、署名を求めて 2 本目を払う。
//
// 直した後: scan が R の結果を受け取りに行く直前に、このタブの対応を R の attemptId に付け替える。次の押下は R の記録を resume
// して、既払いの結果を受け取る。
//
// mock は境界だけ: useSmartAccount (bundle = bundler と chain の RPC)・wagmi・logger・receipt の監査 (RPC)・circleAccount
// (= ウォレットの署名と bundler への送信・receipt の待ち)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAddress, numberToHex, type Address, type Hex } from 'viem';
import {
  UserOperationReceiptNotFoundError,
  WaitForUserOperationReceiptTimeoutError,
} from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import type { ReactNode } from 'react';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import {
  ATTEMPT_KEY_PREFIX,
  PENDING_KEY_PREFIX,
  markRejected,
  type PendingRecord,
} from '@/lib/circlePending';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

vi.mock('@/hooks/useSmartAccount', () => ({
  useSmartAccount: vi.fn(),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useWalletClient: vi.fn(() => ({ data: undefined })),
  usePublicClient: vi.fn(() => undefined),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/smartAccount/circleAccount', () => {
  const broadcastCircleUserOp = vi.fn();
  return {
    signUsdcPermit: vi.fn(),
    prepareAndSignCircleUserOp: vi.fn(),
    broadcastCircleUserOp,
    prepareCircleBroadcast:
      (bundle: unknown) =>
      (signedUserOp: unknown) =>
        broadcastCircleUserOp({ bundle, signedUserOp }),
    waitForCircleReceipt: vi.fn(),
    getCircleUserOpGasPrice: vi.fn(),
    entryPoint08Address: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
  };
});
// 成功の後の監査 (receipt の再計算) は best-effort の RPC。結果は支払いの成否に関係しない。
vi.mock('@/lib/circleReceiptVerifier', () => ({
  verifyCircleReceiptOnChain: vi.fn(async () => ({
    status: 'unreconciled',
    reason: 'test-stub',
  })),
}));
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import {
  signUsdcPermit,
  prepareAndSignCircleUserOp,
  broadcastCircleUserOp,
  waitForCircleReceipt,
  getCircleUserOpGasPrice,
} from '@/lib/smartAccount/circleAccount';
import { mockHook } from '../_helpers/wagmiMock';

const usdcDep = defaultDeploymentForSymbol('usdc');
const TOKEN: Address = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const MERCHANT: Address = getAddress('0x1111111111111111111111111111111111111111');
const FEE_RECV: Address = getAddress('0x2222222222222222222222222222222222222222');
const CUSTOMER: Address = getAddress('0x3333333333333333333333333333333333333333');
const PAYMASTER: Address = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966');
const GWEI = 10n ** 9n;
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// 99 USDC の支払い。paymentAttemptId を渡さない = 本番の 3 フォームと同じく sessionStorage の対応を使う。
const PARAMS = {
  tokenAddress: TOKEN,
  merchant: MERCHANT,
  merchantAmount: 99_000_000n,
  feeReceiver: FEE_RECV,
  feeAmount: 0n,
  circlePermitAmount: 5_000_000n,
};

type PermitResult = { paymasterData: Hex; permitSignature: Hex };
type UserOpResult = { signedUserOp: Record<string, unknown>; userOpHash: Hex };
type SignRequest<T> = { approve: (value: T) => void; reject: (error: Error) => void };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PERMIT: PermitResult = {
  paymasterData: '0xpm' as Hex,
  permitSignature: `0x${'cd'.repeat(65)}` as Hex,
};

// 試みごとに別の op。nonce は本番と同じ形 (上位 192 bit = 時刻由来の key・下位 64 bit = seq 0)。
function op(byte: string, nonceMs: number) {
  const nonce = BigInt(nonceMs) << 64n;
  return {
    nonceKey: nonce >> 64n,
    signedUserOp: { sender: CUSTOMER, nonce: numberToHex(nonce), signature: '0x' + byte.repeat(65) },
    userOpHash: ('0x' + byte.repeat(32)) as Hex,
    txHash: ('0x' + byte.repeat(31) + 'ff') as Hex,
  };
}
type Op = ReturnType<typeof op>;
// R = 別のタブの支払い。
const OP_R = op('a1', 1_700_000_000_001);
// このタブが新しい支払いとして署名した場合の op (2 本目)。
const OP_NEW = op('b2', 1_700_000_000_002);
const ALL_OPS = [OP_R, OP_NEW];

// ウォレットに出ている署名の要求 (出た順)。
let permitRequests: Array<SignRequest<PermitResult>>;
let userOpRequests: Array<SignRequest<UserOpResult>>;
// chain に取り込まれた op (hash → 取り込まれた block と時刻)。
let landed: Map<Hex, { block: bigint; ms: number }>;
// hash ごとの receipt の待ちの門 (置いた hash の待ちは、resolve するまで返らない)。
let waitGates: Map<Hex, Promise<void>>;
// hash ごとの receipt の照会 (1 回・待たない方) の門。
let lookupGates: Map<Hex, Promise<void>>;
let lookups: Hex[];
// true の間、bundler は receipt を返せない (5xx): 待ちも照会も失敗する。
let bundlerDown: boolean;
// 時計。本物の時刻に足す (executeCirclePayment は Date.now を読む)。
let clockOffset: number;
const readContract = vi.fn();
const getBlock = vi.fn();

const sentOps = () =>
  vi.mocked(broadcastCircleUserOp).mock.calls.map((c) => c[0].signedUserOp);

function receiptOf(o: Op) {
  return {
    receipt: { transactionHash: o.txHash, blockNumber: landed.get(o.userOpHash)!.block },
    success: true,
    actualGasCost: 1000n,
  };
}

// op が chain に取り込まれる (いまの時刻の block)。
function land(o: Op, block: bigint) {
  landed.set(o.userOpHash, { block, ms: Date.now() });
}

// localStorage の Circle の記録。
function records(): PendingRecord[] {
  return Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!)
    .filter((key) => key.startsWith(PENDING_KEY_PREFIX))
    .map((key) => JSON.parse(window.localStorage.getItem(key)!) as PendingRecord);
}
const recordStatuses = () => records().map((r) => r.status).sort();
const recordOf = (o: Op) => records().find((r) => r.userOpHash === o.userOpHash)!;

// このタブの attemptId の対応 (sessionStorage) の値。対応は 1 つの内容につき 1 つ。無ければ undefined。
function mappedAttemptId(): string | undefined {
  const keys = Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i)!)
    .filter((key) => key.startsWith(ATTEMPT_KEY_PREFIX));
  expect(keys.length).toBeLessThanOrEqual(1);
  return keys.length === 1 ? window.sessionStorage.getItem(keys[0])! : undefined;
}

// 画面 (hook の instance) を 1 つ開く。unmount の後は result.current を待てないので、mutation の終わり方は MutationCache で
// 見る (react-query の mutation は unmount の後も走り、cache に残る)。
function openScreen() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const view = renderHook(() => useBatchPayment(usdcDep), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  // この画面の押下 (mutation) の一覧 (押した順)。
  const presses = () => qc.getMutationCache().getAll();
  // 最初の押下の状態。
  const state = () => presses()[0].state;
  return { ...view, presses, state };
}
type Screen = ReturnType<typeof openScreen>;

// 押して、その押下の結果が出る (成功・失敗) か、ウォレットに新しい署名の要求が出るまで待つ。前の押下の結果 (isSuccess /
// isError) が画面に残っているので、押下ごとの状態は MutationCache で見て、画面 (result.current) が追いつくのを待つ。
async function pressAndSettle(screen: Screen) {
  const pressesBefore = screen.presses().length;
  const permitsBefore = permitRequests.length;
  screen.result.current.mutate(PARAMS);
  await waitFor(() => {
    expect(screen.presses()).toHaveLength(pressesBefore + 1);
    const { status } = screen.presses()[pressesBefore].state;
    expect(status !== 'pending' || permitRequests.length > permitsBefore).toBe(true);
    expect(screen.result.current.status).toBe(status);
  });
}

// ウォレットの新しい署名 2 回に応じ、op を送って取り込まれるまで進める (= 新しい支払い)。
async function approveNewPayment(screen: Screen, o: Op) {
  permitRequests[permitRequests.length - 1].approve(PERMIT);
  const userOpsBefore = userOpRequests.length;
  await waitFor(() => expect(userOpRequests.length).toBe(userOpsBefore + 1));
  land(o, 900n);
  userOpRequests[userOpRequests.length - 1].approve(o);
  await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
}

// 別のタブ (タブ 1) で払う: op を bundler に渡し、receipt を待っている (記録は submitting)。タブ 1 の sessionStorage は
// このタブからは見えないので、対応を消して「別のタブ」にする。タブ 1 の試みは裏で走り続け、confirmR() で確定する
// (失効した試みは対応に触らない = このタブの対応を横から消さない)。
async function payInOtherTab() {
  const gate = deferred<void>();
  waitGates.set(OP_R.userOpHash, gate.promise);
  const tab1 = openScreen();
  tab1.result.current.mutate(PARAMS);
  await waitFor(() => expect(permitRequests).toHaveLength(1));
  permitRequests[0].approve(PERMIT);
  await waitFor(() => expect(userOpRequests).toHaveLength(1));
  userOpRequests[0].approve(OP_R);
  await waitFor(() => expect(waitForCircleReceipt).toHaveBeenCalledTimes(1));
  expect(sentOps()).toEqual([OP_R.signedUserOp]);
  tab1.unmount();
  window.sessionStorage.clear();
  expect(recordStatuses()).toEqual(['submitting']);
  const rAttemptId = recordOf(OP_R).paymentAttemptId;
  // R が chain に取り込まれ、タブ 1 の試みが記録を confirmed にする。
  const confirmR = async () => {
    land(OP_R, 100n);
    gate.resolve();
    await waitFor(() => expect(tab1.state().status).toBe('success'));
    expect(recordOf(OP_R).status).toBe('confirmed');
  };
  return { rAttemptId, confirmR };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  permitRequests = [];
  userOpRequests = [];
  landed = new Map();
  waitGates = new Map();
  lookupGates = new Map();
  lookups = [];
  bundlerDown = false;
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);

  // chain の RPC。EntryPoint.getNonce(sender, key): 取り込まれた op の key は seq が 1 進んでいる。
  readContract.mockReset();
  readContract.mockImplementation(async (params: { args: readonly [Address, bigint] }) => {
    const nonceKey = params.args[1];
    const used = ALL_OPS.some((o) => o.nonceKey === nonceKey && landed.has(o.userOpHash));
    return (nonceKey << 64n) + (used ? 1n : 0n);
  });
  getBlock.mockReset();
  getBlock.mockImplementation(async (params: { blockNumber?: bigint } = {}) => {
    if (params.blockNumber === undefined) return { timestamp: BigInt(Math.floor(Date.now() / SEC)) };
    const found = [...landed.values()].find((l) => l.block === params.blockNumber);
    if (!found) throw new Error(`test: 知らない block ${params.blockNumber}`);
    return { timestamp: BigInt(Math.floor(found.ms / SEC)) };
  });

  mockHook(useSmartAccount, {
    data: {
      provider: 'circle',
      entryPointVersion: '0.8',
      chainId: baseSepolia.id,
      paymasterAddress: PAYMASTER,
      // account.client = chain の RPC の client (境界)。ここで使う 2 つの action だけの偽物。
      account: { client: { readContract, getBlock } as never },
      // confirmed の記録の結果を返すとき、circleSend は receipt を 1 回だけ照会する (bundler の RPC = 境界)。
      bundlerClient: {
        getUserOperationReceipt: (async ({ hash }: { hash: Hex }) => {
          lookups.push(hash);
          await lookupGates.get(hash);
          if (bundlerDown) throw new Error('HTTP request failed. Status: 503');
          const found = ALL_OPS.find((o) => o.userOpHash === hash);
          if (!found || !landed.has(hash)) throw new UserOperationReceiptNotFoundError({ hash });
          return receiptOf(found);
        }) as never,
      },
      deployment: usdcDep,
    },
    isLoading: false,
    error: null,
  });
  mockHook(useAccount, { chainId: baseSepolia.id, address: CUSTOMER });
  vi.mocked(useWalletClient).mockReturnValue({ data: { _wallet: true } } as never);
  vi.mocked(usePublicClient).mockReturnValue({ _public: true } as never);

  vi.mocked(getCircleUserOpGasPrice).mockResolvedValue({
    maxFeePerGas: 5n * GWEI,
    maxPriorityFeePerGas: 1n,
  });
  vi.mocked(signUsdcPermit).mockImplementation(async (args) => {
    await Promise.resolve();
    args.beforeSign?.();
    const d = deferred<PermitResult>();
    permitRequests.push({ approve: d.resolve, reject: d.reject });
    return d.promise;
  });
  vi.mocked(prepareAndSignCircleUserOp).mockImplementation(async (args) => {
    await Promise.resolve();
    args.beforeSign?.();
    const d = deferred<UserOpResult>();
    userOpRequests.push({ approve: d.resolve, reject: d.reject });
    return d.promise;
  });
  vi.mocked(broadcastCircleUserOp).mockImplementation(async ({ signedUserOp }) => {
    const found = ALL_OPS.find((o) => o.signedUserOp.signature === signedUserOp.signature);
    if (!found) throw new Error('test: 知らない op が送られた');
    return found.userOpHash;
  });
  // receipt の待ち: 5xx なら失敗・門があれば開くまで待つ・取り込まれていれば receipt・無ければ 120 秒の timeout。
  vi.mocked(waitForCircleReceipt).mockImplementation(async ({ hash }) => {
    if (bundlerDown) throw new Error('HTTP request failed. Status: 503');
    const found = ALL_OPS.find((o) => o.userOpHash === hash);
    if (!found) throw new Error(`test: 知らない hash の receipt を待った ${hash}`);
    await waitGates.get(hash);
    if (!landed.has(hash)) throw new WaitForUserOperationReceiptTimeoutError({ hash });
    return receiptOf(found) as never;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 署名を求めず、R の結果を受け取った。
function expectResultOfR(screen: Screen) {
  expect(permitRequests).toHaveLength(1);
  expect(userOpRequests).toHaveLength(1);
  expect(sentOps()).toEqual([OP_R.signedUserOp]);
  expect(screen.result.current.data).toMatchObject({
    userOpHash: OP_R.userOpHash,
    txHash: OP_R.txHash,
    success: true,
  });
}

describe('穴 B: scan で別のタブの支払いの結果を受け取りに行った後 (hook → 本物の executeCirclePayment)', () => {
  it('(a) 別のタブの submitting を復旧中に画面を離れる → その支払いが確定 → 100 秒後に開き直して押す → 署名を求めず、その支払いの結果を受け取り、対応が消える', async () => {
    const { rAttemptId, confirmR } = await payInOtherTab();

    // このタブで同じ内容を押す。scan が R を見つけ、receipt を待つ (自分の記録は作らない)。
    clockOffset += 1 * MIN;
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(waitForCircleReceipt).toHaveBeenCalledTimes(2));
    expect(records()).toHaveLength(1);
    // 待ち始めた時点で、対応は R の attemptId に付け替わっている。
    expect(mappedAttemptId()).toBe(rAttemptId);

    // 待つ間に画面を離れる。R はその後に確定し、成功はどの画面にも出ない。
    screenB.unmount();
    await confirmR();
    await waitFor(() => expect(screenB.state().status).toBe('success'));
    // 失効した試みは対応を消さない。
    expect(mappedAttemptId()).toBe(rAttemptId);

    // confirmed の dedup の窓 (90 秒) を過ぎてから、開き直した画面で同じ内容を押す。
    clockOffset += 100 * SEC;
    const screenC = openScreen();
    await pressAndSettle(screenC);

    expectResultOfR(screenC);
    expect(recordStatuses()).toEqual(['confirmed']);
    // 画面のある試みが受け取ったので、対応はここで消える (その次の押下は新しい支払い)。
    expect(mappedAttemptId()).toBeUndefined();
  });

  it('(b) 別のタブの confirmed (30 秒前) の照会中に画面を離れる → 100 秒後に開き直して押す → 署名を求めず、その支払いの結果', async () => {
    const { rAttemptId, confirmR } = await payInOtherTab();
    await confirmR();

    // 確定の 30 秒後に、このタブで同じ内容を押す。scan は R の結果を返しに行き、receipt を 1 回照会する。
    clockOffset += 30 * SEC;
    const lookupGate = deferred<void>();
    lookupGates.set(OP_R.userOpHash, lookupGate.promise);
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(lookups).toEqual([OP_R.userOpHash]));
    expect(mappedAttemptId()).toBe(rAttemptId);

    // 照会を待つ間に画面を離れる。
    screenB.unmount();
    lookupGate.resolve();
    await waitFor(() => expect(screenB.state().status).toBe('success'));
    expect(mappedAttemptId()).toBe(rAttemptId);

    clockOffset += 100 * SEC;
    const screenC = openScreen();
    await pressAndSettle(screenC);

    expectResultOfR(screenC);
    expect(mappedAttemptId()).toBeUndefined();
  });

  it('確認待ちで終わった後 (画面はそのまま) → 別のタブの支払いが確定 → 100 秒後に押す → 署名を求めず、その支払いの結果', async () => {
    const { rAttemptId, confirmR } = await payInOtherTab();

    // このタブで押す。bundler が receipt を返せず (5xx)、確認待ちで終わる。
    clockOffset += 1 * MIN;
    bundlerDown = true;
    const screenB = openScreen();
    await pressAndSettle(screenB);
    expect((screenB.result.current.error as Error).name).toBe('CirclePendingError');
    expect(permitRequests).toHaveLength(1);
    // 確認待ちは対応を残す。残る中身は R の attemptId。
    expect(mappedAttemptId()).toBe(rAttemptId);

    // bundler が戻り、R が確定する (タブ 1 が記録を confirmed にする)。
    bundlerDown = false;
    await confirmR();

    clockOffset += 100 * SEC;
    await pressAndSettle(screenB);

    expectResultOfR(screenB);
    expect(mappedAttemptId()).toBeUndefined();
  });

  it('画面のある試みが結果を受け取れたら、対応は今までどおり消える → 100 秒後の次の押下は新しい支払い', async () => {
    const { rAttemptId, confirmR } = await payInOtherTab();

    clockOffset += 1 * MIN;
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(waitForCircleReceipt).toHaveBeenCalledTimes(2));
    expect(mappedAttemptId()).toBe(rAttemptId);
    await confirmR();
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));

    expectResultOfR(screenB);
    // R の attemptId は残らない。
    expect(mappedAttemptId()).toBeUndefined();

    // 成功を画面に出した後の、同じ内容の次の支払い (正規のリピート) は、署名から。
    clockOffset += 100 * SEC;
    await pressAndSettle(screenB);
    expect(permitRequests).toHaveLength(2);
    expect(mappedAttemptId()).not.toBe(rAttemptId);
    await approveNewPayment(screenB, OP_NEW);
    expect(screenB.result.current.data).toMatchObject({ userOpHash: OP_NEW.userOpHash });
    expect(sentOps()).toEqual([OP_R.signedUserOp, OP_NEW.signedUserOp]);
  });
});

describe('穴 B: 付け替えた後の次の押下 (R の key の resume)', () => {
  // このタブが R を復旧しに行き、確認待ちで終わった (対応は R の attemptId)。
  async function adoptThenPending() {
    const other = await payInOtherTab();
    clockOffset += 1 * MIN;
    bundlerDown = true;
    const screenB = openScreen();
    await pressAndSettle(screenB);
    expect((screenB.result.current.error as Error).name).toBe('CirclePendingError');
    expect(mappedAttemptId()).toBe(other.rAttemptId);
    bundlerDown = false;
    return { ...other, screenB };
  }

  it('R がまだ submitting (32 分後・タブ 1 は閉じた) → chain を読まずに同じ op を復旧し、結果を受け取る', async () => {
    const { screenB } = await adoptThenPending();
    // タブ 1 の待ちは返らない (タブと一緒に消えた)。R は取り込まれたが、記録は submitting のまま。
    clockOffset += 31 * MIN;
    land(OP_R, 100n);
    waitGates.delete(OP_R.userOpHash);
    expect(recordOf(OP_R).status).toBe('submitting');

    await pressAndSettle(screenB);

    expectResultOfR(screenB);
    // R の key の resume = 別の key の scan ではないので、古い submitting の記録の照合 (EntryPoint の nonce) は通らない。
    expect(readContract).not.toHaveBeenCalled();
    expect(recordStatuses()).toEqual(['confirmed']);
    expect(mappedAttemptId()).toBeUndefined();
  });

  it('R が failed に閉じられていた (タブ 1 の最初の送信の検証拒否) → 「既に終了」で対応が消える → その次の押下は新しい支払い', async () => {
    const { screenB } = await adoptThenPending();
    // タブ 1 が R を閉じた (本物の遷移。閉じる条件の確認は circleSend の closeRejectedFirstSend)。
    const r = recordOf(OP_R);
    markRejected({
      key: r.key,
      sender: CUSTOMER,
      userOpHash: OP_R.userOpHash,
      submittedAt: r.updatedAt,
      errorMessage: 'bundler rejected (code -32500): AA21',
      now: Date.now(),
    });

    clockOffset += 10 * SEC;
    await pressAndSettle(screenB);
    expect(screenB.result.current.isError).toBe(true);
    expect((screenB.result.current.error as Error).message).toContain('この決済試行は既に終了しています');
    expect(permitRequests).toHaveLength(1);
    expect(mappedAttemptId()).toBeUndefined();

    await pressAndSettle(screenB);
    expect(permitRequests).toHaveLength(2);
    await approveNewPayment(screenB, OP_NEW);
    expect(screenB.result.current.data).toMatchObject({ userOpHash: OP_NEW.userOpHash });
    expect(recordStatuses()).toEqual(['confirmed', 'failed']);
  });

  it('R の記録がもう無い (confirmed から 25 時間・24 時間の掃除の後) → 新しい予約 = 新しい支払い (署名から)', async () => {
    const { screenB, confirmR, rAttemptId } = await adoptThenPending();
    await confirmR();

    clockOffset += 25 * HOUR;
    await pressAndSettle(screenB);

    // 前の結果を出さない: 署名を求める。
    expect(screenB.result.current.isSuccess).toBe(false);
    expect(permitRequests).toHaveLength(2);
    await approveNewPayment(screenB, OP_NEW);
    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_NEW.userOpHash,
      txHash: OP_NEW.txHash,
    });
    // R の記録は掃除で消え、新しい記録が同じ attemptId (同じ key) に作られた。
    expect(records()).toHaveLength(1);
    expect(recordOf(OP_NEW)).toMatchObject({ status: 'confirmed', paymentAttemptId: rAttemptId });
    expect(mappedAttemptId()).toBeUndefined();
  });
});

describe('穴 B: 付け替えない場合 (hook → 本物の executeCirclePayment)', () => {
  it('明示の paymentAttemptId で払う → sessionStorage の対応に一切触らない (今までどおり R の結果は受け取る)', async () => {
    const { confirmR } = await payInOtherTab();

    clockOffset += 1 * MIN;
    const screenB = openScreen();
    screenB.result.current.mutate({ ...PARAMS, paymentAttemptId: 'order-42' });
    await waitFor(() => expect(waitForCircleReceipt).toHaveBeenCalledTimes(2));
    expect(window.sessionStorage.length).toBe(0);
    await confirmR();
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));

    expectResultOfR(screenB);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('31 分後 (窓の外・nonce は未使用 → 今までどおり復旧) → 対応は自分の attemptId のまま', async () => {
    const { rAttemptId, confirmR } = await payInOtherTab();

    clockOffset += 31 * MIN;
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(waitForCircleReceipt).toHaveBeenCalledTimes(2));
    expect(readContract).toHaveBeenCalledTimes(1);
    const own = mappedAttemptId();
    expect(own).toBeDefined();
    expect(own).not.toBe(rAttemptId);

    await confirmR();
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));
    expectResultOfR(screenB);
    expect(mappedAttemptId()).toBeUndefined();
  });

  it('別のタブが署名中 (op を渡していない記録) → 確認待ち・対応は自分の attemptId のまま', async () => {
    // タブ 1: 署名 1 の要求が出たまま (記録は awaiting_signature)。
    const tab1 = openScreen();
    tab1.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    tab1.unmount();
    window.sessionStorage.clear();
    expect(recordStatuses()).toEqual(['awaiting_signature']);
    const otherAttemptId = records()[0].paymentAttemptId;

    clockOffset += 1 * MIN;
    const screenB = openScreen();
    await pressAndSettle(screenB);

    expect((screenB.result.current.error as Error).name).toBe('CirclePendingError');
    expect(permitRequests).toHaveLength(1);
    expect(mappedAttemptId()).toBeDefined();
    expect(mappedAttemptId()).not.toBe(otherAttemptId);
  });

  it('sessionStorage に書けない (付け替えの書き込みが投げる) → 今までと同じ動き: R の結果を受け取り、error にならない', async () => {
    const { rAttemptId, confirmR } = await payInOtherTab();
    // R の attemptId への書き込みだけ失敗させる (このタブの対応の作成は通す)。
    const realSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (this === window.sessionStorage && value === rAttemptId) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        realSetItem.call(this, key, value);
      });

    clockOffset += 1 * MIN;
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(waitForCircleReceipt).toHaveBeenCalledTimes(2));
    // 付け替えを試みて失敗した。対応は自分の attemptId のまま。
    expect(setItem.mock.calls.some((c) => c[1] === rAttemptId)).toBe(true);
    const own = mappedAttemptId();
    expect(own).toBeDefined();
    expect(own).not.toBe(rAttemptId);

    await confirmR();
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));
    expectResultOfR(screenB);
    expect(mappedAttemptId()).toBeUndefined();
  });
});
