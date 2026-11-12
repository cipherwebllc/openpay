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
import {
  verifyCircleReceiptOnChain,
  type CircleReconcileResult,
} from '@/lib/circleReceiptVerifier';
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
// true の間、bundler は receipt を返せない (5xx): receipt の待ちも、確定済みの op の receipt の照会も失敗する。
let bundlerDown: boolean;
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
  bundlerDown = false;
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
      // confirmed の記録の結果を返すとき、circleSend は receipt を 1 回だけ照会する (bundler の RPC = 境界)。
      bundlerClient: {
        getUserOperationReceipt: (async ({ hash }: { hash: Hex }) => {
          if (bundlerDown) throw new Error('HTTP request failed. Status: 503');
          const found = ALL_OPS.find((o) => o.userOpHash === hash);
          if (!found) throw new Error(`test: 知らない hash の receipt を照会した ${hash}`);
          return {
            receipt: { transactionHash: found.txHash, blockNumber: 10n },
            success: true,
            actualGasCost: 1000n,
          };
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
    if (bundlerDown) throw new Error('HTTP request failed. Status: 503');
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

  // Codex のレビュー (P2): 確定の後も、mutation が成功を返すまでに receipt の監査 (RPC) の await がある。その間に画面を
  // 離れた試みは、確定していても成功を画面に出せない。監査の前に対応を消していると、上と同じ筋で 2 本目を払う。
  it('確定の後、監査 (receipt の再計算) を待つ間に画面を離れる → 対応が残り、90 秒より後に開き直して押しても 2 本目を送らず、既払いの結果を受け取る', async () => {
    // A の監査だけ止める (B の監査は既定の stub ですぐ返る)。
    const auditA = deferred<CircleReconcileResult>();
    vi.mocked(verifyCircleReceiptOnChain).mockReturnValueOnce(auditA.promise);

    const screenA = openScreen();
    screenA.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    userOpRequests[0].approve(OP_A);
    // A は送って確定し、監査を待っている (画面はまだあり、成功はまだ画面に出ていない)。
    await waitFor(() => expect(verifyCircleReceiptOnChain).toHaveBeenCalledOnce());
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(recordStatuses()).toEqual(['confirmed']);
    expect(screenA.result.current.isPending).toBe(true);

    // 監査を待つ間に画面を離れる。A の成功は誰にも出ない。
    screenA.unmount();
    auditA.resolve({ status: 'unreconciled', reason: 'test-stub', kind: 'event-absent' });
    await waitFor(() => expect(screenA.state().status).toBe('success'));
    const mappingsAfterA = mappings();

    // confirmed の dedup の窓 (90 秒) を過ぎてから、開き直した画面で同じ内容を押す。ウォレットが署名を求めれば、利用者は
    // 承認する (前の支払いが済んだことを知らない)。
    clockOffset += 100_000;
    vi.mocked(signUsdcPermit).mockImplementation(async (args) => {
      await Promise.resolve();
      args.beforeSign?.();
      return PERMIT;
    });
    vi.mocked(prepareAndSignCircleUserOp).mockImplementation(async (args) => {
      await Promise.resolve();
      args.beforeSign?.();
      return OP_B;
    });
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));

    // 送られた op は A の 1 本だけ。B は同じ attemptId を resume し、新しい署名を求めずに既払いの結果を受け取る。
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(signUsdcPermit).toHaveBeenCalledOnce();
    expect(prepareAndSignCircleUserOp).toHaveBeenCalledOnce();
    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
      success: true,
    });
    expect(recordStatuses()).toEqual(['confirmed']);
    // 監査の間に失効した A は対応を残していた。画面のある B が受け取ったので、ここで消える。
    expect(Object.keys(mappingsAfterA)).toHaveLength(1);
    expect(mappings()).toEqual({});
  });

  // 画面がある試みの成功は、監査の結果に関係なく、今までどおり対応を消す (次の同じ内容の押下は新しい支払い)。
  const auditOutcomes: Array<[string, () => Promise<CircleReconcileResult>, string]> = [
    [
      'verified',
      async () => ({ status: 'verified', netUsdc: 10_000n, pulledUsdc: 10_000n, refundedUsdc: 0n }),
      'client-reported',
    ],
    [
      'unreconciled',
      async () => ({ status: 'unreconciled', reason: 'test', kind: 'event-absent' }),
      'unreconciled',
    ],
    [
      '投げた (RPC の失敗)',
      async () => {
        throw new Error('test: receipt の RPC に失敗');
      },
      'unreconciled',
    ],
  ];
  it.each(auditOutcomes)(
    '画面がある試みの成功は、監査が %s でも対応を消す',
    async (_label, audit, verification) => {
      vi.mocked(verifyCircleReceiptOnChain).mockImplementationOnce(audit);

      const screen = openScreen();
      screen.result.current.mutate(PARAMS);
      await waitFor(() => expect(permitRequests).toHaveLength(1));
      permitRequests[0].approve(PERMIT);
      await waitFor(() => expect(userOpRequests).toHaveLength(1));
      expect(Object.keys(mappings())).toHaveLength(1);
      userOpRequests[0].approve(OP_A);
      await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));

      expect(verifyCircleReceiptOnChain).toHaveBeenCalledOnce();
      expect(screen.result.current.data).toMatchObject({
        userOpHash: OP_A.userOpHash,
        success: true,
        circleVerification: verification,
      });
      expect(sentOps()).toEqual([OP_A.signedUserOp]);
      expect(mappings()).toEqual({});
    },
  );

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

// 第 10 回レビュー H-W・H-Y: op を bundler に渡した (かもしれない) 後の終わり方を、hook の「CirclePendingError 以外は attemptId の
// 対応を消す」まで通して確かめる (hook の規則は変えていない。circleSend が、送った後をふつうの error で終えないことで守る)。
//
// 送った後の区間は circleSend の境界の中なので、偽物が投げる「知らない op / 知らない hash」は確認待ちに吸われる。
// 送った op・待った hash は、下で値として確かめる。
describe('H-W・H-Y: 送った後の終わり方 (hook → 本物の executeCirclePayment)', () => {
  const waitedHashes = () => vi.mocked(waitForCircleReceipt).mock.calls.map((c) => c[0].hash);

  // 署名 1・署名 2 を承認し、op (OP_A) が bundler に渡る所まで進める。
  async function payUntilSent(screen: ReturnType<typeof openScreen>) {
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(sentOps()).toEqual([OP_A.signedUserOp]));
  }

  // H-Y (単独の画面で 2 本目まで届いた筋)。直す前: 開き直した画面の押下が confirmed の記録を resume し、receipt の取り直しが
  // bundler の失敗で投げる → ふつうの error → 対応が消える → 次の押下は新しい key で、90 秒より前の confirmed は「正規の
  // リピート」= 新しい署名を求め、承認すれば 2 本目を払う。
  it('送った後に離れた試みが裏で確定 → 90 秒より後に開き直して押した瞬間、bundler が receipt を返せない → 既払いの結果が出る (新しい署名も 2 本目も無い)', async () => {
    const receiptA = deferred<void>();
    receiptGates.set(OP_A.userOpHash, receiptA.promise);

    const screenA = openScreen();
    await payUntilSent(screenA);
    screenA.unmount();
    receiptA.resolve();
    await waitFor(() => expect(screenA.state().status).toBe('success'));
    expect(recordStatuses()).toEqual(['confirmed']);
    expect(Object.keys(mappings())).toHaveLength(1);

    // 90 秒より後。押した瞬間、bundler は receipt を返せない。
    clockOffset += 100_000;
    bundlerDown = true;
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() =>
      expect(
        screenB.result.current.isSuccess ||
          screenB.result.current.isError ||
          permitRequests.length > 1,
      ).toBe(true),
    );

    // 保存した値で既払いの結果が出る。新しい署名を求めず、送った op は A の 1 本だけ。
    expect(screenB.result.current.error).toBeNull();
    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
      success: true,
    });
    expect(permitRequests).toHaveLength(1);
    expect(userOpRequests).toHaveLength(1);
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    // 確定済みの op に、receipt の待ち (最大 120 秒) を使っていない (待ったのは A の送信の直後の 1 回だけ)。
    expect(waitedHashes()).toEqual([OP_A.userOpHash]);
    expect(recordStatuses()).toEqual(['confirmed']);
    // 画面のある試みが既払いの結果を受け取ったので、対応はここで消える (今までどおり)。
    expect(mappings()).toEqual({});

    // 成功が出た後にさらに押すのは、新しい支払い (今までどおり)。署名を求めるだけで、承認するまで何も送らない。
    bundlerDown = false;
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(2));
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
  });

  // H-Y (待ちの失敗)。直す前: 待ちの失敗がふつうの error になり、送った op が未確定のまま対応が消えた。
  it('op を送った後、receipt の待ちが失敗 (bundler の 5xx) → 確認待ち・対応が残る・その押下で送り直さない → もう一度押すと、署名なしで同じ op の結果を受け取る', async () => {
    const screen = openScreen();
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    const mappingBefore = mappings();
    expect(Object.keys(mappingBefore)).toHaveLength(1);

    bundlerDown = true; // 送信は通るが、その後の receipt の待ちが失敗する
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(screen.result.current.isError).toBe(true));

    expect(screen.result.current.error?.name).toBe('CirclePendingError');
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(waitedHashes()).toEqual([OP_A.userOpHash]);
    expect(recordStatuses()).toEqual(['submitting']);
    // 確認待ちなので、対応は残る (次の押下は同じ key を resume する)。
    expect(mappings()).toEqual(mappingBefore);

    // bundler が戻ってから、同じ画面でもう一度押す。
    bundlerDown = false;
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));

    expect(screen.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
      success: true,
    });
    expect(permitRequests).toHaveLength(1);
    expect(userOpRequests).toHaveLength(1);
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(waitedHashes()).toEqual([OP_A.userOpHash, OP_A.userOpHash]);
    expect(recordStatuses()).toEqual(['confirmed']);
    expect(mappings()).toEqual({});
  });

  // 境界。直す前: markSubmitting の後の storage の throw がふつうの error になり、op を渡したかもしれないのに対応が消えた。
  it('op を渡した後に記録を読めなくなった (送信の応答を失い、localStorage が投げる) → 確認待ち・対応が残る', async () => {
    const screen = openScreen();
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    const mappingBefore = mappings();

    // bundler は op を受け取ったが、応答が届かない。同じ頃から localStorage が読めない (sessionStorage は読める)。
    const realGetItem = Storage.prototype.getItem;
    let reads: { mockRestore: () => void } | undefined;
    vi.mocked(broadcastCircleUserOp).mockImplementationOnce(async () => {
      reads = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(function (this: Storage, key: string) {
          if (this === window.localStorage) throw new Error('SecurityError: storage is not available');
          return realGetItem.call(this, key);
        });
      throw new Error('socket hang up');
    });
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    reads?.mockRestore();

    expect(screen.result.current.error?.name).toBe('CirclePendingError');
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(recordStatuses()).toEqual(['submitting']);
    expect(mappings()).toEqual(mappingBefore);
  });
});
