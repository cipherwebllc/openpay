import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { getAddress, RpcRequestError, type Address, type Hex } from 'viem';
import { WaitForUserOperationReceiptTimeoutError } from 'viem/account-abstraction';

// circleAccount の I/O primitive (chain 通信 / 署名) は mock し、circleSend の
// FSM + recovery ロジックを実 store (jsdom localStorage) 上で検証する。
vi.mock('@/lib/smartAccount/circleAccount', () => {
  const broadcastCircleUserOp = vi.fn();
  return {
    signUsdcPermit: vi.fn(),
    prepareAndSignCircleUserOp: vi.fn(),
    broadcastCircleUserOp,
    // 自分の最初の送信は「用意 (prepareCircleBroadcast・submitting の前) → 返った関数で送る」の 2 段 (PR-39b)。本物の
    // broadcastCircleUserOp は同じ用意と送信を続けて行うだけなので、偽物も同じ mock に流す: 最初の送信も復旧の送り直しも
    // mockBroadcast (呼び出しの引数は { bundle, signedUserOp }) で見る。
    prepareCircleBroadcast: vi.fn(
      (bundle: unknown) => (signedUserOp: unknown) => broadcastCircleUserOp({ bundle, signedUserOp }),
    ),
    waitForCircleReceipt: vi.fn(),
    // 最初の送信の検証拒否で閉じる前に、bundler にその op の状態を聞く (PR #1084)。既定の答えは下の beforeEach (not_found)。
    readCircleUserOpStatus: vi.fn(),
  };
});

import {
  signUsdcPermit,
  prepareAndSignCircleUserOp,
  broadcastCircleUserOp,
  prepareCircleBroadcast,
  readCircleUserOpStatus,
  waitForCircleReceipt,
  type CircleSmartAccountBundle,
} from '@/lib/smartAccount/circleAccount';
import {
  executeCirclePayment,
  CirclePendingError,
  CircleSendRejectedError,
  REJECTION_CLOSE_WINDOW_MS,
  redactLongHex,
} from '@/lib/smartAccount/circleSend';
import {
  computeCallHash,
  computeIdempotencyKey,
  findRecoverable,
  loadPendingRecord,
  reserveOrResume,
  markAwaitingSignature,
  markSigned,
  markSubmitting,
  markConfirmed,
  markRejected,
  markResending,
  abandon,
  PENDING_KEY_PREFIX,
  PendingStateError,
  type PendingStatus,
} from '@/lib/circlePending';
import { logger } from '@/lib/logger';
import jaMessages from '@/messages/ja.json';

// 本物の circleAccount の、送信の error の class と分類 (I/O ではない部分)。H-X の test が、本物と同じ error を作るのに使う。
const actualCircleAccount = await vi.importActual<
  typeof import('@/lib/smartAccount/circleAccount')
>('@/lib/smartAccount/circleAccount');

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const PAYMASTER = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966');
const MERCHANT = getAddress('0x4444444444444444444444444444444444444444');
const CHAIN_ID = 421614;
const UOH = '0xabc0000000000000000000000000000000000000000000000000000000000001' as Hex;
const TX = '0xdef0000000000000000000000000000000000000000000000000000000000002' as Hex;

const CALLS = [{ to: MERCHANT, data: '0xabcd' as Hex }];
const SIGNED_OP = { sender: OWNER, nonce: '0x0', signature: '0x' + 'ab'.repeat(65) };
const PERMIT_SIG = ('0x' + 'cd'.repeat(65)) as Hex;

// confirmed の記録の結果を返すとき、circleSend は bundler に receipt を 1 回だけ照会する (bundlerClient.getUserOperationReceipt)。
// bundle は呼び出し側が渡す RPC の client なので、ここも境界の偽物。既定は「receipt がある」。
const mockLookup = vi.fn();

const fakeBundle = {
  provider: 'circle',
  entryPointVersion: '0.8',
  chainId: CHAIN_ID,
  paymasterAddress: PAYMASTER,
  account: {},
  bundlerClient: {
    getUserOperationReceipt: (args: { hash: Hex }) => mockLookup(args),
  },
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
const mockStatus = vi.mocked(readCircleUserOpStatus);

let clock = 1_000;
const now = () => clock++;

// 場面の符号 (第 10 回レビュー PR-39c)。run() が確認待ち (CirclePendingError) で終わるたびに、その error の circleCode を
// ここに積む。各 test の後 (下の afterEach) で「'unconfirmed' 以外が残っていない」ことを確かめる = 明示していない確認待ちは
// すべて (a)。(a) 以外を期待する test は、takePendingCodes() で取り出して、その場で確かめる:
//   (b) 'busy_elsewhere' = 別の試みが署名の途中 (scan の直近の pre-submit)。
//   (e) 'unconfirmed_earlier' = scan が別の key の submitting の記録に当たり、対応を付け替えないまま確認待ちで終わった
//       (run() は既定で adoptAttempt を渡さないので、その枝の確認待ちは (e)。付け替えた呼び出しは (a))。
const pendingCodes: unknown[] = [];
const takePendingCodes = () => pendingCodes.splice(0);

function run(overrides: Partial<Parameters<typeof executeCirclePayment>[0]> = {}) {
  const attempt = executeCirclePayment({
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
  // 見るだけ (返す promise は元のまま = test の側の rejects・catch は今までどおり)。
  attempt.catch((error: unknown) => {
    if (error instanceof CirclePendingError) pendingCodes.push(error.circleCode);
  });
  return attempt;
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
  pendingCodes.length = 0;
  mockPermit.mockReset();
  mockPrepare.mockReset();
  mockBroadcast.mockReset();
  mockWait.mockReset();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue(receipt());
  // bundler は、聞かれた hash を「知らない」と答える (検証で拒否した op を一度も受理していない)。
  mockStatus.mockReset();
  mockStatus.mockResolvedValue({ unknownToBundler: true, status: 'not_found' });
});

afterEach(() => {
  window.localStorage.clear();
  // 確認待ちで終わった押下は、(b)・(e) を期待する test が取り出した分を除いて、すべて (a) 'unconfirmed'。
  expect(pendingCodes.filter((code) => code !== 'unconfirmed')).toEqual([]);
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

  // A8: markSubmitting (broadcast_intent の永続) は **bundler 送信より前**。この順序が崩れると
  // 応答ロスト時に「送ったかもしれない op」が submitting として残らず、fallback/新規 op を
  // 許してしまう。下の「broadcast 前に永続される」テストは expect を mock 実装の中で投げるため、
  // 失敗しても circleSend の broadcast try-catch に飲まれて recovery 扱いになりうる (= 空虚に
  // pass しうる)。順序は値として持ち出して mock の外で検証する。
  it('broadcast 時点の record status は submitting (順序を mock 外で固定)', async () => {
    happyMocks();
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: 'attempt-1',
      callHash: computeCallHash(CALLS),
    });
    const statusAtBroadcast: Array<PendingStatus | undefined> = [];
    mockBroadcast.mockImplementation(async () => {
      statusAtBroadcast.push(loadPendingRecord(key)?.status);
      return UOH;
    });

    await run();

    expect(statusAtBroadcast).toEqual(['submitting']);
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

    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CirclePendingError);
    // 場面 (a) (第 10 回レビュー PR-39c): op を渡した後の確認待ち。文は messages/ja.json の CircleErrors と同じ。
    expect((error as CirclePendingError).circleCode).toBe('unconfirmed');
    expect(Object.hasOwn(error as object, 'circleCode')).toBe(true);
    expect((error as CirclePendingError).message).toBe(jaMessages.CircleErrors.unconfirmed);
    expect((error as CirclePendingError).userOpHash).toBe(UOH);
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

describe('A8: signed のまま中断した自 attempt の resume', () => {
  it('signed record を同一 attemptId で再開 → throw せず再署名して送信できる', async () => {
    happyMocks();
    const callHash = computeCallHash(CALLS);
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: 'attempt-1',
      callHash,
    });
    // markSigned と markSubmitting の間でタブが閉じた状態を再現する。
    reserveOrResume({
      key,
      chainId: CHAIN_ID,
      sender: OWNER,
      callHash,
      paymentAttemptId: 'attempt-1',
      paymaster: PAYMASTER,
      now: 900,
    });
    markAwaitingSignature({ key, sender: OWNER, now: 900 });
    markSigned({ key, sender: OWNER, signedUserOp: SIGNED_OP, userOpHash: UOH, now: 900 });
    expect(loadPendingRecord(key)?.status).toBe('signed');

    const res = await run(); // 同一 attempt-1 で再開
    expect(res.txHash).toBe(TX);
    expect(mockPermit).toHaveBeenCalled(); // 再署名した (未 broadcast なので安全)
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(loadPendingRecord(key)?.status).toBe('confirmed');
  });
});

describe('cross-invocation 二重決済ガード (別 attemptId・同 callHash)', () => {
  // 同一 callHash だが別 paymentAttemptId の record を任意状態で seed する
  // (別タブ/別デバイス/reload で paymentAttemptId が変わった他 attempt を模す)。
  function seedOtherAttempt(attemptId: string, status: PendingStatus, at: number) {
    const callHash = computeCallHash(CALLS);
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: attemptId,
      callHash,
    });
    reserveOrResume({
      key,
      chainId: CHAIN_ID,
      sender: OWNER,
      callHash,
      paymentAttemptId: attemptId,
      paymaster: PAYMASTER,
      now: at,
    });
    if (status === 'reserved') return key;
    markAwaitingSignature({ key, sender: OWNER, now: at });
    if (status === 'awaiting_signature') return key;
    markSigned({ key, sender: OWNER, signedUserOp: SIGNED_OP, userOpHash: UOH, now: at });
    if (status === 'signed') return key;
    markSubmitting({ key, sender: OWNER, now: at });
    if (status === 'submitting') return key;
    markConfirmed({ key, sender: OWNER, txHash: TX, success: true, now: at });
    return key;
  }

  it('別 attemptId が confirmed (同 callHash) → 新規署名せず prior 結果を返す (再決済防止)', async () => {
    happyMocks();
    seedOtherAttempt('other', 'confirmed', 500);
    const res = await run(); // attempt-1 (別 attemptId)
    expect(res.txHash).toBe(TX);
    expect(mockPermit).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  // 場面 (b) (第 10 回レビュー PR-39c): 確認待ちの error のうち、ここだけが「別のタブや画面で進行中」('busy_elsewhere')。
  // この押下は何も始めていない (署名を求めない・送らない) ので、「送信しましたが…」の文 (a) を出さない。
  it.each(['reserved', 'awaiting_signature', 'signed'] as const)(
    '別 attemptId が直近の %s (pre-submit) → CirclePendingError (場面 (b) = busy_elsewhere) で並行 broadcast しない',
    async (status) => {
      happyMocks();
      seedOtherAttempt('other', status, 900); // clock 開始 1000 に近い = 直近
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CirclePendingError);
      // hook が見る name は今までどおり (対応を残す)。
      expect((error as CirclePendingError).name).toBe('CirclePendingError');
      expect((error as CirclePendingError).circleCode).toBe('busy_elsewhere');
      expect(Object.hasOwn(error as object, 'circleCode')).toBe(true);
      expect((error as CirclePendingError).message).toBe(jaMessages.CircleErrors.busyElsewhere);
      expect(takePendingCodes()).toEqual(['busy_elsewhere']);
      expect(mockPermit).not.toHaveBeenCalled();
      expect(mockBroadcast).not.toHaveBeenCalled();
    },
  );

  it('別 attemptId が直近の submitting → recover (新規送信しない)', async () => {
    happyMocks();
    seedOtherAttempt('other', 'submitting', 900);
    const res = await run();
    expect(res.txHash).toBe(TX); // recoverSubmitting が wait→receipt で確定
    expect(mockPermit).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('stale な signed orphan (reload 放置) は abandon して新規送信できる', async () => {
    happyMocks();
    seedOtherAttempt('orphan', 'signed', 0); // updatedAt=0
    const res = await run({ now: () => 1_000_000 }); // 1e6 - 0 > 3min → stale
    expect(res.txHash).toBe(TX);
    expect(mockBroadcast).toHaveBeenCalledTimes(1); // 新規 broadcast に進んだ
    const orphanKey = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: 'orphan',
      callHash: computeCallHash(CALLS),
    });
    expect(loadPendingRecord(orphanKey)?.status).toBe('abandoned');
  });
});

describe('cross-invocation ガード — 時間窓 + status 優先 (再レビュー NEW-1/NEW-3)', () => {
  function seed(attemptId: string, status: PendingStatus, at: number) {
    const callHash = computeCallHash(CALLS);
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: attemptId,
      callHash,
    });
    reserveOrResume({
      key,
      chainId: CHAIN_ID,
      sender: OWNER,
      callHash,
      paymentAttemptId: attemptId,
      paymaster: PAYMASTER,
      now: at,
    });
    markAwaitingSignature({ key, sender: OWNER, now: at });
    markSigned({ key, sender: OWNER, signedUserOp: SIGNED_OP, userOpHash: UOH, now: at });
    if (status === 'signed') return key;
    markSubmitting({ key, sender: OWNER, now: at });
    markConfirmed({ key, sender: OWNER, txHash: TX, success: true, now: at });
    return key;
  }

  it('NEW-1: 窓を過ぎた古い confirmed (同 callHash) は正規リピートとして新規決済を通す', async () => {
    happyMocks();
    seed('old', 'confirmed', 0); // updatedAt=0
    // 1e6 - 0 > 90s 窓 → 古い confirmed → 抑止せず新規決済
    const res = await run({ now: () => 1_000_000 });
    expect(res.txHash).toBe(TX);
    expect(mockPermit).toHaveBeenCalled(); // 新規決済に進んだ
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('NEW-1: 窓内の confirmed (同 callHash) は偶発二重として既支払い結果を返す', async () => {
    happyMocks();
    seed('recent', 'confirmed', 990); // clock 1000 開始 → 直近
    const res = await run();
    expect(res.txHash).toBe(TX);
    expect(mockPermit).not.toHaveBeenCalled(); // 新規署名せず
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('NEW-3: confirmed と直近 pre-submit が混在しても confirmed を優先 (pre-submit に masked されない)', async () => {
    happyMocks();
    seed('conf', 'confirmed', 900); // 直近 confirmed
    seed('sig', 'signed', 950); // 直近 pre-submit (stale でない)
    const res = await run();
    // sort で confirmed が先に評価され既支払い結果を返す (CirclePendingError にならない)
    expect(res.txHash).toBe(TX);
    expect(mockPermit).not.toHaveBeenCalled();
  });
});

describe('A9: confirmed dedup は success:false を除外する (それ以外は dedup)', () => {
  function seedConfirmed(attemptId: string, success: boolean, at: number) {
    const callHash = computeCallHash(CALLS);
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: attemptId,
      callHash,
    });
    reserveOrResume({
      key,
      chainId: CHAIN_ID,
      sender: OWNER,
      callHash,
      paymentAttemptId: attemptId,
      paymaster: PAYMASTER,
      now: at,
    });
    markAwaitingSignature({ key, sender: OWNER, now: at });
    markSigned({ key, sender: OWNER, signedUserOp: SIGNED_OP, userOpHash: UOH, now: at });
    markSubmitting({ key, sender: OWNER, now: at });
    markConfirmed({ key, sender: OWNER, txHash: TX, success, now: at });
    return key;
  }

  it('窓内でも confirmed+success:false (revert 済) なら新規 UserOp を組む', async () => {
    happyMocks();
    seedConfirmed('reverted', false, 990); // clock 1000 開始 → 窓内
    const res = await run();
    expect(res.txHash).toBe(TX);
    expect(res.success).toBe(true);
    // revert 済は「支払い済み」ではない → 再試行を 90 秒ブロックしない。
    expect(mockPermit).toHaveBeenCalled();
    expect(mockPrepare).toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('窓内の confirmed+success:true は従来どおり既支払い結果を返す (回帰)', async () => {
    happyMocks();
    seedConfirmed('paid', true, 990);
    const res = await run();
    expect(res.txHash).toBe(TX);
    expect(mockPermit).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  // success を持たない旧 record は「revert と断定できない」= 支払い済みかもしれない。
  // dedup を外すと二重決済へ通してしまうので、除外するのは success:false のときだけ。
  it('success を持たない旧 confirmed record も窓内なら dedup する (新規 UserOp を組まない)', async () => {
    happyMocks();
    const key = seedConfirmed('legacy', true, 990);
    // 旧 record を再現: 永続済 record から success フィールドだけ落とす。
    const storageKey = PENDING_KEY_PREFIX + key;
    const raw = window.localStorage.getItem(storageKey);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    delete parsed.success;
    window.localStorage.setItem(storageKey, JSON.stringify(parsed));
    expect(loadPendingRecord(key)?.success).toBeUndefined();

    const res = await run();

    expect(res.txHash).toBe(TX);
    expect(mockPermit).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('housekeeping GC (#121): 別 callHash の低速 in-flight を巻き込まない', () => {
  // run() の CALLS とは別 callHash。guard (findLiveByCallHash) は別 callHash を見ないので、
  // この record に触れうるのは GC (全 callHash 横断) のみ → GC 閾値の挙動を単独で検証できる。
  const DIFF_CALLS = [{ to: MERCHANT, data: '0x9999' as Hex }];
  function seedDiff(attemptId: string, status: 'reserved' | 'awaiting_signature', at: number) {
    const callHash = computeCallHash(DIFF_CALLS);
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId: attemptId,
      callHash,
    });
    reserveOrResume({
      key,
      chainId: CHAIN_ID,
      sender: OWNER,
      callHash,
      paymentAttemptId: attemptId,
      paymaster: PAYMASTER,
      now: at,
    });
    if (status === 'awaiting_signature') {
      markAwaitingSignature({ key, sender: OWNER, now: at });
    }
    return key;
  }

  it('10分前の別 callHash pre-submit は新規決済時に GC されない (GC 閾値 1h ≫ guard 3min)', async () => {
    // HIGH 修正の回帰テスト: 別タブの低速だが正規な署名 (popup を 10 分開けっ放し) を、
    // 別決済の GC が abandon して壊さないこと。
    const slow = seedDiff('slow', 'awaiting_signature', 1_000);
    clock = 1_000 + 10 * 60 * 1000; // 10 分後
    happyMocks();
    await run(); // attempt-1 / CALLS (別 callHash)
    expect(loadPendingRecord(slow)?.status).toBe('awaiting_signature');
  });

  it('1時間超の別 callHash pre-submit 孤児は GC で abandoned (容量管理)', async () => {
    const orphan = seedDiff('orphan', 'reserved', 1_000);
    clock = 1_000 + 2 * 60 * 60 * 1000; // 2h 後
    happyMocks();
    await run();
    expect(loadPendingRecord(orphan)?.status).toBe('abandoned');
  });
});

// ---------------------------------------------------------------------------
// 第 10 回レビュー H-V: 画面を離れた (unmount した) 試み。hook が渡す isAlive が false になった試みは、新しい効果
// (ウォレットへの署名の要求・markSigned・markSubmitting・abandon・bundler への送信) を始めない。
//
// ここの circleAccount の偽物は「ウォレットと RPC」: RPC に当たる await の後に、本物と同じ位置で args.beforeSign を呼び
// (本物の位置は circleAccount.test.ts が固定する)、署名の要求を 1 つずつ積む。テストが要求ごとに承認・拒否する。
// 送信と receipt は op / hash ごとに分ける (どの試みの op を送ったかを引数で確かめる)。
// ---------------------------------------------------------------------------
describe('H-V: 画面を離れた試みは新しい効果を始めない', () => {
  type PermitResult = { paymasterData: Hex; permitSignature: Hex };
  type UserOpResult = { signedUserOp: Record<string, unknown>; userOpHash: Hex };
  type SignRequest<T> = {
    approve: (value: T) => void;
    reject: (error: Error) => void;
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // 試みの終わり方を、待たずに読めるようにする (署名の要求が残っている間は settle しない)。
  function track<T>(promise: Promise<T>) {
    const t: { settled: boolean; value?: T; error?: Error } = { settled: false };
    promise.then(
      (value) => {
        t.settled = true;
        t.value = value;
      },
      (error: Error) => {
        t.settled = true;
        t.error = error;
      },
    );
    return t;
  }

  // 溜まっている microtask を全部流す (署名の要求が出る・試みが終わる所まで進める)。
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  // ウォレットに出ている署名の要求 (出た順)。
  let permitRequests: Array<SignRequest<PermitResult>>;
  let userOpRequests: Array<SignRequest<UserOpResult> & { calls: unknown }>;
  // RPC に当たる await。既定は開いている。閉じた gate に差し替えると、開くまで署名の手前で待つ。
  let permitRpc: Promise<void>;
  let prepareRpc: Promise<void>;

  const PERMIT: PermitResult = { paymasterData: '0xpm' as Hex, permitSignature: PERMIT_SIG };

  // 試みごとに別の op・hash・tx (nonce の key が時刻由来で、別の試みの op は別物になる本番と同じ)。
  function op(byte: string) {
    return {
      signedUserOp: { sender: OWNER, nonce: `0x${byte}`, signature: '0x' + byte.repeat(65) },
      userOpHash: ('0x' + byte.repeat(32)) as Hex,
      txHash: ('0x' + byte.repeat(31) + 'ff') as Hex,
    };
  }
  const OP_A = op('a1');
  const OP_B = op('b2');
  const OP_X = op('c3');
  const OP_Y = op('d4');
  const OP_X2 = op('e5');
  const ALL_OPS = [OP_A, OP_B, OP_X, OP_Y, OP_X2];

  const sentOps = () => mockBroadcast.mock.calls.map((c) => c[0].signedUserOp);
  const waitedHashes = () => mockWait.mock.calls.map((c) => c[0].hash);

  function keyOf(calls: typeof CALLS, paymentAttemptId: string) {
    return computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId,
      callHash: computeCallHash(calls),
    });
  }
  const KEY = keyOf(CALLS, 'attempt-1');

  const infoSpy = vi.spyOn(logger, 'info');

  beforeEach(() => {
    permitRequests = [];
    userOpRequests = [];
    permitRpc = Promise.resolve();
    prepareRpc = Promise.resolve();
    mockPermit.mockImplementation(async (args) => {
      await permitRpc; // permit の domain・nonce の読み取りに当たる
      args.beforeSign?.();
      const d = deferred<PermitResult>();
      permitRequests.push({ approve: d.resolve, reject: d.reject });
      return d.promise;
    });
    mockPrepare.mockImplementation(async (args) => {
      await prepareRpc; // ガス価格・prepareUserOperation に当たる
      args.beforeSign?.();
      const d = deferred<UserOpResult>();
      userOpRequests.push({ approve: d.resolve, reject: d.reject, calls: args.calls });
      return d.promise;
    });
    // bundler は渡された op の hash を返し、receipt は hash ごとの tx を返す。
    mockBroadcast.mockImplementation(async ({ signedUserOp }) => {
      const found = ALL_OPS.find((o) => o.signedUserOp === signedUserOp);
      if (!found) throw new Error('test: 知らない op が送られた');
      return found.userOpHash;
    });
    mockWait.mockImplementation(async ({ hash }) => {
      const found = ALL_OPS.find((o) => o.userOpHash === hash);
      if (!found) throw new Error(`test: 知らない hash の receipt を待った ${hash}`);
      return {
        receipt: { transactionHash: found.txHash, blockNumber: 10n },
        success: true,
        actualGasCost: 1000n,
      } as never;
    });
    infoSpy.mockClear();
  });

  // 試みを始め、署名 2 (UserOperation) の要求がウォレットに出る所まで進める。
  async function startUntilUserOpRequest(
    overrides: Partial<Parameters<typeof executeCirclePayment>[0]>,
  ) {
    const permitIndex = permitRequests.length;
    const userOpIndex = userOpRequests.length;
    const attempt = track(run(overrides));
    await flush();
    expect(permitRequests).toHaveLength(permitIndex + 1);
    permitRequests[permitIndex].approve(PERMIT);
    await flush();
    expect(userOpRequests).toHaveLength(userOpIndex + 1);
    return { attempt, userOpRequest: userOpRequests[userOpIndex] };
  }

  describe('(a)(b) 失効した試みはウォレットに署名を求めない', () => {
    it('署名 1 の前の RPC を待つ間に失効 → 署名 1 を求めない・記録は awaiting_signature のまま', async () => {
      const rpc = deferred<void>();
      permitRpc = rpc.promise;
      const screen = { alive: true };
      const attempt = track(run({ isAlive: () => screen.alive }));
      await flush();
      expect(mockPermit).toHaveBeenCalledTimes(1); // RPC を待っている
      expect(attempt.settled).toBe(false);

      screen.alive = false; // 画面を離れる
      rpc.resolve();
      await flush();

      expect(permitRequests).toHaveLength(0);
      expect(attempt.error?.message).toBe('payment_cancelled');
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockBroadcast).not.toHaveBeenCalled();
      expect(loadPendingRecord(KEY)?.status).toBe('awaiting_signature');
    });

    it('署名 1 の承認の後、準備の RPC を待つ間に失効 → 署名 2 を求めない・記録は awaiting_signature のまま', async () => {
      const rpc = deferred<void>();
      prepareRpc = rpc.promise;
      const screen = { alive: true };
      const attempt = track(run({ isAlive: () => screen.alive }));
      await flush();
      permitRequests[0].approve(PERMIT);
      await flush();
      expect(mockPrepare).toHaveBeenCalledTimes(1); // 準備の RPC を待っている
      expect(attempt.settled).toBe(false);

      screen.alive = false;
      rpc.resolve();
      await flush();

      expect(userOpRequests).toHaveLength(0);
      expect(attempt.error?.message).toBe('payment_cancelled');
      expect(mockBroadcast).not.toHaveBeenCalled();
      expect(loadPendingRecord(KEY)?.status).toBe('awaiting_signature');
    });

    it('画面がある試みは、同じ偽物のウォレットで今までどおり払い終える (beforeSign は止めない)', async () => {
      const { attempt, userOpRequest } = await startUntilUserOpRequest({ isAlive: () => true });
      userOpRequest.approve(OP_A);
      await flush();

      expect(attempt.value).toMatchObject({ userOpHash: OP_A.userOpHash, txHash: OP_A.txHash, success: true });
      expect(sentOps()).toEqual([OP_A.signedUserOp]);
      expect(loadPendingRecord(KEY)?.status).toBe('confirmed');
      expect(infoSpy).not.toHaveBeenCalledWith('circle.sign_abandoned', expect.anything());
    });
  });

  describe('(c) 失効した試みは、署名 2 が返っても保存も送信もしない', () => {
    it('署名 2 を待つ間に失効 → 承認しても markSigned も broadcast も起きない・log を 1 行', async () => {
      const screen = { alive: true };
      const { attempt, userOpRequest } = await startUntilUserOpRequest({ isAlive: () => screen.alive });

      screen.alive = false;
      userOpRequest.approve(OP_A);
      await flush();

      expect(attempt.error?.message).toBe('payment_cancelled');
      expect(mockBroadcast).not.toHaveBeenCalled();
      expect(mockWait).not.toHaveBeenCalled();
      const record = loadPendingRecord(KEY);
      expect(record?.status).toBe('awaiting_signature');
      // 署名済みの op を記録に残していない (残すと、次の resume・別の試みの復旧がこの op を送りうる)。
      expect(record?.signedUserOp).toBeUndefined();
      expect(record?.userOpHash).toBeUndefined();
      expect(infoSpy).toHaveBeenCalledWith('circle.sign_abandoned', {
        chainId: CHAIN_ID,
        userOpHash: OP_A.userOpHash,
      });
    });
  });

  describe('(d) 失効した試みは、拒否・失敗でも abandon しない', () => {
    it('失効の後に署名 1 が拒否 → abandoned にならない・元の error でなく payment_cancelled', async () => {
      const screen = { alive: true };
      const attempt = track(run({ isAlive: () => screen.alive }));
      await flush();

      screen.alive = false;
      permitRequests[0].reject(new Error('user rejected'));
      await flush();

      expect(attempt.error?.message).toBe('payment_cancelled');
      expect(loadPendingRecord(KEY)?.status).toBe('awaiting_signature');
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it('失効の後に署名 2 が拒否 → abandoned にならない・元の error でなく payment_cancelled', async () => {
      const screen = { alive: true };
      const { attempt, userOpRequest } = await startUntilUserOpRequest({ isAlive: () => screen.alive });

      screen.alive = false;
      userOpRequest.reject(new Error('popup2 rejected'));
      await flush();

      expect(attempt.error?.message).toBe('payment_cancelled');
      expect(loadPendingRecord(KEY)?.status).toBe('awaiting_signature');
      expect(mockBroadcast).not.toHaveBeenCalled();
      // 拒否は「返った署名を捨てた」ではない。
      expect(infoSpy).not.toHaveBeenCalledWith('circle.sign_abandoned', expect.anything());
    });

    it('画面がある試みの拒否は今までどおり: 署名 1 → abandoned・元の error', async () => {
      const attempt = track(run({ isAlive: () => true }));
      await flush();
      permitRequests[0].reject(new Error('user rejected'));
      await flush();

      expect(attempt.error?.message).toBe('user rejected');
      expect(loadPendingRecord(KEY)?.status).toBe('abandoned');
    });

    it('画面がある試みの拒否は今までどおり: 署名 2 → abandoned・元の error', async () => {
      const { attempt, userOpRequest } = await startUntilUserOpRequest({ isAlive: () => true });
      userOpRequest.reject(new Error('popup2 rejected'));
      await flush();

      expect(attempt.error?.message).toBe('popup2 rejected');
      expect(loadPendingRecord(KEY)?.status).toBe('abandoned');
    });
  });

  // (iii) 同じタブ・内容が違う: 画面 A (内容 X) が署名 2 を待つ間に離れ、開き直した画面 B で内容 Y を払う。ウォレットに残った
  // A の要求を承認すると、直す前は A が X の op を保存して送った (key も scan も別なので止める所が無い = X と Y の両方が払われる)。
  describe('(iii) の再現: 内容の違う支払いを開き直した画面で済ませた後、古い署名の要求を承認する', () => {
    const CALLS_X = [{ to: MERCHANT, data: '0x1111' as Hex }];
    const CALLS_Y = [{ to: MERCHANT, data: '0x2222' as Hex }];
    const KEY_X = keyOf(CALLS_X, 'attempt-x');
    const KEY_Y = keyOf(CALLS_Y, 'attempt-y');

    // A (内容 X) が署名 2 を待つ → 画面を離れる → B (内容 Y) が払い終える → 残っていた A の要求を承認する。
    async function leaveXThenPayYThenApproveX() {
      const screenA = { alive: true };
      const a = await startUntilUserOpRequest({
        calls: CALLS_X,
        paymentAttemptId: 'attempt-x',
        isAlive: () => screenA.alive,
      });
      expect(a.userOpRequest.calls).toBe(CALLS_X);
      screenA.alive = false;

      const b = await startUntilUserOpRequest({
        calls: CALLS_Y,
        paymentAttemptId: 'attempt-y',
        isAlive: () => true,
      });
      expect(b.userOpRequest.calls).toBe(CALLS_Y);
      b.userOpRequest.approve(OP_Y);
      await flush();
      expect(b.attempt.value).toMatchObject({ userOpHash: OP_Y.userOpHash, txHash: OP_Y.txHash, success: true });

      a.userOpRequest.approve(OP_X);
      await flush();
      return { a, b };
    }

    it('X の op は送られない (送ったのは Y の op だけ)・X の記録は awaiting_signature のまま', async () => {
      const { a } = await leaveXThenPayYThenApproveX();

      expect(a.attempt.error?.message).toBe('payment_cancelled');
      expect(sentOps()).toEqual([OP_Y.signedUserOp]);
      expect(waitedHashes()).toEqual([OP_Y.userOpHash]);
      expect(loadPendingRecord(KEY_X)?.status).toBe('awaiting_signature');
      expect(loadPendingRecord(KEY_X)?.signedUserOp).toBeUndefined();
      expect(loadPendingRecord(KEY_Y)?.status).toBe('confirmed');
      expect(loadPendingRecord(KEY_Y)?.userOpHash).toBe(OP_Y.userOpHash);
    });

    it('その後、同じタブで X を押し直すと、残った記録を resume して払える (詰まない)', async () => {
      await leaveXThenPayYThenApproveX();

      // 同じタブ・同じ内容 = sessionStorage の対応が残っていて、同じ attemptId (同じ key) になる。
      const c = await startUntilUserOpRequest({
        calls: CALLS_X,
        paymentAttemptId: 'attempt-x',
        isAlive: () => true,
      });
      c.userOpRequest.approve(OP_X2);
      await flush();

      expect(c.attempt.value).toMatchObject({ userOpHash: OP_X2.userOpHash, txHash: OP_X2.txHash, success: true });
      // 送ったのは Y と、押し直しの X の op。離れた画面の X の op (OP_X) は最後まで送られない。
      expect(sentOps()).toEqual([OP_Y.signedUserOp, OP_X2.signedUserOp]);
      expect(loadPendingRecord(KEY_X)?.status).toBe('confirmed');
      expect(loadPendingRecord(KEY_X)?.userOpHash).toBe(OP_X2.userOpHash);
    });
  });

  // (ii) 同じタブ・同じ内容: 開き直した画面 B は A と同じ key の記録を resume して、同じ署名の要求を出す。直す前は、A の要求を
  // 先に承認すると A が送り、B は markSigned の CAS で PendingStateError (払えているのに失敗と出る)。A の要求を拒否すると、
  // A の abandon が B の記録 (同じ key) を abandoned にし、B も失敗になった。
  describe('(ii) の再現: 同じ内容・同じ key を開き直した画面が resume している間に、古い署名の要求に答える', () => {
    // A が署名 2 を待つ → 画面を離れる → B (同じ attemptId) が resume して署名 2 を待つ。
    async function leaveThenResume() {
      const screenA = { alive: true };
      const a = await startUntilUserOpRequest({ isAlive: () => screenA.alive });
      screenA.alive = false;
      const b = await startUntilUserOpRequest({ isAlive: () => true });
      expect(loadPendingRecord(KEY)?.status).toBe('awaiting_signature');
      return { a, b };
    }

    it('A の要求を承認しても何も起きず、B が自分の op を 1 本だけ送って成功する', async () => {
      const { a, b } = await leaveThenResume();

      a.userOpRequest.approve(OP_A);
      await flush();
      expect(a.attempt.error?.message).toBe('payment_cancelled');
      expect(mockBroadcast).not.toHaveBeenCalled();
      expect(loadPendingRecord(KEY)?.status).toBe('awaiting_signature');
      expect(b.attempt.settled).toBe(false);

      b.userOpRequest.approve(OP_B);
      await flush();
      expect(b.attempt.value).toMatchObject({ userOpHash: OP_B.userOpHash, txHash: OP_B.txHash, success: true });
      expect(sentOps()).toEqual([OP_B.signedUserOp]);
      expect(waitedHashes()).toEqual([OP_B.userOpHash]);
      const record = loadPendingRecord(KEY);
      expect(record?.status).toBe('confirmed');
      expect(record?.userOpHash).toBe(OP_B.userOpHash);
      expect(record?.signedUserOp).toEqual(OP_B.signedUserOp);
    });

    it('A の要求を拒否しても B の記録は生きていて、B は払い終える', async () => {
      const { a, b } = await leaveThenResume();

      a.userOpRequest.reject(new Error('popup2 rejected'));
      await flush();
      expect(a.attempt.error?.message).toBe('payment_cancelled');
      expect(loadPendingRecord(KEY)?.status).toBe('awaiting_signature');
      expect(b.attempt.settled).toBe(false);

      b.userOpRequest.approve(OP_B);
      await flush();
      expect(b.attempt.value).toMatchObject({ userOpHash: OP_B.userOpHash, txHash: OP_B.txHash, success: true });
      expect(sentOps()).toEqual([OP_B.signedUserOp]);
      expect(loadPendingRecord(KEY)?.status).toBe('confirmed');
    });
  });
});

// ---------------------------------------------------------------------------
// 第 10 回レビュー H-W・H-Y: op を bundler に渡した (かもしれない) 後の終わり方。
//
// hook は、CirclePendingError と storage の失敗 (PendingStoreUnavailableError・PendingStoreWriteError) 以外の error で attemptId の
// 対応を消す (次の押下は新しい key = 新しい支払い)。なので、送った後に
// ふつうの error で終わると、後から確定した前の支払いの後に 2 本目が開く。直した後の終わり方は 4 つだけ:
//   結果 / CirclePendingError (確認待ち) / まだ渡していない試みの「既に終了」/ 自分の最初の送信を bundler が検証で拒否し、
//   記録を failed に閉じた CircleSendRejectedError (H-X・下の「H-X」の describe。閉じる条件は lib/smartAccount/circleSend.ts の冒頭)。
//
// ここの偽物は bundler とウォレットだけ (circleAccount の 4 つ + bundle の receipt の照会)。記録は本物 (jsdom の localStorage)。
// 送った後の区間は境界 (inPostSubmit) の中なので、**偽物の中で expect しない** (落ちても CirclePendingError に吸われる)。
// 送った op・待った hash・その時点の記録は、値として外に持ち出して確かめる。時計 (now) は呼ぶたびに進む。
// ---------------------------------------------------------------------------
describe('H-W・H-Y: 送った後の終わり方', () => {
  const ENDED =
    'この支払いの試みは既に終了しています。この試みでは送金していません。もう一度押すと、新しい支払いとして始めます。';
  const PERMIT = { paymasterData: '0xpm' as Hex, permitSignature: PERMIT_SIG };

  // 試みごとに別の op・hash・tx。
  function op(byte: string) {
    return {
      signedUserOp: { sender: OWNER, nonce: `0x${byte}`, signature: '0x' + byte.repeat(65) },
      userOpHash: ('0x' + byte.repeat(32)) as Hex,
      txHash: ('0x' + byte.repeat(31) + 'ff') as Hex,
    };
  }
  type Op = ReturnType<typeof op>;
  const OP1 = op('11');
  const OP2 = op('22');

  function receiptOf(o: Op, success = true) {
    return {
      receipt: { transactionHash: o.txHash, blockNumber: 10n },
      success,
      actualGasCost: 1000n,
    } as never;
  }
  const timeoutOf = (o: Op) => new WaitForUserOperationReceiptTimeoutError({ hash: o.userOpHash });
  // 待ち・照会そのものの失敗 (bundler の 5xx。viem の transport が再試行した後に投げる)。
  const rpcDown = () => new Error('HTTP request failed. Status: 503');

  const sentOps = () => mockBroadcast.mock.calls.map((c) => c[0].signedUserOp);
  const waitedHashes = () => mockWait.mock.calls.map((c) => c[0].hash);
  const lookedUpHashes = () => mockLookup.mock.calls.map((c) => (c[0] as { hash: Hex }).hash);

  function keyOf(paymentAttemptId: string) {
    return computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: OWNER,
      paymentAttemptId,
      callHash: computeCallHash(CALLS),
    });
  }
  const KEY = keyOf('attempt-1');
  const stored = (key = KEY) => loadPendingRecord(key);

  // 記録を、指定した状態まで本物の遷移で進める。
  function seed(
    status: 'awaiting_signature' | 'signed' | 'submitting' | 'confirmed',
    opts: { attemptId?: string; at?: number; o?: Op; success?: boolean } = {},
  ) {
    const { attemptId = 'attempt-1', at = 900, o = OP1, success = true } = opts;
    const callHash = computeCallHash(CALLS);
    const key = keyOf(attemptId);
    reserveOrResume({
      key,
      chainId: CHAIN_ID,
      sender: OWNER,
      callHash,
      paymentAttemptId: attemptId,
      paymaster: PAYMASTER,
      now: at,
    });
    markAwaitingSignature({ key, sender: OWNER, now: at });
    if (status === 'awaiting_signature') return key;
    markSigned({ key, sender: OWNER, signedUserOp: o.signedUserOp, userOpHash: o.userOpHash, now: at });
    if (status === 'signed') return key;
    markSubmitting({ key, sender: OWNER, now: at });
    if (status === 'submitting') return key;
    markConfirmed({ key, sender: OWNER, txHash: o.txHash, success, now: at });
    return key;
  }

  // 保存済みの記録を直接書き換える (本物の遷移では作れない状態: failed・別の op の記録への差し替え)。
  function rewrite(key: string, patch: Record<string, unknown>) {
    const storageKey = PENDING_KEY_PREFIX + key;
    const parsed = JSON.parse(window.localStorage.getItem(storageKey)!) as Record<string, unknown>;
    window.localStorage.setItem(storageKey, JSON.stringify({ ...parsed, ...patch }));
  }
  const remove = (key: string) => window.localStorage.removeItem(PENDING_KEY_PREFIX + key);

  // ウォレットは署名 1・署名 2 を承認し、署名 2 は o の op を返す。
  function walletSigns(o: Op) {
    mockPermit.mockResolvedValue(PERMIT);
    mockPrepare.mockResolvedValue({ signedUserOp: o.signedUserOp, userOpHash: o.userOpHash });
  }

  // storage を壊す spy。試験の途中で戻す (返り値の mockRestore) ほか、afterEach でも必ず戻す。
  let storageSpies: Array<{ mockRestore: () => void }>;
  // localStorage を読めなくする (記録の読み取りが PendingStoreUnavailableError になる)。
  function breakStorageReads() {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is not available');
    });
    storageSpies.push(spy);
    return spy;
  }
  // 指定した status の記録だけ書けなくする (quota)。
  function failWritesOf(status: PendingStatus) {
    const realSetItem = Storage.prototype.setItem;
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, k: string, v: string) {
        if (k.startsWith(PENDING_KEY_PREFIX) && (JSON.parse(v) as { status: string }).status === status) {
          throw new Error('QuotaExceededError');
        }
        realSetItem.call(this, k, v);
      });
    storageSpies.push(spy);
    return spy;
  }

  // 終わり方を、error の種類ごと取り出す。
  async function outcome(promise: Promise<unknown>) {
    try {
      return { value: (await promise) as Awaited<ReturnType<typeof run>>, error: undefined };
    } catch (error) {
      return { value: undefined, error: error as Error & { userOpHash?: Hex; circleCode?: string } };
    }
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }
  function track<T>(promise: Promise<T>) {
    const t: { settled: boolean; value?: T; error?: Error } = { settled: false };
    promise.then(
      (value) => {
        t.settled = true;
        t.value = value;
      },
      (error: Error) => {
        t.settled = true;
        t.error = error;
      },
    );
    return t;
  }
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  let warnSpy: MockInstance<typeof logger.warn>;
  let errorSpy: MockInstance<typeof logger.error>;
  const loggedErrors = () => errorSpy.mock.calls.map((c) => c[0]);
  const loggedWarns = () => warnSpy.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    storageSpies = [];
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    // bundler は渡された op の hash を返す。receipt の照会は、hash ごとの receipt を返す (既定)。
    mockBroadcast.mockImplementation(async ({ signedUserOp }) =>
      signedUserOp === OP2.signedUserOp ? OP2.userOpHash : OP1.userOpHash,
    );
    mockLookup.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash === OP2.userOpHash ? OP2 : OP1),
    );
  });

  afterEach(() => {
    for (const spy of storageSpies) spy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // H-W: 復旧の送り直しと、ほかの試みの confirmed が競う。
  // 直す前: 送り直しの **後** に markSubmitting で時刻を書いていたので、その間に記録が confirmed になっていると
  // PendingStateError (内部の error) で終わり、hook が対応を消した。
  // -------------------------------------------------------------------------
  describe('H-W: 復旧の送り直しの前に記録を確かめる', () => {
    it('resume: 最初の待ちの間に元の試みが confirmed にした → 送り直さず、既払いの結果を返す', async () => {
      const key = seed('submitting', { at: 900 });
      mockWait.mockImplementationOnce(async () => {
        // 自分の送信の receipt を待っていた元の試みが、この待ちの間に確定を書く。
        markConfirmed({ key, sender: OWNER, txHash: OP1.txHash, success: true, now: now() });
        throw timeoutOf(OP1);
      });

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(sentOps()).toEqual([]);
      expect(waitedHashes()).toEqual([OP1.userOpHash]);
      expect(stored(key)?.status).toBe('confirmed');
      expect(mockPermit).not.toHaveBeenCalled();
      expect(loggedErrors()).toEqual([]);
    });

    it('scan (別の attemptId): 最初の待ちの間に元の試みが confirmed にした → 送り直さず、既払いの結果を返す', async () => {
      const other = seed('submitting', { attemptId: 'other', at: 900 });
      mockWait.mockImplementationOnce(async () => {
        markConfirmed({ key: other, sender: OWNER, txHash: OP1.txHash, success: true, now: now() });
        throw timeoutOf(OP1);
      });

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(sentOps()).toEqual([]);
      expect(mockPermit).not.toHaveBeenCalled();
      // 自分の key の記録は作っていない (scan で終わった)。
      expect(stored(KEY)).toBeUndefined();
    });

    it('resume: 送り直しの RPC の間に元の試みが confirmed にした → 内部の error にならず、既払いの結果を返す', async () => {
      const key = seed('submitting', { at: 900 });
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      mockBroadcast.mockImplementationOnce(async () => {
        markConfirmed({ key, sender: OWNER, txHash: OP1.txHash, success: true, now: now() });
        return OP1.userOpHash;
      });
      mockWait.mockResolvedValueOnce(receiptOf(OP1));

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(waitedHashes()).toEqual([OP1.userOpHash, OP1.userOpHash]);
      expect(stored(key)?.status).toBe('confirmed');
      expect(loggedErrors()).toEqual([]);
    });

    it('timeout のときは今までどおり同じ op を送り直す。送る時刻は **送り直しの前** に書く', async () => {
      const key = seed('submitting', { at: 900 });
      const updatedAtAtResend: Array<number | undefined> = [];
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      mockBroadcast.mockImplementationOnce(async () => {
        updatedAtAtResend.push(stored(key)?.updatedAt);
        return OP1.userOpHash;
      });
      mockWait.mockResolvedValueOnce(receiptOf(OP1));

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash });
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      // bundler へ渡す時点で、記録の時刻は seed (900) より後に進んでいる。
      expect(updatedAtAtResend).toHaveLength(1);
      expect(updatedAtAtResend[0]).toBeGreaterThan(900);
    });

    it('待つ間に、同じ key の記録が別の op のものに替わっていた → 古い op を送り直さず、替わった記録も書き換えない', async () => {
      const key = seed('submitting', { at: 900 });
      mockWait.mockImplementationOnce(async () => {
        rewrite(key, { userOpHash: OP2.userOpHash, signedUserOp: OP2.signedUserOp, updatedAt: 950 });
        throw timeoutOf(OP1);
      });

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CirclePendingError);
      // 確認待ちの op は、いま記録にある op。
      expect(error?.userOpHash).toBe(OP2.userOpHash);
      expect(sentOps()).toEqual([]);
      expect(waitedHashes()).toEqual([OP1.userOpHash]);
      expect(stored(key)).toMatchObject({ status: 'submitting', userOpHash: OP2.userOpHash, updatedAt: 950 });
    });

    it('送り直しの前の時刻を書けない (storage) → 送り直さず、確認待ち・元の error は log に残す', async () => {
      const key = seed('submitting', { at: 900 });
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      const writes = failWritesOf('submitting');

      const { error } = await outcome(run());
      writes.mockRestore();

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([]);
      expect(stored(key)).toMatchObject({ status: 'submitting', updatedAt: 900 });
      expect(loggedErrors()).toEqual(['circle.post_submit.unexpected']);
    });
  });

  // -------------------------------------------------------------------------
  // H-Y (M1): receipt の待ちが timeout 以外で失敗した (bundler の 429・5xx・通信断)。
  // 直す前: そのまま投げてふつうの error になり、hook が対応を消した。
  // 直した後: 確認待ち。その押下では送り直さない・記録の時刻も進めない。
  // -------------------------------------------------------------------------
  describe('H-Y: 待ちの失敗 (timeout 以外) は確認待ち・その押下で送り直さない', () => {
    it('自分の送信の後の待ちが失敗 → 確認待ち・送信は 1 回・記録は submitting のまま時刻も進まない', async () => {
      walletSigns(OP1);
      const updatedAtAtSend: Array<number | undefined> = [];
      mockBroadcast.mockImplementationOnce(async () => {
        updatedAtAtSend.push(stored()?.updatedAt);
        return OP1.userOpHash;
      });
      mockWait.mockRejectedValue(rpcDown());

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(waitedHashes()).toEqual([OP1.userOpHash]);
      expect(stored()).toMatchObject({ status: 'submitting', userOpHash: OP1.userOpHash });
      expect(stored()?.signedUserOp).toEqual(OP1.signedUserOp);
      expect(stored()?.updatedAt).toBe(updatedAtAtSend[0]);
      // 想定した失敗: warn に残す。境界の「想定していない throw」ではない。
      expect(loggedWarns()).toEqual(['circle.wait.failed']);
      expect(loggedErrors()).toEqual([]);
    });

    it('自分の送信の応答を失い、復旧の待ちも失敗 → 確認待ち・送り直さない', async () => {
      walletSigns(OP1);
      mockBroadcast.mockRejectedValueOnce(new Error('socket hang up'));
      mockWait.mockRejectedValue(rpcDown());

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(waitedHashes()).toEqual([OP1.userOpHash]);
      expect(stored()?.status).toBe('submitting');
      expect(loggedErrors()).toEqual([]);
    });

    it('resume の復旧: 最初の待ちが失敗 → 確認待ち・送り直さない・時刻は進まない', async () => {
      const key = seed('submitting', { at: 900 });
      mockWait.mockRejectedValue(rpcDown());

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([]);
      expect(waitedHashes()).toEqual([OP1.userOpHash]);
      expect(stored(key)).toMatchObject({ status: 'submitting', updatedAt: 900 });
      expect(mockPermit).not.toHaveBeenCalled();
      expect(loggedWarns()).toEqual(['circle.wait.failed']);
      expect(loggedErrors()).toEqual([]);
    });

    it('scan の復旧 (別の attemptId): 最初の待ちが失敗 → 確認待ち・送り直さない・新しい署名も求めない', async () => {
      const other = seed('submitting', { attemptId: 'other', at: 900 });
      mockWait.mockRejectedValue(rpcDown());

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      // 場面 (e) (PR-39c): この呼び出しは対応を付け替えていない (adoptAttempt を渡していない)。
      expect(takePendingCodes()).toEqual(['unconfirmed_earlier']);
      expect(sentOps()).toEqual([]);
      expect(stored(other)).toMatchObject({ status: 'submitting', updatedAt: 900 });
      expect(mockPermit).not.toHaveBeenCalled();
      expect(loggedErrors()).toEqual([]);
    });

    it('復旧: timeout → 送り直し → その後の待ちが失敗 → 確認待ち・送り直しは 1 回だけ・時刻は送り直しの前に書いたまま', async () => {
      const key = seed('submitting', { at: 900 });
      const updatedAtAtResend: Array<number | undefined> = [];
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      mockBroadcast.mockImplementationOnce(async () => {
        updatedAtAtResend.push(stored(key)?.updatedAt);
        return OP1.userOpHash;
      });
      mockWait.mockRejectedValueOnce(rpcDown());

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(waitedHashes()).toEqual([OP1.userOpHash, OP1.userOpHash]);
      expect(stored(key)?.status).toBe('submitting');
      expect(stored(key)?.updatedAt).toBe(updatedAtAtResend[0]);
      expect(loggedErrors()).toEqual([]);
    });

    it('確認待ちの後、もう一度押すと同じ op を復旧して結果を返す (新しい署名も 2 本目の op も無い)', async () => {
      walletSigns(OP1);
      mockWait.mockRejectedValueOnce(rpcDown());
      const first = await outcome(run());
      expect(first.error).toBeInstanceOf(CirclePendingError);

      mockWait.mockResolvedValueOnce(receiptOf(OP1));
      const res = await run(); // 同じ attempt-1 (hook は確認待ちでは対応を残す)

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(mockPermit).toHaveBeenCalledTimes(1);
      expect(mockPrepare).toHaveBeenCalledTimes(1);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(stored()?.status).toBe('confirmed');
    });
  });

  // -------------------------------------------------------------------------
  // H-Y: confirmed の記録の結果。直す前は receipt を waitForUserOperationReceipt (最大 120 秒) で取り直し、timeout 以外の
  // 失敗をそのまま投げていた (払い終えた支払いが、ふつうの error になって対応が消える)。
  // -------------------------------------------------------------------------
  describe('H-Y: confirmed の記録の結果は、receipt を取り直せなくても保存した値で返す', () => {
    it('resume: receipt の照会が失敗 → 保存した値で既払いの結果を返す (120 秒の待ちは使わない)', async () => {
      const key = seed('confirmed', { at: 900 });
      mockLookup.mockRejectedValue(rpcDown());
      mockWait.mockRejectedValue(rpcDown()); // 直す前の経路 (待ち) も同じく失敗する

      const res = await run();

      expect(res).toEqual({
        userOpHash: OP1.userOpHash,
        txHash: OP1.txHash,
        blockNumber: 0n,
        success: true,
        actualGasCost: 0n,
      });
      expect(lookedUpHashes()).toEqual([OP1.userOpHash]);
      expect(mockWait).not.toHaveBeenCalled();
      expect(sentOps()).toEqual([]);
      expect(mockPermit).not.toHaveBeenCalled();
      expect(stored(key)?.status).toBe('confirmed');
      expect(loggedWarns()).toEqual(['circle.confirmed.receipt-unavailable']);
      expect(loggedErrors()).toEqual([]);
    });

    it('scan (90 秒以内の別の attemptId): receipt の照会が失敗 → 保存した値で既払いの結果を返す', async () => {
      seed('confirmed', { attemptId: 'other', at: 990 });
      mockLookup.mockRejectedValue(rpcDown());
      mockWait.mockRejectedValue(rpcDown());

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(mockWait).not.toHaveBeenCalled();
      expect(mockPermit).not.toHaveBeenCalled();
      expect(sentOps()).toEqual([]);
    });

    it('receipt が取れれば receipt の値で返す (照会は 1 回・待ちは使わない)', async () => {
      seed('confirmed', { at: 900 });

      const res = await run();

      expect(res).toEqual({
        userOpHash: OP1.userOpHash,
        txHash: OP1.txHash,
        blockNumber: 10n,
        success: true,
        actualGasCost: 1000n,
      });
      expect(lookedUpHashes()).toEqual([OP1.userOpHash]);
      expect(mockWait).not.toHaveBeenCalled();
      expect(loggedWarns()).toEqual([]);
    });

    it('取り直せないとき、success は保存した値のまま (revert 済みを成功にしない・旧 record は false 側)', async () => {
      const key = seed('confirmed', { at: 900, success: false });
      mockLookup.mockRejectedValue(rpcDown());
      expect((await run()).success).toBe(false);

      // success を持たない旧 record。
      const parsed = JSON.parse(window.localStorage.getItem(PENDING_KEY_PREFIX + key)!) as Record<string, unknown>;
      delete parsed.success;
      window.localStorage.setItem(PENDING_KEY_PREFIX + key, JSON.stringify(parsed));
      expect((await run()).success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // D5: 同じ key の 2 つの試み (複製したタブ・開き直した画面) が両方署名した。後から署名を終えた側の markSigned は CAS で
  // 外れる。直す前: PendingStateError (内部の error) で終わり、対応を消した。直した後: 自分の op は送らず、記録に従う。
  // -------------------------------------------------------------------------
  describe('D5: markSigned の CAS が外れたら、自分の op は送らず、記録に従う', () => {
    // 署名 2 を待つ間に、同じ key を使う別の画面が自分の op (OP1) を先に進める。こちらの署名 2 は OP2 を返す。
    function otherScreenWhileSigning(advance: (key: string) => void) {
      seed('awaiting_signature', { at: 900 });
      mockPermit.mockResolvedValue(PERMIT);
      mockPrepare.mockImplementationOnce(async () => {
        advance(KEY);
        return { signedUserOp: OP2.signedUserOp, userOpHash: OP2.userOpHash };
      });
    }
    function otherSends(key: string) {
      markSigned({ key, sender: OWNER, signedUserOp: OP1.signedUserOp, userOpHash: OP1.userOpHash, now: now() });
      markSubmitting({ key, sender: OWNER, now: now() });
    }

    it('2 つの画面が同時に署名: 後の側は送らず、先の側の op の receipt を待って同じ結果を受け取る', async () => {
      const signA = deferred<{ signedUserOp: Record<string, unknown>; userOpHash: Hex }>();
      const signB = deferred<{ signedUserOp: Record<string, unknown>; userOpHash: Hex }>();
      mockPermit.mockResolvedValue(PERMIT);
      mockPrepare.mockReturnValueOnce(signA.promise).mockReturnValueOnce(signB.promise);
      const included = deferred<void>();
      mockWait.mockImplementation(async ({ hash }) => {
        await included.promise;
        return receiptOf(hash === OP2.userOpHash ? OP2 : OP1);
      });

      const a = track(run());
      await flush();
      const b = track(run()); // 同じ attempt-1 = 同じ key の記録 (awaiting_signature) を resume する
      await flush();
      expect(mockPrepare).toHaveBeenCalledTimes(2);

      signA.resolve({ signedUserOp: OP1.signedUserOp, userOpHash: OP1.userOpHash });
      await flush();
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(stored()).toMatchObject({ status: 'submitting', userOpHash: OP1.userOpHash });

      signB.resolve({ signedUserOp: OP2.signedUserOp, userOpHash: OP2.userOpHash });
      await flush();
      // B は自分の op (OP2) を保存も送信もせず、A の op の receipt を待っている。
      expect(b.settled).toBe(false);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(stored()).toMatchObject({ status: 'submitting', userOpHash: OP1.userOpHash });

      included.resolve();
      await flush();

      const paid = { userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true };
      expect(a.value).toMatchObject(paid);
      expect(b.value).toMatchObject(paid);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(waitedHashes()).toEqual([OP1.userOpHash, OP1.userOpHash]);
      expect(stored()).toMatchObject({ status: 'confirmed', userOpHash: OP1.userOpHash, txHash: OP1.txHash });
      expect(loggedErrors()).toEqual([]);
    });

    it('先の側がもう confirmed → 記録の結果を返す (自分の op は送らない)', async () => {
      otherScreenWhileSigning((key) => {
        otherSends(key);
        markConfirmed({ key, sender: OWNER, txHash: OP1.txHash, success: true, now: now() });
      });

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(sentOps()).toEqual([]);
      expect(mockWait).not.toHaveBeenCalled();
      expect(stored()).toMatchObject({ status: 'confirmed', userOpHash: OP1.userOpHash });
    });

    it('先の側が submitting で、その op の待ちが timeout → 先の側の op (自分の op ではない) を送り直して結果を返す', async () => {
      otherScreenWhileSigning(otherSends);
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      mockWait.mockResolvedValueOnce(receiptOf(OP1));

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(waitedHashes()).toEqual([OP1.userOpHash, OP1.userOpHash]);
    });

    it('先の側が submitting で、その op の待ちの間に先の側が confirmed にした → 送り直さず、記録の結果を返す', async () => {
      otherScreenWhileSigning(otherSends);
      mockWait.mockImplementationOnce(async () => {
        markConfirmed({ key: KEY, sender: OWNER, txHash: OP1.txHash, success: true, now: now() });
        throw timeoutOf(OP1);
      });

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(sentOps()).toEqual([]);
    });

    it('先の側が submitting で、その op の待ちが失敗 → 確認待ち (先の側の op の hash)・何も送らない', async () => {
      otherScreenWhileSigning(otherSends);
      mockWait.mockRejectedValue(rpcDown());

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([]);
      expect(stored()).toMatchObject({ status: 'submitting', userOpHash: OP1.userOpHash });
    });

    it('記録が abandoned になっていた (別のタブの scan が 3 分で見捨てた) → 「既に終了」・確認待ちにしない・何も送らない', async () => {
      otherScreenWhileSigning((key) => {
        abandon({ key, sender: OWNER, now: now() });
      });

      const { error } = await outcome(run());

      expect(error).not.toBeInstanceOf(CirclePendingError);
      expect(error?.name).toBe('Error');
      expect(error?.message).toBe(ENDED);
      // 場面 (c) (PR-39c)。name は 'Error' のまま (hook の扱いは今までどおり) で、場面は符号で分かる。
      expect(error?.circleCode).toBe('attempt_ended');
      expect(Object.hasOwn(error!, 'circleCode')).toBe(true);
      expect(ENDED).toBe(jaMessages.CircleErrors.attemptEnded);
      expect(sentOps()).toEqual([]);
      expect(stored()?.status).toBe('abandoned');
      expect(loggedErrors()).toEqual([]);
    });

    it('渡していない試み: 記録が failed → 「既に終了」(確認待ちにしない)', async () => {
      otherScreenWhileSigning((key) => {
        otherSends(key);
        rewrite(key, { status: 'failed' });
      });

      const { error } = await outcome(run());

      expect(error).not.toBeInstanceOf(CirclePendingError);
      expect(error?.message).toBe(ENDED);
      expect(sentOps()).toEqual([]);
      expect(mockWait).not.toHaveBeenCalled();
      expect(stored()?.status).toBe('failed');
    });

    it('記録が消えていた → 「既に終了」・何も送らない', async () => {
      otherScreenWhileSigning(remove);

      const { error } = await outcome(run());

      expect(error).not.toBeInstanceOf(CirclePendingError);
      expect(error?.message).toBe(ENDED);
      expect(sentOps()).toEqual([]);
      expect(stored()).toBeUndefined();
    });

    it('markSigned を書けない (storage の失敗) は CAS の失敗ではない → 今までどおりふつうの error・何も送らない', async () => {
      walletSigns(OP1);
      const writes = failWritesOf('signed');

      const { error } = await outcome(run());
      writes.mockRestore();

      expect(error?.name).toBe('PendingStoreWriteError');
      expect(sentOps()).toEqual([]);
      expect(stored()?.status).toBe('awaiting_signature');
    });
  });

  // -------------------------------------------------------------------------
  // M2: 復旧の送り直しの前の CAS が外れたときの「記録に従う」は、この押下で op を渡したかで分ける。
  // -------------------------------------------------------------------------
  describe('M2: 記録に従う — この押下で op を渡したかで分ける', () => {
    // 自分で署名して送り、待ちが timeout → 復旧の最初の待ちの間に、記録が書き換わる (whileWaiting) → timeout。
    async function handedOffThenCasMiss(whileWaiting: () => void) {
      walletSigns(OP1);
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      mockWait.mockImplementationOnce(async () => {
        whileWaiting();
        throw timeoutOf(OP1);
      });
      return outcome(run());
    }

    it('渡した後: 記録が failed → 確認待ち (「既に終了」にしない)・error の log・送り直さない', async () => {
      const { error } = await handedOffThenCasMiss(() => rewrite(KEY, { status: 'failed' }));

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(stored()?.status).toBe('failed');
      expect(errorSpy.mock.calls).toEqual([
        [
          'circle.follow.failed-after-handoff',
          { userOpHash: OP1.userOpHash, recordUserOpHash: OP1.userOpHash },
        ],
      ]);
    });

    it('渡した後: 記録が消えていた → 確認待ち (「既に終了」にしない)', async () => {
      const { error } = await handedOffThenCasMiss(() => remove(KEY));

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
    });

    it('渡した後: 記録が confirmed で自分の hash → 記録の結果 (別の画面の復旧が先に確定を書いた)', async () => {
      const { value } = await handedOffThenCasMiss(() =>
        markConfirmed({ key: KEY, sender: OWNER, txHash: OP1.txHash, success: true, now: now() }),
      );

      expect(value).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(sentOps()).toEqual([OP1.signedUserOp]);
    });

    it('渡した後: 記録が confirmed でも自分の hash でない → 結果にしない (確認待ち)', async () => {
      const { error } = await handedOffThenCasMiss(() =>
        rewrite(KEY, {
          status: 'confirmed',
          userOpHash: OP2.userOpHash,
          signedUserOp: OP2.signedUserOp,
          txHash: OP2.txHash,
          success: true,
        }),
      );

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
    });

    // 渡していない試み (resume の復旧) の、同じ場面。
    async function notHandedOffThenCasMiss(whileWaiting: (key: string) => void) {
      const key = seed('submitting', { at: 900 });
      mockWait.mockImplementationOnce(async () => {
        whileWaiting(key);
        throw timeoutOf(OP1);
      });
      return outcome(run());
    }

    it('渡していない: 記録が failed → 「既に終了」(確認待ちにしない)・送り直さない', async () => {
      const { error } = await notHandedOffThenCasMiss((key) => rewrite(key, { status: 'failed' }));

      expect(error).not.toBeInstanceOf(CirclePendingError);
      expect(error?.message).toBe(ENDED);
      expect(sentOps()).toEqual([]);
      expect(loggedErrors()).toEqual([]);
    });

    it('渡していない: 記録が消えていた → 「既に終了」・送り直さない', async () => {
      const { error } = await notHandedOffThenCasMiss(remove);

      expect(error).not.toBeInstanceOf(CirclePendingError);
      expect(error?.message).toBe(ENDED);
      expect(sentOps()).toEqual([]);
    });

    it('渡していない: 記録が confirmed なら hash を問わず記録の結果を返す', async () => {
      const { value } = await notHandedOffThenCasMiss((key) =>
        rewrite(key, {
          status: 'confirmed',
          userOpHash: OP2.userOpHash,
          signedUserOp: OP2.signedUserOp,
          txHash: OP2.txHash,
          success: true,
        }),
      );

      expect(value).toMatchObject({ userOpHash: OP2.userOpHash, txHash: OP2.txHash, success: true });
      expect(sentOps()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // receipt を取った後の記録の更新 (markConfirmed) の失敗。直す前: PendingStateError / 書込の error で終わり、
  // 取り込まれた支払いが「失敗」と出て対応が消えた。
  // -------------------------------------------------------------------------
  describe('D4: receipt を取った後に記録を更新できなくても、結果は返す', () => {
    it('待つ間に記録が消えていた → 結果を返す・error の log', async () => {
      walletSigns(OP1);
      mockWait.mockImplementationOnce(async () => {
        remove(KEY);
        return receiptOf(OP1);
      });

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true, blockNumber: 10n });
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(stored()).toBeUndefined();
      expect(loggedErrors()).toEqual(['circle.confirm.record-failed']);
      expect(errorSpy.mock.calls[0][1]).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash });
    });

    it('confirmed を書けない (storage) → 結果を返す・記録は submitting のまま。次の押下は同じ op を復旧して同じ結果', async () => {
      walletSigns(OP1);
      mockWait.mockResolvedValue(receiptOf(OP1));
      const writes = failWritesOf('confirmed');

      const res = await run();
      writes.mockRestore();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(stored()?.status).toBe('submitting');
      expect(loggedErrors()).toEqual(['circle.confirm.record-failed']);

      const again = await run();
      expect(again).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(mockPermit).toHaveBeenCalledTimes(1);
      expect(stored()?.status).toBe('confirmed');
    });

    it('待つ間に記録が別の op のものに替わっていた → 結果は返すが、その記録を confirmed にしない', async () => {
      walletSigns(OP1);
      mockWait.mockImplementationOnce(async () => {
        rewrite(KEY, { userOpHash: OP2.userOpHash, signedUserOp: OP2.signedUserOp });
        return receiptOf(OP1);
      });

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(stored()).toMatchObject({ status: 'submitting', userOpHash: OP2.userOpHash });
      expect(stored()?.txHash).toBeUndefined();
      expect(loggedErrors()).toEqual(['circle.confirm.record-failed']);
    });

    it('待つ間に記録が failed になっていたが receipt が取れた → 結果を返し、記録を confirmed に直す・error の log', async () => {
      walletSigns(OP1);
      mockWait.mockImplementationOnce(async () => {
        rewrite(KEY, { status: 'failed' });
        return receiptOf(OP1);
      });

      const res = await run();

      expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
      expect(stored()).toMatchObject({ status: 'confirmed', userOpHash: OP1.userOpHash, txHash: OP1.txHash });
      expect(loggedErrors()).toEqual(['circle.pending.confirmed-after-failed']);
    });
  });

  // -------------------------------------------------------------------------
  // 境界: 自分の markSubmitting が返った後の、想定していない throw。
  // -------------------------------------------------------------------------
  describe('境界: 送った後の想定していない throw は確認待ちに変え、元の error を log に残す', () => {
    it('送信の応答を失った後、記録を読めない (storage) → 確認待ち', async () => {
      walletSigns(OP1);
      let reads: ReturnType<typeof breakStorageReads> | undefined;
      mockBroadcast.mockImplementationOnce(async () => {
        reads = breakStorageReads();
        throw new Error('socket hang up');
      });

      const { error } = await outcome(run());
      reads?.mockRestore();

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(mockWait).not.toHaveBeenCalled();
      expect(stored()).toMatchObject({ status: 'submitting', userOpHash: OP1.userOpHash });
      expect(loggedErrors()).toEqual(['circle.post_submit.unexpected']);
      const fields = errorSpy.mock.calls[0][1] as { userOpHash: Hex; error: Error };
      expect(fields.userOpHash).toBe(OP1.userOpHash);
      expect(fields.error.name).toBe('PendingStoreUnavailableError');
    });

    it('送信の後の待ちが timeout し、記録を読めない (storage) → 確認待ち', async () => {
      walletSigns(OP1);
      let reads: ReturnType<typeof breakStorageReads> | undefined;
      mockWait.mockImplementationOnce(async () => {
        reads = breakStorageReads();
        throw timeoutOf(OP1);
      });

      const { error } = await outcome(run());
      reads?.mockRestore();

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(stored()?.status).toBe('submitting');
      expect(loggedErrors()).toEqual(['circle.post_submit.unexpected']);
    });

    it('scan の復旧 (別の attemptId) で、送り直しの前の時刻を書けない (storage) → 確認待ち・新しい署名へ進まない', async () => {
      const other = seed('submitting', { attemptId: 'other', at: 900 });
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      failWritesOf('submitting');

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      // 場面 (e) (PR-39c): 境界 (inPostSubmit) が想定外の throw から作った確認待ちも、付け替えていない記録なら (e)。
      expect(error?.circleCode).toBe('unconfirmed_earlier');
      expect(error?.name).toBe('CirclePendingError');
      expect(takePendingCodes()).toEqual(['unconfirmed_earlier']);
      expect(sentOps()).toEqual([]);
      expect(mockPermit).not.toHaveBeenCalled();
      expect(stored(other)).toMatchObject({ status: 'submitting', updatedAt: 900 });
      expect(loggedErrors()).toEqual(['circle.post_submit.unexpected']);
    });

    it('同じ場面で、対応を付け替えた呼び出し (adoptAttempt あり・書けた) → 確認待ちは (a) のまま', async () => {
      const other = seed('submitting', { attemptId: 'other', at: 900 });
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      failWritesOf('submitting');
      const adoptAttempt = vi.fn(() => true);

      const { error } = await outcome(run({ adoptAttempt }));

      expect(adoptAttempt.mock.calls).toEqual([['other']]);
      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      // 次の押下は、付け替えた先の記録の key を resume する (記録が残っている間) → (a) の「24 時間以内に…まず同じ支払いの結果を
      // 確かめ直します」が成り立つ。
      expect(error?.circleCode).toBe('unconfirmed');
      expect(stored(other)).toMatchObject({ status: 'submitting', updatedAt: 900 });
      expect(loggedErrors()).toEqual(['circle.post_submit.unexpected']);
    });

    it('同じ場面で、hook の関数を呼んだが対応を書けなかった (false を返す) → 確認待ちは (e)', async () => {
      const other = seed('submitting', { attemptId: 'other', at: 900 });
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      failWritesOf('submitting');
      const adoptAttempt = vi.fn(() => false);

      const { error } = await outcome(run({ adoptAttempt }));

      expect(adoptAttempt.mock.calls).toEqual([['other']]);
      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(error?.circleCode).toBe('unconfirmed_earlier');
      expect(takePendingCodes()).toEqual(['unconfirmed_earlier']);
      expect(stored(other)).toMatchObject({ status: 'submitting', updatedAt: 900 });
      expect(loggedErrors()).toEqual(['circle.post_submit.unexpected']);
    });

    it('markSigned の CAS が外れて先の側の op を復旧する途中で、storage が投げる → 確認待ち・自分の op は送らない', async () => {
      seed('awaiting_signature', { at: 900 });
      mockPermit.mockResolvedValue(PERMIT);
      mockPrepare.mockImplementationOnce(async () => {
        // 同じ key を使う別の画面が、先に自分の op (OP1) を送った。その後、submitting の記録を書けなくなる。
        markSigned({ key: KEY, sender: OWNER, signedUserOp: OP1.signedUserOp, userOpHash: OP1.userOpHash, now: now() });
        markSubmitting({ key: KEY, sender: OWNER, now: now() });
        failWritesOf('submitting');
        return { signedUserOp: OP2.signedUserOp, userOpHash: OP2.userOpHash };
      });
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(sentOps()).toEqual([]);
      expect(waitedHashes()).toEqual([OP1.userOpHash]);
      expect(stored()).toMatchObject({ status: 'submitting', userOpHash: OP1.userOpHash });
      expect(loggedErrors()).toEqual(['circle.post_submit.unexpected']);
    });

    it('markSubmitting を書けない → 境界の外 = ふつうの error (送っていない試みを確認待ちにしない)', async () => {
      walletSigns(OP1);
      const writes = failWritesOf('submitting');

      const { error } = await outcome(run());
      writes.mockRestore();

      expect(error).not.toBeInstanceOf(CirclePendingError);
      expect(error?.name).toBe('PendingStoreWriteError');
      expect(sentOps()).toEqual([]);
      expect(mockWait).not.toHaveBeenCalled();
      expect(stored()?.status).toBe('signed');
      expect(loggedErrors()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // H-X (PR-39b): 自分の最初の送信を bundler が検証で拒否したら、記録を failed に閉じて「送信の受付で断られた」で終える。
  // 直す前: 理由を見ずに「応答の喪失」として復旧へ進み、120 秒待つ → 同じ op を送り直す (また拒否) → 120 秒待つ → 確認待ち。
  // 記録は submitting のまま残り、押すたびに同じことを繰り返して、その内容の支払いが払えなかった。
  //
  // 送信の error は、本物の circleAccount が投げるのと同じもの: viem の RpcRequestError (bundler の JSON-RPC の error) を、
  // 本物の分類 (classifyCircleBroadcastError = Pimlico の経路の分類 + S1) に通して作る。分類そのものの確認 (HTTP の request から)
  // は tests/lib/smartAccount/circleAccount.test.ts。
  // -------------------------------------------------------------------------
  describe('H-X: 最初の送信の検証拒否で記録を閉じる', () => {
    const REJECTED =
      'USDC ガスレスの支払いは、送信の受付で断られました。この支払いは送金されていません。' +
      '残高が足りないなどの理由が考えられます。もう一度お試しください (署名からやり直します)。';
    const mockPrepareBroadcast = vi.mocked(prepareCircleBroadcast);

    function bundlerSays(reply: { code: number; message: string; status?: number }) {
      const cause = new RpcRequestError({
        body: { method: 'eth_sendUserOperation', params: [OP1.signedUserOp] },
        error: { code: reply.code, message: reply.message },
        url: 'https://bundler.test/rpc',
      });
      return new actualCircleAccount.CircleBroadcastError({
        ...actualCircleAccount.classifyCircleBroadcastError(cause, reply.status ?? 200),
        cause,
      });
    }
    // paymaster の検証 (USDC の残高が足りない等) での拒否。
    const rejectedByValidation = () => bundlerSays({ code: -32501, message: 'AA33 reverted (or OOG)' });
    const rawRecord = (key = KEY) => window.localStorage.getItem(PENDING_KEY_PREFIX + key);

    beforeEach(() => {
      mockPrepareBroadcast.mockClear();
    });

    it('最初の送信を bundler が検証で拒否 → 記録を failed に閉じ、待たず・送り直さず、専用の error で終える', async () => {
      walletSigns(OP1);
      mockBroadcast.mockRejectedValueOnce(rejectedByValidation());

      const { error } = await outcome(run());

      // 確認待ちではない (hook は name が CirclePendingError でない error で対応を消す)。文は固定で、bundler の生の文を出さない。
      expect(error).toBeInstanceOf(CircleSendRejectedError);
      expect(error).not.toBeInstanceOf(CirclePendingError);
      expect(error?.name).toBe('CircleSendRejectedError');
      expect(error?.message).toBe(REJECTED);
      // 場面 (d) (PR-39c)。
      expect(error?.circleCode).toBe('send_rejected');
      expect(Object.hasOwn(error!, 'circleCode')).toBe(true);
      expect(REJECTED).toBe(jaMessages.CircleErrors.sendRejected);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      // 拒否が返った時点で終わる: receipt を待たない (直す前は 120 秒 × 2)・送り直さない。
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(mockWait).not.toHaveBeenCalled();
      expect(mockLookup).not.toHaveBeenCalled();
      // 記録は failed。署名済みの op は残さない (userOpHash と、bundler の code・文は残す)。
      const rec = stored();
      expect(rec).toMatchObject({
        status: 'failed',
        userOpHash: OP1.userOpHash,
        errorMessage: 'bundler rejected (code -32501): AA33 reverted (or OOG)',
      });
      expect(rec && 'signedUserOp' in rec).toBe(false);
      expect(rawRecord()).not.toContain(OP1.signedUserOp.signature);
      // 監査の log: 閉じた op の hash と拒否の code。
      expect(warnSpy.mock.calls).toEqual([
        [
          'circle.broadcast.rejected',
          { userOpHash: OP1.userOpHash, code: -32501, details: 'AA33 reverted (or OOG)' },
        ],
      ]);
      expect(loggedErrors()).toEqual([]);
    });

    it('閉じた後の押し直し (hook が対応を消した後 = 新しい attemptId) は新しい支払い: 署名 2 回から・別の op を 1 回だけ送る', async () => {
      walletSigns(OP1);
      mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
      expect((await outcome(run())).error).toBeInstanceOf(CircleSendRejectedError);

      walletSigns(OP2);
      mockWait.mockResolvedValueOnce(receiptOf(OP2));
      const res = await run({ paymentAttemptId: 'attempt-2' });

      expect(res).toMatchObject({ userOpHash: OP2.userOpHash, txHash: OP2.txHash, success: true });
      // scan は failed の記録を数えない (前の op の復旧をしない)。署名は 2 回ずつ = 合計 2 回ずつ。
      expect(mockPermit).toHaveBeenCalledTimes(2);
      expect(mockPrepare).toHaveBeenCalledTimes(2);
      expect(sentOps()).toEqual([OP1.signedUserOp, OP2.signedUserOp]);
      expect(waitedHashes()).toEqual([OP2.userOpHash]);
      expect(stored(KEY)?.status).toBe('failed');
      expect(stored(keyOf('attempt-2'))?.status).toBe('confirmed');
    });

    it('閉じた後、同じ key の別の画面の押下 → 「既に終了」(何も送らない) → その次の押下で新しい支払い', async () => {
      walletSigns(OP1);
      mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
      await outcome(run());
      mockPermit.mockClear();

      // 同じ key (同じ attemptId の対応を持つ、複製したタブ)。
      const second = await outcome(run());
      expect(second.error).not.toBeInstanceOf(CirclePendingError);
      expect(second.error?.message).toBe(ENDED);
      expect(mockPermit).not.toHaveBeenCalled();
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(stored()?.status).toBe('failed');

      // 「既に終了」で hook が対応を消す → 次の押下は新しい attemptId。
      walletSigns(OP2);
      mockWait.mockResolvedValueOnce(receiptOf(OP2));
      const res = await run({ paymentAttemptId: 'attempt-2' });
      expect(res).toMatchObject({ userOpHash: OP2.userOpHash, success: true });
      expect(sentOps()).toEqual([OP1.signedUserOp, OP2.signedUserOp]);
    });

    it('signed のまま中断した記録を resume して署名し直した送信も「自分の最初の送信」: 検証の拒否で閉じる', async () => {
      const key = seed('signed', { at: 900 });
      walletSigns(OP2);
      mockBroadcast.mockRejectedValueOnce(rejectedByValidation());

      const { error } = await outcome(run());

      expect(error).toBeInstanceOf(CircleSendRejectedError);
      expect(error?.userOpHash).toBe(OP2.userOpHash);
      expect(stored(key)).toMatchObject({ status: 'failed', userOpHash: OP2.userOpHash });
      expect(mockWait).not.toHaveBeenCalled();
    });

    describe('送り直し (復旧の再 broadcast) の拒否では閉じない', () => {
      const expectStillSubmitting = (key = KEY) => {
        expect(stored(key)).toMatchObject({
          status: 'submitting',
          userOpHash: OP1.userOpHash,
          signedUserOp: OP1.signedUserOp,
        });
        expect(stored(key)?.errorMessage).toBeUndefined();
      };

      it('resume の復旧: 待ちが timeout → 送り直しが検証で拒否 → 確認待ち・記録は submitting のまま', async () => {
        const key = seed('submitting', { at: 900 });
        mockWait.mockRejectedValueOnce(timeoutOf(OP1));
        mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
        mockWait.mockRejectedValueOnce(timeoutOf(OP1));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(error?.userOpHash).toBe(OP1.userOpHash);
        expect(sentOps()).toEqual([OP1.signedUserOp]);
        expect(mockWait).toHaveBeenCalledTimes(2);
        expectStillSubmitting(key);
      });

      it('scan の復旧 (別の attemptId): 送り直しが検証で拒否 → 確認待ち・記録は submitting のまま・新しい署名へ進まない', async () => {
        const key = seed('submitting', { at: 900 });
        mockWait.mockRejectedValueOnce(timeoutOf(OP1));
        mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
        mockWait.mockRejectedValueOnce(timeoutOf(OP1));

        const { error } = await outcome(run({ paymentAttemptId: 'attempt-2' }));

        expect(error).toBeInstanceOf(CirclePendingError);
        // 場面 (e) (PR-39c): 別の key の記録を、付け替えずに復旧して確認待ちで終わった。
        expect(takePendingCodes()).toEqual(['unconfirmed_earlier']);
        expect(mockPermit).not.toHaveBeenCalled();
        expectStillSubmitting(key);
      });

      it('自分の最初の送信の応答を失い (unknown)、復旧の送り直しが検証で拒否 → 確認待ち・記録は submitting のまま', async () => {
        walletSigns(OP1);
        mockBroadcast.mockRejectedValueOnce(new Error('The request took too long to respond.'));
        mockWait.mockRejectedValueOnce(timeoutOf(OP1));
        mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
        mockWait.mockRejectedValueOnce(timeoutOf(OP1));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(sentOps()).toEqual([OP1.signedUserOp, OP1.signedUserOp]);
        expectStillSubmitting();
      });

      it('自分の最初の送信は受理され、待ちが timeout → 復旧の送り直しが検証で拒否 → 確認待ち・記録は submitting のまま', async () => {
        walletSigns(OP1);
        mockWait.mockRejectedValueOnce(timeoutOf(OP1));
        mockWait.mockRejectedValueOnce(timeoutOf(OP1));
        mockBroadcast.mockResolvedValueOnce(OP1.userOpHash);
        mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
        mockWait.mockRejectedValueOnce(timeoutOf(OP1));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(sentOps()).toEqual([OP1.signedUserOp, OP1.signedUserOp]);
        expectStillSubmitting();
      });
    });

    describe('拒否の応答を待つ間に、ほかの試みが記録を進めていたら閉じない', () => {
      it('別の試みが同じ op を送り直していた (送る時刻が進んでいる)・その op が取り込まれた → 閉じず、既払いの結果を返す', async () => {
        walletSigns(OP1);
        mockBroadcast.mockImplementationOnce(async () => {
          // 同じ key を resume した別の画面の復旧が、送り直しの前の時刻を書く (lib/circlePending.ts の markResending)。
          markResending({ key: KEY, sender: OWNER, userOpHash: OP1.userOpHash, now: now() });
          throw rejectedByValidation();
        });
        mockWait.mockResolvedValueOnce(receiptOf(OP1));

        const res = await run();

        expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
        expect(stored()).toMatchObject({ status: 'confirmed', txHash: OP1.txHash });
        expect(loggedWarns()).toEqual([
          'circle.broadcast.rejected-not-closed',
          'circle.broadcast.response-lost',
        ]);
        expect(loggedErrors()).toEqual([]);
      });

      it('別の試みが同じ op を送り直していた・まだ取り込まれない → 閉じず、今までどおり確認待ち (記録は submitting・op も残る)', async () => {
        walletSigns(OP1);
        mockBroadcast.mockImplementationOnce(async () => {
          markResending({ key: KEY, sender: OWNER, userOpHash: OP1.userOpHash, now: now() });
          throw rejectedByValidation();
        });
        mockWait.mockRejectedValue(timeoutOf(OP1));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(error?.userOpHash).toBe(OP1.userOpHash);
        expect(stored()).toMatchObject({ status: 'submitting', signedUserOp: OP1.signedUserOp });
      });

      it('別の試みが confirmed にしていた → 閉じず (confirmed を failed にしない)、既払いの結果を返す', async () => {
        walletSigns(OP1);
        mockBroadcast.mockImplementationOnce(async () => {
          markConfirmed({
            key: KEY,
            sender: OWNER,
            txHash: OP1.txHash,
            success: true,
            now: now(),
            userOpHash: OP1.userOpHash,
          });
          throw rejectedByValidation();
        });
        mockWait.mockResolvedValueOnce(receiptOf(OP1));

        const res = await run();

        expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
        expect(stored()).toMatchObject({ status: 'confirmed', txHash: OP1.txHash });
      });

      it('記録が別の op のものに替わっていた (時刻は同じ・hash だけ違う) → 閉じない・替わった記録を書き換えない', async () => {
        walletSigns(OP1);
        mockBroadcast.mockImplementationOnce(async () => {
          rewrite(KEY, { userOpHash: OP2.userOpHash, signedUserOp: OP2.signedUserOp });
          throw rejectedByValidation();
        });
        mockWait.mockRejectedValue(rpcDown());

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(error?.userOpHash).toBe(OP1.userOpHash);
        expect(stored()).toMatchObject({
          status: 'submitting',
          userOpHash: OP2.userOpHash,
          signedUserOp: OP2.signedUserOp,
        });
        expect(rawRecord()).not.toContain('errorMessage');
      });

      it('記録が消えていた → 閉じない (作らない)・確認待ち', async () => {
        walletSigns(OP1);
        mockBroadcast.mockImplementationOnce(async () => {
          remove(KEY);
          throw rejectedByValidation();
        });

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(rawRecord()).toBeNull();
      });
    });

    // S1 と分類: 「検証による確定的な拒否」と言えない答えでは閉じない (今までどおり: 待つ → 同じ op を送り直す → 待つ)。
    describe('検証による確定的な拒否でない答えでは閉じない (今までどおり復旧へ)', () => {
      it.each([
        // S1: allowlist の code でも、bundler の文が nonce・mempool・重複・置き換えに触れている。
        { label: 'S1 AA25 (nonce)', code: -32500, message: 'AA25 invalid account nonce' },
        { label: 'S1 replacement', code: -32602, message: 'replacement underpriced' },
        { label: 'S1 mempool', code: -32602, message: 'sender has too many UserOperations in the mempool' },
        { label: 'S1 already', code: -32500, message: 'userOp was already included' },
        // bundler がその op を持っている (already-known = 受理と同じ)。
        { label: 'already known', code: -32602, message: 'Already known' },
        // HTTP 5xx・429 に載った検証の code。
        { label: 'HTTP 500 + -32501', code: -32501, message: 'AA33 reverted (or OOG)', status: 500 },
        { label: 'HTTP 429 + -32501', code: -32501, message: 'AA33 reverted (or OOG)', status: 429 },
        // HTTP 200 でも allowlist に無い code。
        { label: 'HTTP 200 + -32603', code: -32603, message: 'internal error' },
        { label: 'HTTP 200 + -32521', code: -32521, message: 'execution reverted' },
      ])('$label → 確認待ち・記録は submitting のまま・待って同じ op を送り直す', async ({ code, message, status }) => {
        walletSigns(OP1);
        mockBroadcast.mockRejectedValueOnce(bundlerSays({ code, message, status }));
        mockWait.mockRejectedValue(timeoutOf(OP1));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(error?.userOpHash).toBe(OP1.userOpHash);
        expect(stored()).toMatchObject({ status: 'submitting', signedUserOp: OP1.signedUserOp });
        expect(sentOps()).toEqual([OP1.signedUserOp, OP1.signedUserOp]);
        expect(mockWait).toHaveBeenCalledTimes(2);
        expect(loggedWarns()).toEqual(['circle.broadcast.response-lost']);
      });

      it('S1: nonce の拒否が返った op が、実は取り込まれていた → 復旧の待ちで receipt を得て、既払いの結果を返す', async () => {
        walletSigns(OP1);
        mockBroadcast.mockRejectedValueOnce(
          bundlerSays({ code: -32500, message: 'AA25 invalid account nonce' }),
        );
        mockWait.mockResolvedValueOnce(receiptOf(OP1));

        const res = await run();

        expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
        expect(stored()?.status).toBe('confirmed');
        expect(sentOps()).toEqual([OP1.signedUserOp]);
      });

      it('分類を持たない error (CircleBroadcastError でない) は unknown: kind に似た欄があっても閉じない', async () => {
        walletSigns(OP1);
        mockBroadcast.mockRejectedValueOnce(
          Object.assign(new Error('AA33 reverted'), { kind: 'validation-rejected', code: -32501 }),
        );
        mockWait.mockRejectedValue(timeoutOf(OP1));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(stored()?.status).toBe('submitting');
      });
    });

    // 残る前提 (bundler がその hash を知らないと答えた op は取り込まれない) が破れたとき。閉じる前から同じ op の receipt を待っていた別の試み
    // (別のタブ) がいると、その試みが receipt を得る。
    describe('閉じる前から、別の試みが同じ op の receipt を待っていた', () => {
      // A (attempt-1) が送信中に、B (attempt-2) の scan が A の submitting を見つけて receipt を待つ。その後 A の送信に
      // 検証の拒否が返り、A は記録を閉じる (B はまだ何も書いていないので、時刻は A が書いたまま)。
      async function closedWhileAnotherWaits() {
        walletSigns(OP1);
        const rejection = deferred<void>();
        mockBroadcast.mockImplementationOnce(async () => {
          await rejection.promise;
          throw rejectedByValidation();
        });
        const waitOfB = deferred<'receipt' | 'timeout'>();
        mockWait.mockImplementationOnce(async () => {
          if ((await waitOfB.promise) === 'timeout') throw timeoutOf(OP1);
          return receiptOf(OP1);
        });

        const a = track(run());
        await flush();
        expect(stored()?.status).toBe('submitting');
        const b = track(run({ paymentAttemptId: 'attempt-2' }));
        await flush();
        expect(waitedHashes()).toEqual([OP1.userOpHash]);

        rejection.resolve();
        await flush();
        expect(a.error).toBeInstanceOf(CircleSendRejectedError);
        expect(stored()?.status).toBe('failed');
        expect(b.settled).toBe(false);
        return { b, waitOfB };
      }

      it('閉じたのに receipt が出た → 待っていた試みは既払いの結果を返し、記録を confirmed に直す・error の log', async () => {
        const { b, waitOfB } = await closedWhileAnotherWaits();

        waitOfB.resolve('receipt');
        await flush();

        expect(b.value).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
        expect(stored()).toMatchObject({ status: 'confirmed', userOpHash: OP1.userOpHash, txHash: OP1.txHash });
        expect(errorSpy.mock.calls).toEqual([
          ['circle.pending.confirmed-after-failed', { userOpHash: OP1.userOpHash, txHash: OP1.txHash }],
        ]);
        expect(sentOps()).toEqual([OP1.signedUserOp]);
        // 直した記録は scan の dedup に戻る: 90 秒以内の同じ内容の押下は、新しい署名を求めず既払いの結果を返す。
        mockPermit.mockClear();
        const again = await run({ paymentAttemptId: 'attempt-3' });
        expect(again).toMatchObject({ userOpHash: OP1.userOpHash, success: true });
        expect(mockPermit).not.toHaveBeenCalled();
      });

      it('receipt が出ないまま待ちが timeout → 待っていた試みは、閉じた op を送り直さず「既に終了」(何も渡していない)', async () => {
        const { b, waitOfB } = await closedWhileAnotherWaits();

        waitOfB.resolve('timeout');
        await flush();

        // B が待つ前に読んだ記録には署名済みの op が残っているが、送り直しの前の CAS (markResending) が failed を見て止める。
        expect(b.error).not.toBeInstanceOf(CirclePendingError);
        expect(b.error?.message).toBe(ENDED);
        expect(sentOps()).toEqual([OP1.signedUserOp]);
        expect(stored()?.status).toBe('failed');
        expect(loggedErrors()).toEqual([]);
      });
    });

    it('39a の「記録に従う」と噛み合う: op を渡した試みの復旧の間に記録が failed (本物の markRejected) になっていた → 確認待ち・error の log', async () => {
      walletSigns(OP1);
      mockWait.mockRejectedValueOnce(timeoutOf(OP1));
      mockWait.mockImplementationOnce(async () => {
        markRejected({
          key: KEY,
          sender: OWNER,
          userOpHash: OP1.userOpHash,
          submittedAt: stored()!.updatedAt,
          errorMessage: 'bundler rejected (code -32501): AA33 reverted (or OOG)',
          now: now(),
        });
        throw timeoutOf(OP1);
      });

      const { error } = await outcome(run());

      // 自分が渡した op があるので「既に終了」にしない (対応を残す)。閉じた記録の op は送り直さない。
      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(stored()?.status).toBe('failed');
      expect(loggedErrors()).toEqual(['circle.follow.failed-after-handoff']);
    });

    it('failed を書けない (storage) → 閉じられない = 確認待ち・記録は submitting のまま・元の error は log に残す', async () => {
      walletSigns(OP1);
      mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
      const writes = failWritesOf('failed');

      const { error } = await outcome(run());
      writes.mockRestore();

      expect(error).toBeInstanceOf(CirclePendingError);
      expect(error?.userOpHash).toBe(OP1.userOpHash);
      expect(stored()).toMatchObject({ status: 'submitting', signedUserOp: OP1.signedUserOp });
      // CAS が外れたのとは別の扱い: 待たず・送り直さずに、その場で確認待ちで終え、storage の error を log に残す。
      expect(sentOps()).toEqual([OP1.signedUserOp]);
      expect(mockWait).not.toHaveBeenCalled();
      expect(loggedWarns()).toEqual([]);
      expect(errorSpy.mock.calls).toEqual([
        [
          'circle.post_submit.unexpected',
          { userOpHash: OP1.userOpHash, error: expect.objectContaining({ name: 'PendingStoreWriteError' }) },
        ],
      ]);
    });

    // S3: 送信の用意 (bundler への 1 回用の transport を作る) は、記録を submitting にする前。
    describe('S3: 送信の用意は submitting の前', () => {
      it('平常: 用意の時点の記録は signed・送信の時点は submitting・用意は 1 回', async () => {
        walletSigns(OP1);
        mockWait.mockResolvedValueOnce(receiptOf(OP1));
        const statusAtPrepare: Array<PendingStatus | undefined> = [];
        const statusAtSend: Array<PendingStatus | undefined> = [];
        mockPrepareBroadcast.mockImplementationOnce((bundle) => {
          statusAtPrepare.push(stored()?.status);
          return async (signedUserOp) => {
            statusAtSend.push(stored()?.status);
            return mockBroadcast({ bundle, signedUserOp });
          };
        });

        const res = await run();

        expect(res.success).toBe(true);
        expect(statusAtPrepare).toEqual(['signed']);
        expect(statusAtSend).toEqual(['submitting']);
        expect(mockPrepareBroadcast).toHaveBeenCalledTimes(1);
        expect(mockPrepareBroadcast).toHaveBeenCalledWith(fakeBundle);
        expect(sentOps()).toEqual([OP1.signedUserOp]);
      });

      it('用意が投げる (bundle の設定の誤り) → ふつうの error (送っていない試みを確認待ちにしない)・記録は signed のまま', async () => {
        walletSigns(OP1);
        mockPrepareBroadcast.mockImplementationOnce(() => {
          throw new Error('No URL was provided to the Transport.');
        });

        const { error } = await outcome(run());

        expect(error).not.toBeInstanceOf(CirclePendingError);
        expect(error?.message).toBe('No URL was provided to the Transport.');
        expect(stored()?.status).toBe('signed');
        expect(sentOps()).toEqual([]);
        expect(mockWait).not.toHaveBeenCalled();
        expect(loggedErrors()).toEqual([]);
      });
    });

    const notClosedLogs = () =>
      warnSpy.mock.calls.filter((c) => c[0] === 'circle.broadcast.rejected-not-closed');

    // F1 (Codex の指摘 1): 閉じる資格は「自分の op の記録を、自分で signed → submitting にした」試みだけ。同じ key の 2 つの
    // 試み (複製したタブ) は署名を上書きし合える (markSigned は signed からの再入を許す・markSubmitting は submitting からの再入を
    // 許す)。localStorage はタブの間で原子的でないので、別のタブの書き込みは、こちらの同期の 2 行の間にも入りうる。ここでは
    // その書き込みを、こちらの markSigned と markSubmitting の間 (送信の用意 = prepareCircleBroadcast の呼び出し) に差し込む。
    describe('F1: 閉じる資格は、自分の op の記録を自分で signed → submitting にした試みだけ', () => {
      const OP3 = op('33');

      it('Codex の筋 1: A が signed A → B が signed B で上書き → A が submitting にして A を送る (受理) → B が submitting に再入して B を送り拒否 → B は閉じない・次の押下は新しい支払いを開かない', async () => {
        // B = この試み (本物の executeCirclePayment)。A = 同じ key を使う別のタブ (書き込みだけを、その時点に差し込む)。
        seed('awaiting_signature', { at: 900 });
        mockPermit.mockResolvedValue(PERMIT);
        mockPrepare.mockImplementationOnce(async () => {
          // A のタブが、先に自分の署名 (OP1) を保存する。
          markSigned({ key: KEY, sender: OWNER, signedUserOp: OP1.signedUserOp, userOpHash: OP1.userOpHash, now: now() });
          return { signedUserOp: OP2.signedUserOp, userOpHash: OP2.userOpHash };
        });
        // B の markSigned (OP2 で上書き) の後・B の markSubmitting の前に、A のタブが submitting にして自分の op (OP1) を送り、
        // bundler が受理する (A の送信はこのタブの外なので mockBroadcast には載らない)。
        const acceptedFromA: unknown[] = [];
        mockPrepareBroadcast.mockImplementationOnce((bundle) => {
          markSubmitting({ key: KEY, sender: OWNER, now: now() });
          acceptedFromA.push(OP1.signedUserOp);
          return (signedUserOp) => mockBroadcast({ bundle, signedUserOp });
        });
        mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
        mockWait.mockRejectedValue(timeoutOf(OP2));

        const { error } = await outcome(run());

        // B の記録は、B が signed → submitting にしたものではない (A が先に submitting にした) → 閉じる資格が無い = 今までどおり
        // 確認待ち。記録は submitting のまま (A の op は取り込まれうる)。
        expect(error).toBeInstanceOf(CirclePendingError);
        expect(stored()).toMatchObject({ status: 'submitting', userOpHash: OP2.userOpHash });
        expect(acceptedFromA).toEqual([OP1.signedUserOp]);
        expect(notClosedLogs()).toEqual([
          [
            'circle.broadcast.rejected-not-closed',
            { userOpHash: OP2.userOpHash, code: -32501, reason: 'not-own-submit' },
          ],
        ]);

        // 次の押下 (hook が対応を消した後と同じ = 新しい attemptId): scan が submitting の記録を見つけて復旧する。新しい署名を
        // 求めず、新しい op (OP3) を送らない (直す前は、閉じた記録を scan が数えず、A の op が生きているのに OP3 を払った)。
        mockPermit.mockClear();
        mockPrepare.mockClear();
        walletSigns(OP3);
        const next = await outcome(run({ paymentAttemptId: 'attempt-2' }));
        expect(next.error).toBeInstanceOf(CirclePendingError);
        // 場面の符号 (PR-39c): 1 回目は自分の key の記録の確認待ち = (a)。2 回目は別の key の記録を付け替えずに復旧した = (e)。
        expect(takePendingCodes()).toEqual(['unconfirmed', 'unconfirmed_earlier']);
        expect(mockPermit).not.toHaveBeenCalled();
        expect(mockPrepare).not.toHaveBeenCalled();
        expect(sentOps()).not.toContainEqual(OP3.signedUserOp);
      });

      it('同じ筋を A の側から: markSigned の後に記録を B の署名で上書きされたまま submitting にした A は、自分の op が拒否されても閉じようとしない', async () => {
        walletSigns(OP1);
        mockPrepareBroadcast.mockImplementationOnce((bundle) => {
          // A の markSigned の後・markSubmitting の前に、B のタブが同じ key の記録を自分の署名 (OP2) で上書きする。
          markSigned({ key: KEY, sender: OWNER, signedUserOp: OP2.signedUserOp, userOpHash: OP2.userOpHash, now: now() });
          return (signedUserOp) => mockBroadcast({ bundle, signedUserOp });
        });
        mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
        mockWait.mockRejectedValue(timeoutOf(OP2));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(sentOps()[0]).toBe(OP1.signedUserOp);
        expect(stored()).toMatchObject({ status: 'submitting', userOpHash: OP2.userOpHash });
        // 資格が無いので、記録を閉じに行かない (markRejected の hash の確認に頼らない)。
        expect(notClosedLogs()).toEqual([
          [
            'circle.broadcast.rejected-not-closed',
            { userOpHash: OP1.userOpHash, code: -32501, reason: 'not-own-submit' },
          ],
        ]);
      });

      it('逆の順: A の markSigned の後に、B が signed B → submitting → 拒否で閉じた → A の markSubmitting は failed から外れ、A は何も送らない', async () => {
        walletSigns(OP1);
        mockPrepareBroadcast.mockImplementationOnce((bundle) => {
          // B のタブ: 上書き (signed OP2) → 自分で submitting → 送信が検証で拒否 → 閉じる。
          markSigned({ key: KEY, sender: OWNER, signedUserOp: OP2.signedUserOp, userOpHash: OP2.userOpHash, now: now() });
          const submittedByB = markSubmitting({ key: KEY, sender: OWNER, now: now() });
          markRejected({
            key: KEY,
            sender: OWNER,
            userOpHash: OP2.userOpHash,
            submittedAt: submittedByB.updatedAt,
            errorMessage: 'bundler rejected (code -32501): AA33 reverted (or OOG)',
            now: now(),
          });
          return (signedUserOp) => mockBroadcast({ bundle, signedUserOp });
        });

        const { error } = await outcome(run());

        // markSubmitting が外れる (境界の外 = ふつうの error)。A の op は bundler に渡らない。
        expect(error).toBeInstanceOf(PendingStateError);
        expect(error).not.toBeInstanceOf(CirclePendingError);
        expect(sentOps()).toEqual([]);
        expect(mockWait).not.toHaveBeenCalled();
        expect(stored()).toMatchObject({ status: 'failed', userOpHash: OP2.userOpHash });
      });
    });

    // F2 (Codex の指摘 2・3): 閉じてよいのは、自分の markSubmitting から短い時間 (30 秒未満) のうちに届いた拒否だけ。ほかの
    // 試みがこの op を送り直すのは receipt の待ち (120 秒) が timeout した後だけで、いちばん早い待ちが始まるのは記録が submitting に
    // なった後なので、30 秒より前の拒否の処理は、ほかの試みの送り直しより前に終わる。経過は壁時計 (now) と単調な時計 (monotonicNow) の両方で測る。
    describe('F2: 時間の柵 — 自分の markSubmitting から 30 秒未満に届いた拒否だけで閉じる', () => {
      let mono: number;
      const monotonicNow = () => mono;
      beforeEach(() => {
        mono = 0;
      });
      // 送信の答え (検証の拒否) が、自分の markSubmitting から wallMs (壁時計)・monoMs (単調な時計) たって届く。
      function rejectedAfter(elapsed: { wallMs: number; monoMs: number }) {
        mockBroadcast.mockImplementationOnce(async () => {
          const submittedAt = stored()!.updatedAt;
          clock = submittedAt + elapsed.wallMs; // 次の now() が、この時刻を返す
          mono += elapsed.monoMs;
          throw rejectedByValidation();
        });
      }
      const late = (wallMs: number, monoMs: number) => [
        [
          'circle.broadcast.rejected-not-closed',
          { userOpHash: OP1.userOpHash, code: -32501, reason: 'late', wallElapsedMs: wallMs, monoElapsedMs: monoMs },
        ],
      ];

      it('上限は receipt の待ちの timeout の半分以下 (ほかの試みが送り直しに着く前に閉じる)', () => {
        expect(REJECTION_CLOSE_WINDOW_MS).toBe(30_000);
        expect(actualCircleAccount.CIRCLE_RECEIPT_TIMEOUT_MS).toBe(120_000);
        expect(REJECTION_CLOSE_WINDOW_MS * 2).toBeLessThanOrEqual(actualCircleAccount.CIRCLE_RECEIPT_TIMEOUT_MS);
      });

      it('どちらの時計でも 29,999 ms → 閉じる', async () => {
        walletSigns(OP1);
        rejectedAfter({ wallMs: 29_999, monoMs: 29_999 });

        const { error } = await outcome(run({ monotonicNow }));

        expect(error).toBeInstanceOf(CircleSendRejectedError);
        expect(stored()?.status).toBe('failed');
      });

      it.each([
        { label: '壁時計だけ 30,000 ms (単調な時計は 0)', wallMs: 30_000, monoMs: 0 },
        { label: '単調な時計だけ 30,000 ms (壁時計は 0 = 端末の時計を戻した・止まっていた)', wallMs: 0, monoMs: 30_000 },
        { label: '壁時計が負 (時計が戻された)', wallMs: -1, monoMs: 10 },
        { label: '両方 60,000 ms (receipt の待ちの timeout よりは前)', wallMs: 60_000, monoMs: 60_000 },
      ])('$label → 閉じない・今までどおり確認待ち (記録は submitting・op も残る)', async ({ wallMs, monoMs }) => {
        walletSigns(OP1);
        rejectedAfter({ wallMs, monoMs });
        mockWait.mockRejectedValue(timeoutOf(OP1));

        const { error } = await outcome(run({ monotonicNow }));

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(error?.userOpHash).toBe(OP1.userOpHash);
        expect(stored()).toMatchObject({ status: 'submitting', signedUserOp: OP1.signedUserOp });
        expect(notClosedLogs()).toEqual(late(wallMs, monoMs));
      });

      it('Codex の筋 3: 拒否の処理がタブの停止で 125 秒遅れ、その間に #1079 より前のコードのタブが待ちの timeout の後に送り直して受理された (時刻は送り直しの後に書く = まだ書いていない) → 閉じず、復旧の待ちで receipt を得て既払いの結果', async () => {
        walletSigns(OP1);
        // 古いタブの送り直しは、この試みの送信と同じ op を bundler に渡す (受理)。記録には何も書かない (古いコードは送り直しの
        // 後に時刻を書く)。status・hash・updatedAt は、この試みが書いたまま = markRejected の 3 つの確認では見分けられない。
        rejectedAfter({ wallMs: 125_000, monoMs: 125_000 });
        mockWait.mockResolvedValueOnce(receiptOf(OP1));

        const res = await run({ monotonicNow });

        expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
        expect(stored()).toMatchObject({ status: 'confirmed', userOpHash: OP1.userOpHash });
        expect(notClosedLogs()).toEqual(late(125_000, 125_000));
      });
    });

    // F5 (PR #1084 の Codex の指摘): 検証の拒否だけでは閉じない。閉じる前に bundler にその op の状態を 1 回聞き
    // (circleAccount の readCircleUserOpStatus = pimlico_getUserOperationStatus)、「その hash を知らない」(not_found) と答えたとき
    // だけ閉じる。送信が途中で 2 回届き、1 回目は受理され、重複の配送にだけ拒否が返る形は、拒否の文の語に関係なく起こる。
    // 偽物の既定は not_found (この file の beforeEach)。読めなかったときの本物の戻り値は { unknownToBundler: false,
    // status: 'unreadable:…' } (投げない。HTTP の request からの確認は tests/lib/smartAccount/pimlicoSend.test.ts と circleAccount.test.ts)。
    describe('F5: 閉じる前に、bundler がその op の hash を知らないことを確かめる', () => {
      const PVG = { code: -32500, message: 'preVerificationGas is not enough, required: 50001, got: 50000' };
      const statusNotClosed = (code: number, status: string) => [
        [
          'circle.broadcast.rejected-not-closed',
          { userOpHash: OP1.userOpHash, code, reason: 'status', status },
        ],
      ];

      it('not_found → 今までどおり閉じる。聞くのは 1 回・この bundle・拒否された op の hash・送信の後', async () => {
        walletSigns(OP1);
        mockBroadcast.mockRejectedValueOnce(rejectedByValidation());

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CircleSendRejectedError);
        expect(stored()?.status).toBe('failed');
        expect(mockStatus.mock.calls).toEqual([[fakeBundle, OP1.userOpHash]]);
        expect(mockStatus.mock.invocationCallOrder[0]).toBeGreaterThan(
          mockBroadcast.mock.invocationCallOrder[0],
        );
      });

      it('Codex の筋: 1 回目の配送は受理されていて、重複の配送に語に当たらない拒否 (preVerificationGas) → status は submitted → 閉じず、復旧の待ちで receipt を得て既払いの結果 (新しい署名・新しい op なし)', async () => {
        walletSigns(OP1);
        mockBroadcast.mockRejectedValueOnce(bundlerSays(PVG));
        mockStatus.mockResolvedValueOnce({ unknownToBundler: false, status: 'submitted' });
        mockWait.mockResolvedValueOnce(receiptOf(OP1));

        const res = await run();

        // 直す前 (1dd6cfdb): 記録を failed に閉じて CircleSendRejectedError → hook が対応を消し、次の押下が新しい op を送る
        // (受理済みの 1 回目の op と両方取り込まれる)。
        expect(res).toMatchObject({ userOpHash: OP1.userOpHash, txHash: OP1.txHash, success: true });
        expect(stored()).toMatchObject({ status: 'confirmed', userOpHash: OP1.userOpHash });
        expect(sentOps()).toEqual([OP1.signedUserOp]);
        expect(mockPermit).toHaveBeenCalledTimes(1);
        expect(mockPrepare).toHaveBeenCalledTimes(1);
        expect(mockStatus.mock.calls).toEqual([[fakeBundle, OP1.userOpHash]]);
        expect(notClosedLogs()).toEqual(statusNotClosed(-32500, 'submitted'));
      });

      it.each([
        // permissionless の PimlicoUserOperationStatus にある値 (not_found 以外の全部)。
        'not_submitted',
        'submitted',
        'rejected',
        'reverted',
        'included',
        'failed',
        // 型に無い値。
        'queued',
        // 読めなかった (通信の失敗・timeout・JSON-RPC の error・形の崩れた応答)。
        'unreadable:HttpRequestError',
        'unreadable:TimeoutError',
        'unreadable:RpcRequestError -32601',
        'unreadable:malformed',
      ])('status が %s → 閉じない・今までどおり確認待ち (記録は submitting・op も残る・待って同じ op を送り直す)', async (status) => {
        walletSigns(OP1);
        mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
        mockStatus.mockResolvedValueOnce({ unknownToBundler: false, status });
        mockWait.mockRejectedValue(timeoutOf(OP1));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(error?.userOpHash).toBe(OP1.userOpHash);
        expect(stored()).toMatchObject({ status: 'submitting', signedUserOp: OP1.signedUserOp });
        expect(sentOps()).toEqual([OP1.signedUserOp, OP1.signedUserOp]);
        // 聞くのは最初の送信の拒否の 1 回だけ (復旧の送り直しでは聞かない)。
        expect(mockStatus).toHaveBeenCalledTimes(1);
        expect(notClosedLogs()).toEqual(statusNotClosed(-32501, status));
        expect(loggedErrors()).toEqual([]);
      });

      it('語に当たる拒否 (AA25) は、分類の時点で閉じない側: status を聞かない', async () => {
        walletSigns(OP1);
        mockBroadcast.mockRejectedValueOnce(
          bundlerSays({ code: -32500, message: 'AA25 invalid account nonce' }),
        );
        mockWait.mockResolvedValueOnce(receiptOf(OP1));

        await run();

        expect(mockStatus).not.toHaveBeenCalled();
        expect(stored()?.status).toBe('confirmed');
      });

      describe('時間の柵は status の答えを受け取った後に測る', () => {
        let mono: number;
        const monotonicNow = () => mono;
        beforeEach(() => {
          mono = 0;
        });
        // 拒否はすぐ届き、status の答えが、自分の markSubmitting から wallMs (壁時計)・monoMs (単調な時計) たって届く。
        function statusAnswersAfter(elapsed: { wallMs: number; monoMs: number }) {
          mockStatus.mockImplementationOnce(async () => {
            clock = stored()!.updatedAt + elapsed.wallMs; // 次の now() が、この時刻を返す
            mono += elapsed.monoMs;
            return { unknownToBundler: true, status: 'not_found' };
          });
        }

        it('status の答えが 29,999 ms で届く (not_found) → 閉じる', async () => {
          walletSigns(OP1);
          mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
          statusAnswersAfter({ wallMs: 29_999, monoMs: 29_999 });

          const { error } = await outcome(run({ monotonicNow }));

          expect(error).toBeInstanceOf(CircleSendRejectedError);
          expect(stored()?.status).toBe('failed');
        });

        it.each([
          { label: '両方の時計で 30,000 ms', wallMs: 30_000, monoMs: 30_000 },
          { label: '壁時計だけ 30,000 ms', wallMs: 30_000, monoMs: 0 },
          { label: '単調な時計だけ 30,000 ms', wallMs: 0, monoMs: 30_000 },
        ])('status の答え (not_found) が遅れて届く ($label) → 閉じない (late)・今までどおり確認待ち', async ({ wallMs, monoMs }) => {
          walletSigns(OP1);
          mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
          statusAnswersAfter({ wallMs, monoMs });
          mockWait.mockRejectedValue(timeoutOf(OP1));

          const { error } = await outcome(run({ monotonicNow }));

          expect(error).toBeInstanceOf(CirclePendingError);
          expect(stored()).toMatchObject({ status: 'submitting', signedUserOp: OP1.signedUserOp });
          expect(notClosedLogs()).toEqual([
            [
              'circle.broadcast.rejected-not-closed',
              { userOpHash: OP1.userOpHash, code: -32501, reason: 'late', wallElapsedMs: wallMs, monoElapsedMs: monoMs },
            ],
          ]);
        });

        it('status を待つ間に、別の試みが同じ op を送り直していた (送る時刻が進んでいる) → not_found と答えても閉じない (記録の確認)', async () => {
          walletSigns(OP1);
          mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
          mockStatus.mockImplementationOnce(async () => {
            markResending({ key: KEY, sender: OWNER, userOpHash: OP1.userOpHash, now: now() });
            return { unknownToBundler: true, status: 'not_found' };
          });
          mockWait.mockRejectedValue(timeoutOf(OP1));

          const { error } = await outcome(run({ monotonicNow }));

          expect(error).toBeInstanceOf(CirclePendingError);
          expect(stored()).toMatchObject({ status: 'submitting', signedUserOp: OP1.signedUserOp });
          expect(notClosedLogs()).toHaveLength(1);
          expect(notClosedLogs()[0][1]).toMatchObject({ reason: 'record-changed' });
        });
      });

      it('閉じる資格が無い試み (記録が自分の op のものでない) は、status を聞かない', async () => {
        walletSigns(OP1);
        // 送信の用意 (markSigned と markSubmitting の間) に、同じ key の別の試みが記録を自分の署名で上書きする。
        mockPrepareBroadcast.mockImplementationOnce((bundle) => {
          markSigned({ key: KEY, sender: OWNER, signedUserOp: OP2.signedUserOp, userOpHash: OP2.userOpHash, now: now() });
          return (signedUserOp) => mockBroadcast({ bundle, signedUserOp });
        });
        mockBroadcast.mockRejectedValueOnce(rejectedByValidation());
        mockWait.mockRejectedValue(timeoutOf(OP2));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(mockStatus).not.toHaveBeenCalled();
        expect(notClosedLogs()[0][1]).toMatchObject({ reason: 'not-own-submit' });
      });
    });

    // F4 (Codex の指摘 4): bundler の JSON-RPC の error の message は信頼できない外の文で、送った署名を写して返すことがある。
    // 記録の errorMessage と、新しい 2 つの log に入れる前に、16 進の長い連なり (41 桁以上) を伏せる。
    describe('F4: bundler の文は、記録と log に入れる前に 16 進の長い連なりを伏せる', () => {
      const SIG_HEX = 'a1b2c3d4e5'.repeat(13); // 130 桁 = 65 byte の署名
      const echoesSignature = () =>
        bundlerSays({ code: -32501, message: `AA33 invalid signature 0x${SIG_HEX}` });

      it('閉じたとき: 記録の errorMessage と circle.broadcast.rejected の log に署名が無い・code と AA33 は残る', async () => {
        walletSigns(OP1);
        mockBroadcast.mockRejectedValueOnce(echoesSignature());

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CircleSendRejectedError);
        expect(stored()?.errorMessage).toBe('bundler rejected (code -32501): AA33 invalid signature [redacted]');
        expect(rawRecord()).not.toContain('a1b2c3d4e5');
        const rejectedLogs = warnSpy.mock.calls.filter((c) => c[0] === 'circle.broadcast.rejected');
        expect(rejectedLogs).toEqual([
          [
            'circle.broadcast.rejected',
            { userOpHash: OP1.userOpHash, code: -32501, details: 'AA33 invalid signature [redacted]' },
          ],
        ]);
        expect(JSON.stringify(rejectedLogs)).not.toContain('a1b2c3d4e5');
      });

      it('閉じなかったとき (遅れて届いた): circle.broadcast.rejected-not-closed の log にも署名が無い', async () => {
        walletSigns(OP1);
        mockBroadcast.mockImplementationOnce(async () => {
          clock = stored()!.updatedAt + 30_000;
          throw echoesSignature();
        });
        mockWait.mockRejectedValue(timeoutOf(OP1));

        const { error } = await outcome(run());

        expect(error).toBeInstanceOf(CirclePendingError);
        expect(notClosedLogs()).toHaveLength(1);
        expect(JSON.stringify(notClosedLogs())).not.toContain('a1b2c3d4e5');
      });

      it('redactLongHex: 40 桁 (アドレス) は残し、41 桁以上は 0x の有無を問わず伏せる', () => {
        const address = '0x' + 'ab'.repeat(20);
        expect(redactLongHex(`to ${address}`)).toBe(`to ${address}`);
        expect(redactLongHex('a'.repeat(40))).toBe('a'.repeat(40));
        expect(redactLongHex('a'.repeat(41))).toBe('[redacted]');
        expect(redactLongHex(`0x${'F'.repeat(41)} tail`)).toBe('[redacted] tail');
        expect(redactLongHex(`sig ${SIG_HEX}, hash 0x${'1'.repeat(64)}`)).toBe('sig [redacted], hash [redacted]');
        expect(redactLongHex('AA33 reverted (or OOG)')).toBe('AA33 reverted (or OOG)');
      });
    });
  });
});
