// 第 10 回レビュー H-V (money-path): Circle Paymaster の経路 (USDC のガスレス) の「画面を離れた試み」を、hook から本物の
// executeCirclePayment (lib/smartAccount/circleSend.ts) と本物の記録 (lib/circlePending.ts・localStorage / sessionStorage) まで
// 通して確かめる。
//
// 失敗シナリオ (直す前):
//  - 送った後に画面を離れ、その試みが確定する (成功はもう無い画面にしか出ない)。確定した試みが sessionStorage の attemptId の
//    対応を消すので、90 秒より後に開き直して同じ内容を押すと新しい key になり、scan は前の支払いを「正規のリピート」とみなして
//    2 本目を払う。
//  - 署名を待つ間に画面を離れ、開き直した画面が同じ key を resume する。ウォレットに残った古い要求を承認すると、古い試みが
//    自分の op を保存して送る (開き直した画面は払えているのに失敗と出る)。
//
// 直した後: 失効した試み (unmount した hook の instance) は新しい効果を始めず、attemptId の対応を作らない・消さない。
//
// mock は境界だけ: useSmartAccount・wagmi・logger・receipt の監査 (RPC)・circleAccount (= ウォレットの署名と bundler / RPC)。
// circleAccount の偽物は、RPC に当たる await の後に本物と同じ位置で args.beforeSign を呼び、署名の要求を 1 つずつ積む
// (本物の位置は tests/lib/smartAccount/circleAccount.test.ts が固定する)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAddress, type Address, type Hex } from 'viem';
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
vi.mock('@/lib/smartAccount/circleAccount', () => ({
  signUsdcPermit: vi.fn(),
  prepareAndSignCircleUserOp: vi.fn(),
  broadcastCircleUserOp: vi.fn(),
  waitForCircleReceipt: vi.fn(),
  getCircleUserOpGasPrice: vi.fn(),
  entryPoint08Address: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
}));
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

// 試みごとに別の op・hash・tx (この経路の nonce の key は時刻由来で、別の試みの op は別物になる)。
function op(byte: string) {
  return {
    signedUserOp: { sender: CUSTOMER, nonce: `0x${byte}`, signature: '0x' + byte.repeat(65) },
    userOpHash: ('0x' + byte.repeat(32)) as Hex,
    txHash: ('0x' + byte.repeat(31) + 'ff') as Hex,
  };
}
const OP_A = op('a1');
const OP_B = op('b2');
const ALL_OPS = [OP_A, OP_B];

// ウォレットに出ている署名の要求 (出た順)。
let permitRequests: Array<SignRequest<PermitResult>>;
let userOpRequests: Array<SignRequest<UserOpResult>>;
// hash ごとの receipt の待ち (置いた hash は、resolve するまで確定しない)。
let receiptGates: Map<Hex, Promise<void>>;
// 時計。本物の時刻に足す (executeCirclePayment は Date.now を読む)。
let clockOffset: number;

const sentOps = () =>
  vi.mocked(broadcastCircleUserOp).mock.calls.map((c) => c[0].signedUserOp);

// sessionStorage の attemptId の対応 (key → attemptId)。
function mappings(): Record<string, string | null> {
  return Object.fromEntries(
    Array.from({ length: window.sessionStorage.length }, (_, i) => {
      const key = window.sessionStorage.key(i)!;
      return [key, window.sessionStorage.getItem(key)];
    }),
  );
}

// localStorage の Circle の記録 (status の一覧)。
function recordStatuses(): string[] {
  return Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!)
    .filter((key) => key.startsWith(PENDING_KEY_PREFIX))
    .map((key) => (JSON.parse(window.localStorage.getItem(key)!) as { status: string }).status);
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
  const state = () => qc.getMutationCache().getAll()[0].state;
  return { ...view, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  permitRequests = [];
  userOpRequests = [];
  receiptGates = new Map();
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);

  mockHook(useSmartAccount, {
    data: {
      provider: 'circle',
      entryPointVersion: '0.8',
      chainId: baseSepolia.id,
      paymasterAddress: PAYMASTER,
      account: {},
      bundlerClient: {},
      deployment: usdcDep,
    },
    isLoading: false,
    error: null,
  });
  mockHook(useAccount, { chainId: baseSepolia.id, address: CUSTOMER });
  vi.mocked(useWalletClient).mockReturnValue({ data: { _wallet: true } } as never);
  vi.mocked(usePublicClient).mockReturnValue({ _public: true } as never);

  // 平常のガス価格 (Base Sepolia の上限 1000 gwei を下回る)。
  vi.mocked(getCircleUserOpGasPrice).mockResolvedValue({
    maxFeePerGas: 5n * GWEI,
    maxPriorityFeePerGas: 1n,
  });
  vi.mocked(signUsdcPermit).mockImplementation(async (args) => {
    await Promise.resolve(); // permit の domain・nonce の読み取りに当たる
    args.beforeSign?.();
    const d = deferred<PermitResult>();
    permitRequests.push({ approve: d.resolve, reject: d.reject });
    return d.promise;
  });
  vi.mocked(prepareAndSignCircleUserOp).mockImplementation(async (args) => {
    await Promise.resolve(); // ガス価格・prepareUserOperation に当たる
    args.beforeSign?.();
    const d = deferred<UserOpResult>();
    userOpRequests.push({ approve: d.resolve, reject: d.reject });
    return d.promise;
  });
  vi.mocked(broadcastCircleUserOp).mockImplementation(async ({ signedUserOp }) => {
    const found = ALL_OPS.find((o) => o.signedUserOp === signedUserOp);
    if (!found) throw new Error('test: 知らない op が送られた');
    return found.userOpHash;
  });
  vi.mocked(waitForCircleReceipt).mockImplementation(async ({ hash }) => {
    const found = ALL_OPS.find((o) => o.userOpHash === hash);
    if (!found) throw new Error(`test: 知らない hash の receipt を待った ${hash}`);
    await receiptGates.get(hash);
    return {
      receipt: { transactionHash: found.txHash, blockNumber: 10n },
      success: true,
      actualGasCost: 1000n,
    } as never;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('H-V: 画面を離れた Circle の試み (hook → 本物の executeCirclePayment)', () => {
  it('送った後に画面を離れ、その試みが確定した後、90 秒より後に開き直して押す → 2 本目を送らず、既払いの結果を受け取る', async () => {
    const receiptA = deferred<void>();
    receiptGates.set(OP_A.userOpHash, receiptA.promise);

    const screenA = openScreen();
    screenA.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(sentOps()).toEqual([OP_A.signedUserOp]));

    // 送った後に画面を離れる。op はその後に確定し、成功は、もう無い画面にしか出ない。
    screenA.unmount();
    receiptA.resolve();
    await waitFor(() => expect(screenA.state().status).toBe('success'));
    expect(recordStatuses()).toEqual(['confirmed']);
    // 失効した試みは、成功しても attemptId の対応を消さない。
    expect(Object.keys(mappings())).toHaveLength(1);

    // confirmed の dedup の窓 (90 秒) を過ぎてから、開き直した画面で同じ内容を押す。
    clockOffset += 100_000;
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() =>
      expect(screenB.result.current.isSuccess || permitRequests.length > 1).toBe(true),
    );

    // 新しい署名を求めず・2 本目を送らず、前の支払いの結果を受け取る。
    expect(permitRequests).toHaveLength(1);
    expect(userOpRequests).toHaveLength(1);
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
      success: true,
    });
    expect(recordStatuses()).toEqual(['confirmed']);
    // 画面のある試みが受け取ったので、対応はここで消える (その次の押下は新しい支払い)。
    expect(mappings()).toEqual({});
  });

  it('署名 2 を待つ間に画面を離れ、開き直した画面が同じ key を resume する → 古い要求を承認しても送られず、対応も残る', async () => {
    const screenA = openScreen();
    screenA.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    const mappingOfA = mappings();
    expect(Object.keys(mappingOfA)).toHaveLength(1);

    // 画面を離れ、開き直した画面で同じ内容を押す (同じ attemptId = 同じ key の記録を resume する)。
    screenA.unmount();
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(2));
    permitRequests[1].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(2));
    expect(recordStatuses()).toEqual(['awaiting_signature']);

    // ウォレットに残った古い要求 (A) を承認する。
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(screenA.state().status).toBe('error'));
    expect(screenA.state().error?.message).toBe('payment_cancelled');
    expect(sentOps()).toEqual([]);
    expect(recordStatuses()).toEqual(['awaiting_signature']);
    // A の終わり (payment_cancelled) が、B の使っている対応を消していない。
    expect(mappings()).toEqual(mappingOfA);
    expect(screenB.result.current.isPending).toBe(true);

    // B の要求を承認する。B が自分の op を 1 本だけ送って成功し、画面のある試みなので対応を消す。
    userOpRequests[1].approve(OP_B);
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));
    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_B.userOpHash,
      txHash: OP_B.txHash,
      success: true,
    });
    expect(sentOps()).toEqual([OP_B.signedUserOp]);
    expect(recordStatuses()).toEqual(['confirmed']);
    expect(mappings()).toEqual({});
  });

  it('ガス価格を待つ間に画面を離れる → 対応も記録も作らず、署名も求めない', async () => {
    const gas = deferred<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>();
    vi.mocked(getCircleUserOpGasPrice).mockReturnValueOnce(gas.promise);

    const screen = openScreen();
    screen.result.current.mutate(PARAMS);
    // 動的 import を過ぎ、ガス価格を待っている (mutationFn の先頭の確認は通っている)。
    await waitFor(() => expect(getCircleUserOpGasPrice).toHaveBeenCalledOnce());

    screen.unmount();
    gas.resolve({ maxFeePerGas: 5n * GWEI, maxPriorityFeePerGas: 1n });
    await waitFor(() => expect(screen.state().status).toBe('error'));

    expect(screen.state().error?.message).toBe('payment_cancelled');
    expect(mappings()).toEqual({});
    expect(recordStatuses()).toEqual([]);
    expect(signUsdcPermit).not.toHaveBeenCalled();
    expect(permitRequests).toHaveLength(0);
  });
});
