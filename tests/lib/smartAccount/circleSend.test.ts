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
  reserveOrResume,
  markAwaitingSignature,
  markSigned,
  markSubmitting,
  markConfirmed,
  PENDING_KEY_PREFIX,
  type PendingStatus,
} from '@/lib/circlePending';
import { logger } from '@/lib/logger';

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

  it('別 attemptId が直近の signed (pre-submit) → CirclePendingError で並行 broadcast しない', async () => {
    happyMocks();
    seedOtherAttempt('other', 'signed', 900); // clock 開始 1000 に近い = 直近
    await expect(run()).rejects.toBeInstanceOf(CirclePendingError);
    expect(mockPermit).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

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
