// 第 10 回レビュー H-Z (money-path): Circle Paymaster の経路 (USDC のガスレス) の「タブを閉じた支払いの記録」を、hook から本物の
// executeCirclePayment (lib/smartAccount/circleSend.ts) と本物の記録 (lib/circlePending.ts・localStorage / sessionStorage) まで
// 通して確かめる。
//
// 失敗シナリオ (直す前): 送った後・成功を出す前にタブを閉じる (記録は submitting のまま・sessionStorage の対応はタブと一緒に
// 消える)。その支払いが成立した後、別のタブで同じ内容を押すと、署名を 1 回も求めずに前の支払いの tx で成功が出る。
//
// 直した後: 最後に渡してから 30 分より後は、EntryPoint の nonce と取り込まれた時刻を確かめ、前の支払いが 30 分より前に成立して
// いれば新しい支払い (署名から) になる。
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
import { PENDING_KEY_PREFIX } from '@/lib/circlePending';
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

const ENTRY_POINT_08 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const usdcDep = defaultDeploymentForSymbol('usdc');
const TOKEN: Address = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const MERCHANT: Address = getAddress('0x1111111111111111111111111111111111111111');
const FEE_RECV: Address = getAddress('0x2222222222222222222222222222222222222222');
const CUSTOMER: Address = getAddress('0x3333333333333333333333333333333333333333');
const PAYMASTER: Address = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966');
const GWEI = 10n ** 9n;
const SEC = 1_000;
const MIN = 60 * SEC;

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
const OP_A = op('a1', 1_700_000_000_001);
const OP_B = op('b2', 1_700_000_000_002);
const ALL_OPS = [OP_A, OP_B];

// ウォレットに出ている署名の要求 (出た順)。
let permitRequests: Array<SignRequest<PermitResult>>;
let userOpRequests: Array<SignRequest<UserOpResult>>;
// chain に取り込まれた op (hash → 取り込まれた block と時刻)。
let landed: Map<Hex, { block: bigint; ms: number }>;
// true の間、bundler の receipt の待ちは失敗する (5xx)。
let bundlerDown: boolean;
// 最初の画面 (閉じるタブ) の receipt の待ちは、最後まで返らない (タブと一緒に消える)。
let hangNextWait: boolean;
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

function recordStatuses(): string[] {
  return Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!)
    .filter((key) => key.startsWith(PENDING_KEY_PREFIX))
    .map((key) => (JSON.parse(window.localStorage.getItem(key)!) as { status: string }).status)
    .sort();
}

function openScreen() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return renderHook(() => useBatchPayment(usdcDep), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
}

// 最初のタブで払い、op を bundler に渡した後・成功を出す前にタブを閉じる。記録は submitting のまま残る。
async function payAndCloseTab() {
  hangNextWait = true;
  const screenA = openScreen();
  screenA.result.current.mutate(PARAMS);
  await waitFor(() => expect(permitRequests).toHaveLength(1));
  permitRequests[0].approve(PERMIT);
  await waitFor(() => expect(userOpRequests).toHaveLength(1));
  userOpRequests[0].approve(OP_A);
  await waitFor(() => expect(sentOps()).toEqual([OP_A.signedUserOp]));
  await waitFor(() => expect(waitForCircleReceipt).toHaveBeenCalledTimes(1));
  // タブを閉じる: 画面が消え、sessionStorage (attemptId の対応) も消える。前の待ちは最後まで返らない。
  screenA.unmount();
  window.sessionStorage.clear();
  expect(recordStatuses()).toEqual(['submitting']);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  permitRequests = [];
  userOpRequests = [];
  landed = new Map();
  bundlerDown = false;
  hangNextWait = false;
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
      bundlerClient: {
        getUserOperationReceipt: (async ({ hash }: { hash: Hex }) => {
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
  vi.mocked(waitForCircleReceipt).mockImplementation(async ({ hash }) => {
    if (hangNextWait) {
      hangNextWait = false;
      return new Promise<never>(() => {});
    }
    if (bundlerDown) throw new Error('HTTP request failed. Status: 503');
    const found = ALL_OPS.find((o) => o.userOpHash === hash);
    if (!found) throw new Error(`test: 知らない hash の receipt を待った ${hash}`);
    if (!landed.has(hash)) throw new WaitForUserOperationReceiptTimeoutError({ hash });
    return receiptOf(found) as never;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('H-Z: タブを閉じた Circle の支払いの記録 (hook → 本物の executeCirclePayment)', () => {
  it('筋 1: 前の支払いが成立して 31 分後、別のタブで同じ内容を押す → 署名を求め、新しい支払いの tx で成功する (前の tx を出さない)', async () => {
    await payAndCloseTab();
    land(OP_A, 100n); // 閉じた後に成立した

    clockOffset += 31 * MIN;
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() =>
      expect(screenB.result.current.isSuccess || permitRequests.length > 1).toBe(true),
    );

    // 前の結果をそのまま成功にしない: ウォレットに署名を求める。
    expect(screenB.result.current.isSuccess).toBe(false);
    expect(permitRequests).toHaveLength(2);
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract.mock.calls[0][0]).toMatchObject({
      address: ENTRY_POINT_08,
      functionName: 'getNonce',
      args: [CUSTOMER.toLowerCase(), OP_A.nonceKey],
    });

    permitRequests[1].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(2));
    land(OP_B, 200n);
    userOpRequests[1].approve(OP_B);
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));

    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_B.userOpHash,
      txHash: OP_B.txHash,
      success: true,
    });
    expect(sentOps()).toEqual([OP_A.signedUserOp, OP_B.signedUserOp]);
    // 前の記録は書き換えない (submitting のまま)。
    expect(recordStatuses()).toEqual(['confirmed', 'submitting']);
  });

  it('窓の内 (10 分後) は今までどおり: 署名を求めず、前の支払いの結果を受け取る (chain は読まない)', async () => {
    await payAndCloseTab();
    land(OP_A, 100n);

    clockOffset += 10 * MIN;
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() =>
      expect(screenB.result.current.isSuccess || permitRequests.length > 1).toBe(true),
    );

    expect(permitRequests).toHaveLength(1);
    expect(readContract).not.toHaveBeenCalled();
    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
    });
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(recordStatuses()).toEqual(['confirmed']);
  });

  it('M1: 45 分後に押す (未使用 → 復旧の待ちが失敗 → 確認待ち) → その直後に前の op が成立 → すぐ押し直す → 署名を求めず前の結果 (2 本目を払わない)', async () => {
    await payAndCloseTab();

    clockOffset += 45 * MIN;
    bundlerDown = true;
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(screenB.result.current.isError).toBe(true));
    expect((screenB.result.current.error as Error).name).toBe('CirclePendingError');
    expect(permitRequests).toHaveLength(1);
    expect(recordStatuses()).toEqual(['submitting']);

    // 前の op が成立し、bundler も戻る。
    land(OP_A, 300n);
    bundlerDown = false;
    clockOffset += 10 * SEC;
    screenB.result.current.mutate(PARAMS);
    await waitFor(() =>
      expect(screenB.result.current.isSuccess || permitRequests.length > 1).toBe(true),
    );

    expect(permitRequests).toHaveLength(1);
    expect(userOpRequests).toHaveLength(1);
    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
    });
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(recordStatuses()).toEqual(['confirmed']);
  });
});
