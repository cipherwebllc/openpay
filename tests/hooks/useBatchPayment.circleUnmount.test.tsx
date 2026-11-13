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
import { getAddress, RpcRequestError, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import type { ReactNode } from 'react';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { PENDING_KEY_PREFIX } from '@/lib/circlePending';
import { logger } from '@/lib/logger';
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
    // 自分の最初の送信は「用意 (prepareCircleBroadcast) → 返った関数で送る」の 2 段 (PR-39b)。本物の broadcastCircleUserOp は
    // 同じ用意と送信を続けて行うだけなので、偽物も同じ mock に流す (最初の送信も送り直しも broadcastCircleUserOp で見る)。
    prepareCircleBroadcast:
      (bundle: unknown) =>
      (signedUserOp: unknown) =>
        broadcastCircleUserOp({ bundle, signedUserOp }),
    waitForCircleReceipt: vi.fn(),
    // 最初の送信の検証拒否で閉じる前に、bundler にその op の状態を聞く (PR #1084)。偽物の bundler は「その hash を知らない」
    // と答える (検証で拒否した op を一度も受理していない)。
    readCircleUserOpStatus: async () => ({ unknownToBundler: true, status: 'not_found' }),
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
import {
  verifyCircleReceiptOnChain,
  type CircleReconcileResult,
} from '@/lib/circleReceiptVerifier';
import { mockHook } from '../_helpers/wagmiMock';

// 本物の circleAccount の、送信の error の class と分類 (I/O ではない部分)。H-X の test が、本物と同じ error を作るのに使う。
const actualCircleAccount = await vi.importActual<
  typeof import('@/lib/smartAccount/circleAccount')
>('@/lib/smartAccount/circleAccount');

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
  // 押下ごとの mutation の state (押した順)。同じ画面で 2 回押す test が、2 回目の終わり方を見るのに使う。
  const states = () => qc.getMutationCache().getAll().map((mutation) => mutation.state);
  return { ...view, state, states };
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

// 第 10 回レビュー H-W・H-Y: op を bundler に渡した (かもしれない) 後の終わり方を、hook の「CirclePendingError (と storage の失敗)
// 以外は attemptId の対応を消す」まで通して確かめる (送った後の区間は、circleSend が、ふつうの error で終えないことで守る。hook の
// 規則に足したのは storage の失敗だけ = 下の describe)。
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

// Codex のレビュー (P2・main にもある既存の道): 入口の scan と resume の読み取りは、送った後の境界の外にある。storage を読めない・
// 書けない押下は、自分の記録の状態を確かめられない (分からない) のに、hook が attemptId の対応を消していた。対応が消えると次の
// 押下は新しい key になり、裏で確定していた前の支払い (90 秒より前の confirmed) を「正規のリピート」とみなして 2 本目を払う。
// 直した後: storage の失敗 (PendingStoreUnavailableError・PendingStoreWriteError) の押下は対応を残す。消すのは今までどおり、
// この試みが終わっていて渡した op も無いと分かったとき (署名の拒否・「既に終了」など) だけ。
describe('storage の失敗の押下と attemptId の対応 (hook → 本物の executeCirclePayment)', () => {
  type GasPrice = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

  // localStorage の読み取りだけを投げさせる (sessionStorage は読める)。
  function breakLocalReads() {
    const realGetItem = Storage.prototype.getItem;
    return vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(function (this: Storage, key: string) {
        if (this === window.localStorage) throw new Error('SecurityError: storage is not available');
        return realGetItem.call(this, key);
      });
  }

  // localStorage への、match に合う書き込みだけを投げさせる (容量の上限)。
  function breakLocalWrites(match: (value: string) => boolean) {
    const realSetItem = Storage.prototype.setItem;
    return vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (this === window.localStorage && match(value)) {
          throw new Error('QuotaExceededError: the quota has been exceeded');
        }
        return realSetItem.call(this, key, value);
      });
  }

  // 記録の attemptId の一覧。
  function recordAttemptIds(): string[] {
    return Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!)
      .filter((key) => key.startsWith(PENDING_KEY_PREFIX))
      .map(
        (key) =>
          (JSON.parse(window.localStorage.getItem(key)!) as { paymentAttemptId: string })
            .paymentAttemptId,
      );
  }

  it('送った後に離れた試みが裏で確定 → 100 秒後に開き直して押し、ガス価格を待つ間に localStorage が読めなくなる → storage の error で終わり、対応は残る → 戻して押し直すと既払いの結果 (送られた op は A の 1 本だけ)', async () => {
    const receiptA = deferred<void>();
    receiptGates.set(OP_A.userOpHash, receiptA.promise);

    const screenA = openScreen();
    screenA.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(sentOps()).toEqual([OP_A.signedUserOp]));

    // 送った後に画面を離れ、op は裏で確定する (失効した試みは対応を消さない = #1074)。
    screenA.unmount();
    receiptA.resolve();
    await waitFor(() => expect(screenA.state().status).toBe('success'));
    expect(recordStatuses()).toEqual(['confirmed']);
    const mappingOfA = mappings();
    expect(Object.keys(mappingOfA)).toHaveLength(1);

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
    const gas = deferred<GasPrice>();
    vi.mocked(getCircleUserOpGasPrice).mockReturnValueOnce(gas.promise);
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    // hook の最初の storage の確認 (Pimlico の記録の読み取り) は通り、ガス価格を待っている。
    await waitFor(() => expect(getCircleUserOpGasPrice).toHaveBeenCalledTimes(2));

    // ガス価格を待つ間に localStorage が読めなくなる → 入口の scan が投げる。
    const reads = breakLocalReads();
    gas.resolve({ maxFeePerGas: 5n * GWEI, maxPriorityFeePerGas: 1n });
    await waitFor(() => expect(screenB.result.current.isError).toBe(true));
    reads.mockRestore();

    // storage の error の文がそのまま出る (今までどおり)。記録の状態を確かめられなかったので、対応は残す。
    expect(screenB.result.current.error?.name).toBe('PendingStoreUnavailableError');
    expect(mappings()).toEqual(mappingOfA);
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(signUsdcPermit).toHaveBeenCalledOnce();

    // storage が戻ってから、同じ画面で押し直す。同じ attemptId を resume し、新しい署名を求めずに既払いの結果を受け取る。
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));
    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
      success: true,
    });
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(signUsdcPermit).toHaveBeenCalledOnce();
    expect(prepareAndSignCircleUserOp).toHaveBeenCalledOnce();
    expect(recordStatuses()).toEqual(['confirmed']);
    // 画面のある試みが受け取ったので、対応はここで消える (今までどおり)。
    expect(mappings()).toEqual({});
  });

  it('新しい支払いで、記録の予約を書けない → storage の error で終わり、対応は残る → 戻して押し直すと、同じ attemptId で 1 回だけ送る', async () => {
    const screen = openScreen();
    const writes = breakLocalWrites(() => true);
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    writes.mockRestore();

    expect(screen.result.current.error?.name).toBe('PendingStoreWriteError');
    // sessionStorage は正常なので、タブの対応は保存できている。「記録を保存できません」の欄 (flag) にはしない (今までどおり)。
    expect(screen.result.current.pendingStoreUnavailable).toBe(false);
    expect(recordStatuses()).toEqual([]);
    expect(signUsdcPermit).not.toHaveBeenCalled();
    const mappingAfterFailure = mappings();
    expect(Object.keys(mappingAfterFailure)).toHaveLength(1);

    // 戻してから押し直す。残した対応の attemptId で記録を予約し、署名を求める。
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    expect(recordAttemptIds()).toEqual(Object.values(mappingAfterFailure));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));

    expect(screen.result.current.data).toMatchObject({ userOpHash: OP_A.userOpHash, success: true });
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(recordStatuses()).toEqual(['confirmed']);
    expect(mappings()).toEqual({});
  });

  // 直す前は、対応が消えて次の押下が新しい key になり、scan が自分の古い記録 (signed・3 分以内) を「別の試みが署名中」と
  // みなして、3 分のあいだ確認待ちで止まっていた。
  it('自分の markSubmitting を書けない (記録は signed・op は渡していない) → storage の error で終わり、対応は残る → 戻して押し直すと、同じ記録を resume して署名からやり直し、1 回だけ送る', async () => {
    const screen = openScreen();
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    const mappingBefore = mappings();
    expect(Object.keys(mappingBefore)).toHaveLength(1);

    const writes = breakLocalWrites((value) => value.includes('"status":"submitting"'));
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    writes.mockRestore();

    expect(screen.result.current.error?.name).toBe('PendingStoreWriteError');
    expect(sentOps()).toEqual([]);
    expect(recordStatuses()).toEqual(['signed']);
    expect(mappings()).toEqual(mappingBefore);

    // 戻してから押し直す。同じ key の記録 (signed・まだ渡していない) を resume し、署名からやり直す。
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(2));
    permitRequests[1].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(2));
    userOpRequests[1].approve(OP_B);
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));

    expect(screen.result.current.data).toMatchObject({ userOpHash: OP_B.userOpHash, success: true });
    expect(sentOps()).toEqual([OP_B.signedUserOp]);
    expect(recordStatuses()).toEqual(['confirmed']);
    expect(mappings()).toEqual({});
  });

  // 対応を残しても止まる道が増えないことの確認 (ずっと読めない端末): hook の最初の確認 (Pimlico の記録の読み取り) で止まり、
  // Circle の入口 (ガス価格・attemptId の対応・記録・署名) まで来ない。
  it('localStorage がずっと読めない → hook の最初の確認で止まり、Circle の入口まで来ない (対応も記録も作らず、署名も求めない)', async () => {
    const reads = breakLocalReads();
    try {
      const screen = openScreen();
      screen.result.current.mutate(PARAMS);
      await waitFor(() => expect(screen.result.current.pendingStoreUnavailable).toBe(true));
      await waitFor(() => expect(screen.state().status).toBe('error'));
      expect(getCircleUserOpGasPrice).not.toHaveBeenCalled();
      expect(signUsdcPermit).not.toHaveBeenCalled();
      expect(mappings()).toEqual({});
    } finally {
      reads.mockRestore();
    }
    expect(recordStatuses()).toEqual([]);
  });

  // 今までどおり消す道: この試みは何も渡しておらず、記録は abandoned (終わった)。
  it('署名 1 を拒否 → 対応は消える (今までどおり) → 次の押下は新しい attemptId で、新しい支払いとして署名を求める', async () => {
    const screen = openScreen();
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    const mappingBefore = mappings();
    expect(Object.keys(mappingBefore)).toHaveLength(1);

    permitRequests[0].reject(new Error('User rejected the request.'));
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    expect(screen.result.current.error?.message).toBe('User rejected the request.');
    expect(recordStatuses()).toEqual(['abandoned']);
    expect(mappings()).toEqual({});

    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(2));
    const mappingAfter = mappings();
    expect(Object.keys(mappingAfter)).toEqual(Object.keys(mappingBefore));
    expect(Object.values(mappingAfter)).not.toEqual(Object.values(mappingBefore));
    expect(sentOps()).toEqual([]);
  });
});

// 第 10 回レビュー H-X (PR-39b): 自分の最初の送信を bundler が検証で拒否したら、記録を閉じて「送信の受付で断られた」で終える。
// 直す前: 「応答の喪失」と同じ扱いで確認待ち (CirclePendingError) になり、対応が残って、押すたびに 120 秒待ち → 同じ op の
// 送り直し (また拒否) → 120 秒待ち、を繰り返した (その内容の支払いが、このタブで払えない)。
// 送信の error は、本物の circleAccount が投げるのと同じもの (viem の RpcRequestError を本物の分類に通す)。
describe('H-X: 最初の送信の検証拒否 (hook → 本物の executeCirclePayment)', () => {
  const waitedHashes = () => vi.mocked(waitForCircleReceipt).mock.calls.map((c) => c[0].hash);

  function bundlerSays(reply: { code: number; message: string }) {
    const cause = new RpcRequestError({
      body: { method: 'eth_sendUserOperation', params: [OP_A.signedUserOp] },
      error: reply,
      url: 'https://bundler.test/rpc',
    });
    return new actualCircleAccount.CircleBroadcastError({
      ...actualCircleAccount.classifyCircleBroadcastError(cause, 200),
      cause,
    });
  }

  // 署名 1・署名 2 を承認する。OP_A の送信には bundler が reply の拒否を返す。
  async function payAndGetRejected(
    screen: ReturnType<typeof openScreen>,
    reply: { code: number; message: string },
  ) {
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    vi.mocked(broadcastCircleUserOp).mockImplementationOnce(async () => {
      throw bundlerSays(reply);
    });
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
  }

  it('最初の送信を bundler が検証で拒否 → 専用の error・待たない・対応が消える → 次の押下は新しい支払い (署名 2 回から・別の op を 1 回だけ送る)', async () => {
    const screen = openScreen();
    await payAndGetRejected(screen, { code: -32501, message: 'AA33 reverted (or OOG)' });

    // 確認待ちではない。画面に出る文は固定で、bundler の生の文 (AA33…) を含まない。
    const error = screen.result.current.error;
    expect(error?.name).toBe('CircleSendRejectedError');
    expect(error?.message).toBe(
      'USDC ガスレスの支払いは、送信の受付で断られました。この支払いは送金されていません。' +
        '残高が足りないなどの理由が考えられます。もう一度お試しください (署名からやり直します)。',
    );
    // 拒否が返った時点で終わる (receipt を待たない・送り直さない)。記録は failed・対応は消える。
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(waitedHashes()).toEqual([]);
    expect(recordStatuses()).toEqual(['failed']);
    expect(mappings()).toEqual({});

    // 同じ画面でもう一度押す → 新しい attemptId の新しい支払い: 署名 1・署名 2 を求め直し、別の op を 1 回だけ送る。
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(2));
    expect(Object.keys(mappings())).toHaveLength(1);
    permitRequests[1].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(2));
    userOpRequests[1].approve(OP_B);
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));

    expect(screen.result.current.data).toMatchObject({
      userOpHash: OP_B.userOpHash,
      txHash: OP_B.txHash,
      success: true,
    });
    expect(permitRequests).toHaveLength(2);
    expect(userOpRequests).toHaveLength(2);
    expect(sentOps()).toEqual([OP_A.signedUserOp, OP_B.signedUserOp]);
    expect(waitedHashes()).toEqual([OP_B.userOpHash]);
    expect(recordStatuses().sort()).toEqual(['confirmed', 'failed']);
    expect(mappings()).toEqual({});
  });

  // S1: nonce の拒否は「受け付けていない」と読まない (この op 自身がもう届いている疑い)。閉じず、今までどおり確認待ち。
  it('最初の送信の拒否が nonce (AA25) → 閉じない: 確認待ち・対応が残る・記録は submitting のまま', async () => {
    // receipt は返らない (bundler の 5xx)。待ちの失敗では、その押下で送り直さない (PR-39a)。
    bundlerDown = true;
    const screen = openScreen();
    await payAndGetRejected(screen, { code: -32500, message: 'AA25 invalid account nonce' });

    expect(screen.result.current.error?.name).toBe('CirclePendingError');
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(waitedHashes()).toEqual([OP_A.userOpHash]);
    expect(recordStatuses()).toEqual(['submitting']);
    expect(Object.keys(mappings())).toHaveLength(1);

    // bundler が戻ってからもう一度押すと、署名なしで同じ op の結果を受け取る (その op は取り込まれていた)。
    bundlerDown = false;
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    expect(screen.result.current.data).toMatchObject({ userOpHash: OP_A.userOpHash, success: true });
    expect(permitRequests).toHaveLength(1);
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
  });
});

// 第 10 回レビューの後追い r10-ss (money-path): Circle の経路は「同じタブの続き」を sessionStorage の対応 (chain・sender・内容 →
// attemptId) で見分ける。直す前: 対応を保存できない端末 (sessionStorage を読めない・書けない・書いても残らない) では、
// stableAttemptId が保存していない新しい UUID を黙って返し、hook はそれで **新しい支払い** まで送っていた。その支払いが確認待ちで
// 終わる (または、前の支払いが裏で確定して 90 秒を過ぎている) と、次の押下は別の attemptId (別の key) になり、2 本目の署名を求める。
// 直した後: 対応を保存できていない押下は、**新しい記録を予約する直前** で止まり (executeCirclePayment の中・scan の後)、
// localStorage を読めない端末と同じ flag (pendingStoreUnavailable) を立てる (画面は「この端末では記録を保存できません」の欄・
// hook の error は null)。**既にある支払いの復旧・結果の受け取り (scan) は、対応を保存できなくても今までどおり** (入口で止めると、
// 対応を保存した後に sessionStorage を読めなくなった端末で、送った支払いの結果を受け取れなくなる = Codex の指摘)。
describe('r10-ss: タブの対応 (sessionStorage) を保存できていない押下は、新しい支払いを始めない (hook → 本物の executeCirclePayment)', () => {
  const UNAVAILABLE = 'circle.attempt_mapping.unavailable';
  const unavailableWarns = () =>
    vi.mocked(logger.warn).mock.calls.filter(([msg]) => msg === UNAVAILABLE);
  const circleCodeOf = (error: unknown) => (error as { circleCode?: string } | null)?.circleCode;

  // setItem を投げさせる。'session' = sessionStorage だけ (localStorage は正常)・'both' = 両方 (getItem は通る)。
  function breakWrites(target: 'session' | 'both') {
    const realSetItem = Storage.prototype.setItem;
    return vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (target === 'both' || this === window.sessionStorage) {
          throw new Error('QuotaExceededError: the quota has been exceeded');
        }
        return realSetItem.call(this, key, value);
      });
  }

  // sessionStorage の setItem が、投げずに黙って落とす (書いたのに残らない)。
  function dropSessionWrites() {
    const realSetItem = Storage.prototype.setItem;
    return vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (this === window.sessionStorage) return;
        realSetItem.call(this, key, value);
      });
  }

  // sessionStorage の setItem が、渡した値とは別の値を残す (読み戻すと別の値)。
  function garbleSessionWrites() {
    const realSetItem = Storage.prototype.setItem;
    return vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        realSetItem.call(this, key, this === window.sessionStorage ? 'some-other-value' : value);
      });
  }

  // sessionStorage の getItem だけを投げさせる (localStorage は読める = hook の最初の確認は通る)。
  // from = 何回目の読み取りから投げるか (既定 1 = 全部。2 = 最初の読み取りは通り、書いた後の読み戻しから投げる)。
  function breakSessionReads(from = 1) {
    const realGetItem = Storage.prototype.getItem;
    let reads = 0;
    return vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(function (this: Storage, key: string) {
        if (this === window.sessionStorage) {
          reads += 1;
          if (reads === from || (from === 1 && reads >= 1)) {
            throw new Error('SecurityError: storage is not available');
          }
        }
        return realGetItem.call(this, key);
      });
  }

  // 正常な端末で 1 回払い、送信の後の receipt の待ちが失敗して確認待ちで終わる所まで進める (記録は submitting・対応は保存済み・
  // bundler は止まったまま)。
  async function payUntilUnconfirmed(screen: ReturnType<typeof openScreen>) {
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    bundlerDown = true; // 送信は通るが、receipt の待ちが失敗する
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    expect(screen.result.current.error?.name).toBe('CirclePendingError');
    expect(circleCodeOf(screen.result.current.error)).toBe('unconfirmed');
    expect(sentOps()).toEqual([OP_A.signedUserOp]);
    expect(recordStatuses()).toEqual(['submitting']);
    expect(Object.keys(mappings())).toHaveLength(1);
  }

  // 正常な端末で 1 回払い、送った後に画面を離れ、その試みが裏で確定する所まで進める (記録は confirmed・成功はどの画面にも
  // 出ていない・対応は保存されたまま)。
  async function payAndLeaveBeforeConfirmed() {
    const receiptA = deferred<void>();
    receiptGates.set(OP_A.userOpHash, receiptA.promise);
    const screenA = openScreen();
    screenA.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    permitRequests[0].approve(PERMIT);
    await waitFor(() => expect(userOpRequests).toHaveLength(1));
    userOpRequests[0].approve(OP_A);
    await waitFor(() => expect(sentOps()).toEqual([OP_A.signedUserOp]));
    screenA.unmount();
    receiptA.resolve();
    await waitFor(() => expect(screenA.state().status).toBe('success'));
    expect(recordStatuses()).toEqual(['confirmed']);
    expect(Object.keys(mappings())).toHaveLength(1);
  }

  // この押下が、新しい支払いを何も始めていないこと (既にある分 = before より後に、署名の要求・送信・記録が増えていない)。
  function expectNoNewPayment(before: { signatures: number; sent: number; records: string[] }) {
    expect(permitRequests.length + userOpRequests.length).toBe(before.signatures);
    expect(vi.mocked(signUsdcPermit).mock.calls.length + vi.mocked(prepareAndSignCircleUserOp).mock.calls.length).toBe(
      before.signatures,
    );
    expect(sentOps()).toHaveLength(before.sent);
    expect(recordStatuses()).toEqual(before.records);
  }
  const NOTHING = { signatures: 0, sent: 0, records: [] as string[] };

  // ---- 既にある支払いの復旧・結果の受け取りは、対応を保存できなくても今までどおり (Codex の順・main と同じ結果) ----

  it('Codex の順 1: 送った支払いが確認待ち (記録は submitting・対応は保存済み) → sessionStorage の getItem だけが throw するようになる → もう一度押す → 同じ op の結果を受け取る (欄は出ない・署名と送信は 1 回目の分だけ)', async () => {
    const screen = openScreen();
    await payUntilUnconfirmed(screen);

    const reads = breakSessionReads();
    bundlerDown = false;
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    reads.mockRestore();

    expect(screen.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
      success: true,
    });
    expect(screen.result.current.pendingStoreUnavailable).toBe(false);
    expect(screen.result.current.error).toBeNull();
    expectNoNewPayment({ signatures: 2, sent: 1, records: ['confirmed'] });
    // 対応を読めなかったことは warn に 1 行残る (この押下は、保存していない id で scan から入った)。
    expect(unavailableWarns()).toEqual([[UNAVAILABLE, { chainId: baseSepolia.id, cause: 'read' }]]);
  });

  it('Codex の順 2: 送った支払いが裏で確定 (記録は confirmed・成功はどの画面にも出ていない) → sessionStorage の getItem だけが throw → 90 秒以内に開き直して押す → 既払いの結果を受け取る (欄は出ない・署名と送信は 1 回目の分だけ)', async () => {
    await payAndLeaveBeforeConfirmed();

    clockOffset += 30_000;
    const reads = breakSessionReads();
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));
    reads.mockRestore();

    expect(screenB.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
      success: true,
    });
    expect(screenB.result.current.pendingStoreUnavailable).toBe(false);
    expect(screenB.result.current.error).toBeNull();
    expectNoNewPayment({ signatures: 2, sent: 1, records: ['confirmed'] });
  });

  // 最初の対応を保存できていない押下でも、付け替えを書けたら、この試みの「対応の指す先」は今までどおり付け替えた先になる
  // (hook が circleSend に返す値だけが false)。結果を受け取った画面のある試みは、付け替えた対応を今までどおり消す。
  it('別のタブの支払いが裏で確定 (90 秒以内) → このタブは、最初の対応の読み戻しだけが throw (saved は false・その後は読める) → 押す → 既払いの結果を受け取り、付け替えた対応は今までどおり消える', async () => {
    await payAndLeaveBeforeConfirmed();
    // 別のタブ = このタブの sessionStorage には対応が無い。
    window.sessionStorage.clear();

    clockOffset += 30_000;
    const reads = breakSessionReads(2);
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(screenB.result.current.isSuccess).toBe(true));
    reads.mockRestore();

    expect(screenB.result.current.data).toMatchObject({ userOpHash: OP_A.userOpHash, success: true });
    expect(screenB.result.current.pendingStoreUnavailable).toBe(false);
    expectNoNewPayment({ signatures: 2, sent: 1, records: ['confirmed'] });
    expect(unavailableWarns()).toEqual([[UNAVAILABLE, { chainId: baseSepolia.id, cause: 'readback' }]]);
    // 最初に書いた (読み戻せなかった) 値は、付け替えで記録の attemptId に替わり、結果を受け取った所で消える。
    expect(mappings()).toEqual({});
  });

  // Codex と同じ壊れ方 (getItem だけ throw・setItem は通る) で、復旧が確認待ちで終わる形。付け替えの書き込みは通るが、
  // 次の押下はその対応を読めない (resume にならず、また scan から入る)。(a) の「24 時間以内にこのタブで…もう一度押すと、まず
  // 同じ支払いの結果を確かめ直します」は言えないので、hook は付け替えを「書けた」と返さず、場面は (e) になる。
  it('確認待ちの支払いがある端末で sessionStorage の getItem だけが throw するようになり (setItem は通る)、復旧の照会も失敗する → 確認待ち (e) で終わる ((a) にしない・欄は出ない・署名を求めない・送り直さない)。次の押下も scan から入り、bundler が戻れば同じ op の結果を受け取る', async () => {
    const screen = openScreen();
    await payUntilUnconfirmed(screen);
    const savedMapping = mappings();

    const reads = breakSessionReads();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    screen.result.current.mutate(PARAMS); // bundler は止まったまま
    await waitFor(() => expect(screen.states()[1]?.status).toBe('error'));
    await waitFor(() =>
      expect(circleCodeOf(screen.result.current.error)).toBe('unconfirmed_earlier'),
    );
    expect(screen.result.current.error?.name).toBe('CirclePendingError');
    expect(screen.result.current.pendingStoreUnavailable).toBe(false);
    expectNoNewPayment({ signatures: 2, sent: 1, records: ['submitting'] });
    // 付け替えの書き込みは今までどおり試している (sessionStorage への setItem が 1 回・値はその記録の attemptId)。
    const sessionWrites = setItem.mock.calls.filter(
      (_call, i) => setItem.mock.contexts[i] === window.sessionStorage,
    );
    expect(sessionWrites.map(([, value]) => value)).toEqual(Object.values(savedMapping));
    setItem.mockRestore();

    // 次の押下も、保存していない別の id で scan から入る (warn が押下ごとに 1 行)。bundler が戻れば、同じ op の結果を受け取る。
    bundlerDown = false;
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    reads.mockRestore();

    expect(screen.result.current.data).toMatchObject({ userOpHash: OP_A.userOpHash, success: true });
    expect(screen.result.current.pendingStoreUnavailable).toBe(false);
    expectNoNewPayment({ signatures: 2, sent: 1, records: ['confirmed'] });
    expect(unavailableWarns()).toEqual([
      [UNAVAILABLE, { chainId: baseSepolia.id, cause: 'read' }],
      [UNAVAILABLE, { chainId: baseSepolia.id, cause: 'read' }],
    ]);
  });

  // 付け替えを書けないので (e)。次の押下も、保存していない別の id で scan から入り、同じ記録を復旧する。
  it('確認待ちの支払いがある端末で sessionStorage が読めも書けもしなくなり、復旧の照会も失敗する → 確認待ち (e) で終わる (欄は出ない・署名を求めない・送り直さない)。次の押下も scan から入り、bundler が戻れば同じ op の結果を受け取る', async () => {
    const screen = openScreen();
    await payUntilUnconfirmed(screen);

    const reads = breakSessionReads();
    const writes = breakWrites('session');
    screen.result.current.mutate(PARAMS); // bundler は止まったまま
    await waitFor(() => expect(screen.states()[1]?.status).toBe('error'));
    await waitFor(() =>
      expect(circleCodeOf(screen.result.current.error)).toBe('unconfirmed_earlier'),
    );
    expect(screen.result.current.error?.name).toBe('CirclePendingError');
    expect(screen.result.current.pendingStoreUnavailable).toBe(false);
    expectNoNewPayment({ signatures: 2, sent: 1, records: ['submitting'] });

    bundlerDown = false;
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    reads.mockRestore();
    writes.mockRestore();

    expect(screen.result.current.data).toMatchObject({ userOpHash: OP_A.userOpHash, success: true });
    expect(screen.result.current.pendingStoreUnavailable).toBe(false);
    expectNoNewPayment({ signatures: 2, sent: 1, records: ['confirmed'] });
  });

  it('別の画面が署名の途中 (直近の pre-submit の記録) → 今までどおり (b) で終わる (欄は出ない・この押下は何も始めない)', async () => {
    const screenA = openScreen();
    screenA.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    expect(recordStatuses()).toEqual(['awaiting_signature']);

    const reads = breakSessionReads();
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(screenB.result.current.isError).toBe(true));
    reads.mockRestore();

    expect(screenB.result.current.error?.name).toBe('CirclePendingError');
    expect(circleCodeOf(screenB.result.current.error)).toBe('busy_elsewhere');
    expect(screenB.result.current.pendingStoreUnavailable).toBe(false);
    expectNoNewPayment({ signatures: 1, sent: 0, records: ['awaiting_signature'] });
  });

  // ---- 新しい支払いを作る所まで来た押下は、送らずに欄 ----

  // 2 つ目の「両方の setItem が throw」は、この PR が表示を変える形: 直す前は hook の最初の確認 (getItem だけ) を通り、記録の
  // 予約の書き込み (writeRecord) の PendingStoreWriteError がそのまま画面の error に出ていた (日本語の固定文・英語の画面でも)。
  // 直した後は、予約の書き込みの前に止まり、flag になる (送らない点は前も後も同じ)。
  // 最後の列 = 止まった後に sessionStorage に残っている対応の数 (hook は、この押下で対応を消しに行かない)。
  const brokenDevices: Array<[string, () => { mockRestore: () => void }, string, number]> = [
    ['sessionStorage の setItem だけが throw (localStorage は正常)', () => breakWrites('session'), 'write', 0],
    [
      'localStorage と sessionStorage の両方の setItem が throw (getItem は通る)',
      () => breakWrites('both'),
      'write',
      0,
    ],
    ['sessionStorage の setItem が黙って落とす (書いたのに残らない)', dropSessionWrites, 'readback', 0],
    ['sessionStorage の setItem が別の値を残す (読み戻すと別の値)', garbleSessionWrites, 'readback', 1],
    ['sessionStorage の、書いた後の読み戻しだけが throw (書いた値は残っている)', () => breakSessionReads(2), 'readback', 1],
    ['sessionStorage の getItem だけが throw', breakSessionReads, 'read', 0],
  ];
  it.each(brokenDevices)(
    '記録の無い新しい支払い・%s → 送らずに止まる: flag が立ち・hook の error は null・記録も署名も送信も無い',
    async (_label, breakStorage, cause, leftMappings) => {
      const broken = breakStorage();
      const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
      const screen = openScreen();
      screen.result.current.mutate(PARAMS);
      // flag と error は、mutation が終わった後の画面の状態で見る (最初の押下なので、isError が立つのは終わった後だけ)。
      await waitFor(() => expect(screen.state().status).toBe('error'));
      await waitFor(() => expect(screen.result.current.isError).toBe(true));
      broken.mockRestore();

      const raw = screen.state().error as (Error & { reason?: string }) | null;
      expect(raw?.name).toBe('PimlicoPendingStoreUnavailableError');
      expect(raw?.reason).toBe('attempt-mapping-unavailable');
      expect(screen.result.current.pendingStoreUnavailable).toBe(true);
      expect(screen.result.current.error).toBeNull();
      expect(screen.result.current.data).toBeUndefined();
      expect(getCircleUserOpGasPrice).toHaveBeenCalledOnce();
      expectNoNewPayment(NOTHING);
      expect(broadcastCircleUserOp).not.toHaveBeenCalled();
      expect(waitForCircleReceipt).not.toHaveBeenCalled();
      // 止まった押下は、対応を消しに行かない (この押下の attemptId は保存できていない id で、残っている値はこの試みのものと
      // 言えない)。読み戻しで見分けた形では、書いた値・別の値が残ったまま。
      expect(removeItem).not.toHaveBeenCalled();
      expect(Object.keys(mappings())).toHaveLength(leftMappings);
      // warn は 1 行。入っているのは chainId と、どこで失敗したかだけ (アドレス・hash を入れない)。
      expect(unavailableWarns()).toEqual([[UNAVAILABLE, { chainId: baseSepolia.id, cause }]]);
      expect(JSON.stringify(unavailableWarns()).toLowerCase()).not.toContain(CUSTOMER.toLowerCase());
    },
  );

  // この PR が塞ぐ穴 (対応を保存した後に読めなくなった端末の形)。直す前: 保存していない id で scan に入り、90 秒より前の
  // confirmed は「正規のリピート」として飛ばし、新しい支払いに署名を求めていた (前の支払いの成功は、どの画面にも出ていない)。
  it('送った支払いが裏で確定 (成功はどの画面にも出ていない) → sessionStorage の getItem が throw → 90 秒より後に開き直して押す → 2 本目を始めない (署名を求めず、欄を出す)', async () => {
    await payAndLeaveBeforeConfirmed();

    clockOffset += 100_000;
    const reads = breakSessionReads();
    const screenB = openScreen();
    screenB.result.current.mutate(PARAMS);
    await waitFor(() => expect(screenB.state().status).toBe('error'));
    await waitFor(() => expect(screenB.result.current.isError).toBe(true));
    reads.mockRestore();

    expect(screenB.state().error?.name).toBe('PimlicoPendingStoreUnavailableError');
    expect(screenB.result.current.pendingStoreUnavailable).toBe(true);
    expect(screenB.result.current.error).toBeNull();
    expect(screenB.result.current.data).toBeUndefined();
    expectNoNewPayment({ signatures: 2, sent: 1, records: ['confirmed'] });
    // 前の支払いの対応は残っている (読めるようになれば、次の押下はその記録を resume して既払いの結果を受け取る)。
    expect(Object.keys(mappings())).toHaveLength(1);
  });

  // 画面 (3 フォーム) は flag で送信を閉じるが、安全をそれに頼らない: mutate をもう一度呼んでも、また送らずに止まる。
  // flag は、押下の入口 (localStorage を読めた) でいったん下り、新しい記録の予約の直前でまた立つ (同じ押下の中の順番)。
  it('止まった後にもう一度押す → また送らずに止まる (flag は入口で下り、また立つ)。sessionStorage が戻ってから押すと、今までどおり署名を求める', async () => {
    const broken = breakWrites('session');
    const screen = openScreen();
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(screen.states()[0].status).toBe('error'));
    await waitFor(() => expect(screen.result.current.pendingStoreUnavailable).toBe(true));

    // 2 回目。ガス価格を待つ間は、入口が flag を下ろしている (試み中の印は 1 回目の終わりで外れている = Circle の入口まで来る)。
    const gas = deferred<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>();
    vi.mocked(getCircleUserOpGasPrice).mockReturnValueOnce(gas.promise);
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(getCircleUserOpGasPrice).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.result.current.pendingStoreUnavailable).toBe(false));
    expect(screen.result.current.isPending).toBe(true);
    gas.resolve({ maxFeePerGas: 5n * GWEI, maxPriorityFeePerGas: 1n });
    await waitFor(() => expect(screen.states()[1]?.status).toBe('error'));
    await waitFor(() => expect(screen.result.current.pendingStoreUnavailable).toBe(true));
    expect(screen.states()[1].error?.name).toBe('PimlicoPendingStoreUnavailableError');
    expect(screen.result.current.error).toBeNull();
    expectNoNewPayment(NOTHING);
    expect(mappings()).toEqual({});
    expect(unavailableWarns()).toHaveLength(2);

    // sessionStorage が戻ってから押す: 入口が flag を下ろし、対応を保存して、新しい支払いとして署名を求める。
    broken.mockRestore();
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    await waitFor(() => expect(screen.result.current.pendingStoreUnavailable).toBe(false));
    expect(Object.keys(mappings())).toHaveLength(1);
    expect(recordStatuses()).toEqual(['awaiting_signature']);
    expect(sentOps()).toEqual([]);
    expect(unavailableWarns()).toHaveLength(2);
  });

  // ---- 対応を保存できている押下・対応を使わない押下は、今までどおり ----

  it('sessionStorage が正常 → 今までどおり (対応を保存して署名を求める・flag は立たない・warn も出ない)', async () => {
    const screen = openScreen();
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(permitRequests).toHaveLength(1));

    expect(screen.result.current.pendingStoreUnavailable).toBe(false);
    expect(screen.result.current.isPending).toBe(true);
    const mapping = mappings();
    expect(Object.keys(mapping)).toHaveLength(1);
    // 記録は、保存した対応の attemptId で予約されている。
    const recordAttemptIds = Array.from(
      { length: window.localStorage.length },
      (_, i) => window.localStorage.key(i)!,
    )
      .filter((key) => key.startsWith(PENDING_KEY_PREFIX))
      .map(
        (key) =>
          (JSON.parse(window.localStorage.getItem(key)!) as { paymentAttemptId: string })
            .paymentAttemptId,
      );
    expect(recordAttemptIds).toEqual(Object.values(mapping));
    expect(unavailableWarns()).toEqual([]);
  });

  // 既にある対応は読むだけで、書き直さない (saved: true のまま = 自分の key の resume)。
  it('前の押下で対応を保存できた後に、sessionStorage へ書けなくなる (読める) → 確認待ちの続きは今までどおり (署名なしで同じ op の結果を受け取る・対応も消える)', async () => {
    const screen = openScreen();
    await payUntilUnconfirmed(screen);

    const broken = breakWrites('session');
    bundlerDown = false;
    screen.result.current.mutate(PARAMS);
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    broken.mockRestore();

    expect(screen.result.current.data).toMatchObject({
      userOpHash: OP_A.userOpHash,
      txHash: OP_A.txHash,
      success: true,
    });
    expect(screen.result.current.pendingStoreUnavailable).toBe(false);
    expectNoNewPayment({ signatures: 2, sent: 1, records: ['confirmed'] });
    expect(unavailableWarns()).toEqual([]);
    // 結果を受け取ったので、対応は今までどおり消える (破棄は removeItem で、書き込みではない)。
    expect(mappings()).toEqual({});
  });

  it('明示の paymentAttemptId → 対応を使わないので確かめない (sessionStorage に書けなくても、今までどおり署名を求める)', async () => {
    const broken = breakWrites('session');
    const screen = openScreen();
    screen.result.current.mutate({ ...PARAMS, paymentAttemptId: 'explicit-attempt-1' });
    await waitFor(() => expect(permitRequests).toHaveLength(1));
    broken.mockRestore();

    expect(screen.result.current.pendingStoreUnavailable).toBe(false);
    expect(screen.result.current.isPending).toBe(true);
    expect(recordStatuses()).toEqual(['awaiting_signature']);
    expect(mappings()).toEqual({});
    expect(unavailableWarns()).toEqual([]);
  });
});
