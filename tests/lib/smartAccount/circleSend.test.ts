import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { WaitForUserOperationReceiptTimeoutError } from 'viem/account-abstraction';

// circleAccount の I/O primitive (chain 通信 / 署名) は mock し、circleSend の
// FSM + recovery ロジックを実 store (jsdom localStorage) 上で検証する。
vi.mock('@/lib/smartAccount/circleAccount', () => ({
  signUsdcPermit: vi.fn(),
  prepareAndSignCircleUserOp: vi.fn(),
  broadcastCircleUserOp: vi.fn(),
  waitForCircleReceipt: vi.fn(),
}));

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
} from '@/lib/smartAccount/circleSend';
import {
  computeCallHash,
  computeIdempotencyKey,
  findRecoverable,
  loadPendingRecord,
} from '@/lib/circlePending';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const PAYMASTER = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966');
const MERCHANT = getAddress('0x4444444444444444444444444444444444444444');
const CHAIN_ID = 421614;
const UOH = '0xabc0000000000000000000000000000000000000000000000000000000000001' as Hex;
const TX = '0xdef0000000000000000000000000000000000000000000000000000000000002' as Hex;

const CALLS = [{ to: MERCHANT, data: '0xabcd' as Hex }];
const SIGNED_OP = { sender: OWNER, nonce: '0x0', signature: '0x' + 'ab'.repeat(65) };
const PERMIT_SIG = ('0x' + 'cd'.repeat(65)) as Hex;

const fakeBundle = {
  provider: 'circle',
  entryPointVersion: '0.8',
  chainId: CHAIN_ID,
  paymasterAddress: PAYMASTER,
  account: {},
  bundlerClient: {},
  deployment: {},
} as unknown as CircleSmartAccountBundle;

function receipt() {
  return {
    receipt: { transactionHash: TX, blockNumber: 10n },
    success: true,
    actualGasCost: 1000n,
  };
}

function timeout() {
  return new WaitForUserOperationReceiptTimeoutError({ hash: UOH });
}

const mockPermit = vi.mocked(signUsdcPermit);
const mockPrepare = vi.mocked(prepareAndSignCircleUserOp);
const mockBroadcast = vi.mocked(broadcastCircleUserOp);
const mockWait = vi.mocked(waitForCircleReceipt);

let clock = 1_000;
const now = () => clock++;

function run(overrides: Partial<Parameters<typeof executeCirclePayment>[0]> = {}) {
  return executeCirclePayment({
    bundle: fakeBundle,
    publicClient: {} as never,
    walletClient: {} as never,
    owner: OWNER,
    calls: CALLS,
    permitAmount: 5_000_000n,
    paymentAttemptId: 'attempt-1',
    now,
    ...overrides,
  });
}

function happyMocks() {
  mockPermit.mockResolvedValue({ paymasterData: '0xpm' as Hex, permitSignature: PERMIT_SIG });
  mockPrepare.mockResolvedValue({ signedUserOp: SIGNED_OP, userOpHash: UOH });
  mockBroadcast.mockResolvedValue(UOH);
  mockWait.mockResolvedValue(receipt() as never);
}

beforeEach(() => {
  window.localStorage.clear();
  clock = 1_000;
  mockPermit.mockReset();
  mockPrepare.mockReset();
  mockBroadcast.mockReset();
  mockWait.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('happy path', () => {
  it('permit→sign→broadcast→confirm で confirmed 結果 + record=confirmed', async () => {
    happyMocks();
    const res = await run();
    expect(res.userOpHash).toBe(UOH);
    expect(res.txHash).toBe(TX);
    expect(res.success).toBe(true);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);

    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: 'attempt-1',
      callHash: computeCallHash(CALLS),
    });
    expect(loadPendingRecord(key)?.status).toBe('confirmed');
    expect(loadPendingRecord(key)?.txHash).toBe(TX);
  });

  it('署名済 op は broadcast 前に永続される (signed 経由)', async () => {
    happyMocks();
    // broadcast の瞬間に record が submitting + signedUserOp を持つことを確認
    mockBroadcast.mockImplementation(async () => {
      const key = computeIdempotencyKey({
        chainId: CHAIN_ID,
        sender: OWNER,
        paymentAttemptId: 'attempt-1',
        callHash: computeCallHash(CALLS),
      });
      const rec = loadPendingRecord(key);
      expect(rec?.status).toBe('submitting');
      expect(rec?.signedUserOp).toEqual(SIGNED_OP);
      expect(rec?.userOpHash).toBe(UOH);
      return UOH;
    });
    await run();
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });
});

describe('署名拒否 (pre-submit) は abandon', () => {
  it('permit 署名で reject → abandoned + broadcast せず', async () => {
    mockPermit.mockRejectedValue(new Error('user rejected'));
    await expect(run()).rejects.toThrow('user rejected');
    expect(mockBroadcast).not.toHaveBeenCalled();
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: 'attempt-1',
      callHash: computeCallHash(CALLS),
    });
    expect(loadPendingRecord(key)?.status).toBe('abandoned');
  });

  it('UserOp 署名で reject → abandoned', async () => {
    mockPermit.mockResolvedValue({ paymasterData: '0xpm' as Hex, permitSignature: PERMIT_SIG });
    mockPrepare.mockRejectedValue(new Error('popup2 rejected'));
    await expect(run()).rejects.toThrow('popup2 rejected');
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('応答ロスト recovery (二重決済防止の要)', () => {
  it('broadcast が throw しても op が included なら再 broadcast せず confirmed', async () => {
    mockPermit.mockResolvedValue({ paymasterData: '0xpm' as Hex, permitSignature: PERMIT_SIG });
    mockPrepare.mockResolvedValue({ signedUserOp: SIGNED_OP, userOpHash: UOH });
    mockBroadcast.mockRejectedValueOnce(new Error('socket hang up')); // 応答ロスト
    mockWait.mockResolvedValue(receipt() as never); // 実は included していた

    const res = await run();
    expect(res.txHash).toBe(TX);
    // 最初の (失敗した) broadcast のみ。included 済なので rebroadcast しない。
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('broadcast 不達 (op が mempool に無い) → 同一 op を冪等 rebroadcast して confirmed', async () => {
    mockPermit.mockResolvedValue({ paymasterData: '0xpm' as Hex, permitSignature: PERMIT_SIG });
    mockPrepare.mockResolvedValue({ signedUserOp: SIGNED_OP, userOpHash: UOH });
    mockBroadcast.mockRejectedValueOnce(new Error('socket hang up')); // 1 回目不達
    mockBroadcast.mockResolvedValueOnce(UOH); // rebroadcast 成功
    mockWait.mockRejectedValueOnce(timeout()); // recovery wait #1: まだ included でない
    mockWait.mockResolvedValueOnce(receipt() as never); // rebroadcast 後 confirmed

    const res = await run();
    expect(res.txHash).toBe(TX);
    expect(mockBroadcast).toHaveBeenCalledTimes(2); // 同一署名 op を rebroadcast
  });

  it('confirm できないまま timeout → CirclePendingError、record は submitting 維持', async () => {
    mockPermit.mockResolvedValue({ paymasterData: '0xpm' as Hex, permitSignature: PERMIT_SIG });
    mockPrepare.mockResolvedValue({ signedUserOp: SIGNED_OP, userOpHash: UOH });
    mockBroadcast.mockResolvedValue(UOH);
    mockWait.mockRejectedValue(timeout()); // ずっと未 included

    await expect(run()).rejects.toBeInstanceOf(CirclePendingError);
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: 'attempt-1',
      callHash: computeCallHash(CALLS),
    });
    const rec = loadPendingRecord(key);
    expect(rec?.status).toBe('submitting'); // failed にしない (included しうる)
    expect(rec?.signedUserOp).toEqual(SIGNED_OP); // 復旧情報を保持
  });
});

describe('cross-invocation recovery (reload / 再クリック)', () => {
  it('同一 callHash の submitting 宙吊りがあれば新規署名せず recover する', async () => {
    // 1 回目: pending のまま submitting で宙吊りにする
    mockPermit.mockResolvedValue({ paymasterData: '0xpm' as Hex, permitSignature: PERMIT_SIG });
    mockPrepare.mockResolvedValue({ signedUserOp: SIGNED_OP, userOpHash: UOH });
    mockBroadcast.mockResolvedValue(UOH);
    mockWait.mockRejectedValue(timeout());
    await expect(run()).rejects.toBeInstanceOf(CirclePendingError);
    expect(findRecoverable({ sender: OWNER, chainId: CHAIN_ID })).toHaveLength(1);

    // 2 回目 (別 attemptId = ユーザの再クリック相当)。今度は included。
    mockPermit.mockClear();
    mockPrepare.mockClear();
    mockBroadcast.mockClear();
    mockWait.mockReset();
    mockWait.mockResolvedValue(receipt() as never);

    const res = await run({ paymentAttemptId: 'attempt-2' });
    expect(res.txHash).toBe(TX);
    // 新規署名・新規 UserOp を作っていない (二重決済防止)
    expect(mockPermit).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });
});

describe('同一 attemptId の resume', () => {
  it('confirmed 済キーを再実行しても再署名せず結果を返す', async () => {
    happyMocks();
    await run();
    mockPermit.mockClear();
    mockPrepare.mockClear();
    mockWait.mockClear();
    mockWait.mockResolvedValue(receipt() as never);

    const res = await run(); // 同一 attempt-1
    expect(res.txHash).toBe(TX);
    expect(mockPermit).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });
});
