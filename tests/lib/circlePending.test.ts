import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import {
  abandon,
  ATTEMPT_KEY_PREFIX,
  clearStableAttemptId,
  computeCallHash,
  computeIdempotencyKey,
  findLiveByCallHash,
  findRecoverable,
  gcStalePreSubmit,
  isPreSubmit,
  isTerminal,
  loadPendingRecord,
  markAwaitingSignature,
  markConfirmed,
  markRejected,
  markResending,
  markSigned,
  markSubmitting,
  PENDING_KEY_PREFIX,
  PendingAuthorizationError,
  PendingStateError,
  PendingStoreUnavailableError,
  PendingStoreWriteError,
  pruneStaleSubmitting,
  pruneTerminal,
  reserveOrResume,
  setStableAttemptId,
  stableAttemptId,
  type SerializedUserOp,
} from '@/lib/circlePending';
import { logger } from '@/lib/logger';

const SENDER = getAddress('0x1111111111111111111111111111111111111111');
const OTHER = getAddress('0x2222222222222222222222222222222222222222');
const PAYMASTER = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966');
const MERCHANT = getAddress('0x4444444444444444444444444444444444444444');
const CHAIN_ID = 421614;

const CALLS = [{ to: MERCHANT, data: '0xabcd' as Hex, value: 0n }];

const SIGNED_OP: SerializedUserOp = {
  sender: SENDER,
  nonce: '5',
  callData: '0xdeadbeef',
  signature: '0x' + 'ab'.repeat(65),
  maxFeePerGas: '1000000000',
};

function setup(overrides: Partial<Parameters<typeof reserveOrResume>[0]> = {}) {
  const callHash = computeCallHash(CALLS);
  const key = computeIdempotencyKey({
    chainId: CHAIN_ID,
    sender: SENDER,
    paymentAttemptId: 'attempt-1',
    callHash,
  });
  const res = reserveOrResume({
    key,
    chainId: CHAIN_ID,
    sender: SENDER,
    callHash,
    paymentAttemptId: 'attempt-1',
    paymaster: PAYMASTER,
    now: 1_000,
    ...overrides,
  });
  return { key, callHash, ...res };
}

// happy path で submitting まで進めるヘルパ。
function advanceToSubmitting(key: string) {
  markAwaitingSignature({ key, sender: SENDER, now: 1_100 });
  markSigned({
    key,
    sender: SENDER,
    signedUserOp: SIGNED_OP,
    userOpHash: '0xhash' as Hex,
    permitDigest: '0xdigest' as Hex,
    now: 1_200,
  });
  markSubmitting({ key, sender: SENDER, now: 1_300 });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('computeCallHash', () => {
  it('同じ calls なら決定的に同じ hash (value 既定 0)', () => {
    const a = computeCallHash([{ to: MERCHANT, data: '0xabcd' as Hex }]);
    const b = computeCallHash([
      { to: MERCHANT, data: '0xabcd' as Hex, value: 0n },
    ]);
    expect(a).toBe(b);
  });

  it('calls が違えば hash が変わる', () => {
    const a = computeCallHash([{ to: MERCHANT, data: '0xabcd' as Hex }]);
    const b = computeCallHash([{ to: MERCHANT, data: '0xab00' as Hex }]);
    expect(a).not.toBe(b);
  });

  it('to のチェックサム表記差は同一視される (getAddress 正規化)', () => {
    const a = computeCallHash([{ to: MERCHANT.toLowerCase() as Address, data: '0x' }]);
    const b = computeCallHash([{ to: MERCHANT, data: '0x' }]);
    expect(a).toBe(b);
  });
});

describe('computeIdempotencyKey', () => {
  it('sender のチェックサム差を吸収して安定キーになる', () => {
    const callHash = computeCallHash(CALLS);
    const a = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER,
      paymentAttemptId: 'x',
      callHash,
    });
    const b = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER.toLowerCase() as Address,
      paymentAttemptId: 'x',
      callHash,
    });
    expect(a).toBe(b);
  });

  it('paymentAttemptId が違えば別キー (正規の再決済を区別)', () => {
    const callHash = computeCallHash(CALLS);
    const a = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER,
      paymentAttemptId: 'a',
      callHash,
    });
    const b = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER,
      paymentAttemptId: 'b',
      callHash,
    });
    expect(a).not.toBe(b);
  });
});

describe('reserveOrResume', () => {
  it('初回は reserved を新規作成し resumed=false', () => {
    const { record, resumed, key } = setup();
    expect(resumed).toBe(false);
    expect(record.status).toBe('reserved');
    expect(record.sender).toBe(SENDER.toLowerCase());
    expect(record.provider).toBe('circle');
    expect(record.paymaster).toBe(PAYMASTER);
    // 実際に永続されている
    expect(loadPendingRecord(key)?.status).toBe('reserved');
  });

  it('同一キーの 2 回目は既存を resume=true で返す (重複作成しない)', () => {
    const first = setup();
    const second = setup();
    expect(second.resumed).toBe(true);
    expect(second.record.createdAt).toBe(first.record.createdAt);
  });

  it('別 sender が同一キーを触ろうとすると authorization エラー', () => {
    const { key, callHash } = setup();
    expect(() =>
      reserveOrResume({
        key,
        chainId: CHAIN_ID,
        sender: OTHER,
        callHash,
        paymentAttemptId: 'attempt-1',
        paymaster: PAYMASTER,
        now: 2_000,
      }),
    ).toThrow(PendingAuthorizationError);
  });

  it('corrupt な既存レコードは不在扱いで新規作成する', () => {
    const { key } = setup();
    window.localStorage.setItem(PENDING_KEY_PREFIX + key, '{not json');
    const again = reserveOrResume({
      key,
      chainId: CHAIN_ID,
      sender: SENDER,
      callHash: computeCallHash(CALLS),
      paymentAttemptId: 'attempt-1',
      paymaster: PAYMASTER,
      now: 3_000,
    });
    expect(again.resumed).toBe(false);
    expect(again.record.createdAt).toBe(3_000);
  });
});

describe('FSM happy path', () => {
  it('reserved → awaiting → signed → submitting → confirmed', () => {
    const { key } = setup();
    const a = markAwaitingSignature({ key, sender: SENDER, now: 1_100 });
    expect(a.status).toBe('awaiting_signature');
    const s = markSigned({
      key,
      sender: SENDER,
      signedUserOp: SIGNED_OP,
      userOpHash: '0xhash' as Hex,
      now: 1_200,
    });
    expect(s.status).toBe('signed');
    expect(s.signedUserOp).toEqual(SIGNED_OP);
    expect(s.userOpHash).toBe('0xhash');
    const sub = markSubmitting({ key, sender: SENDER, now: 1_300 });
    expect(sub.status).toBe('submitting');
    const c = markConfirmed({
      key,
      sender: SENDER,
      txHash: '0xtx' as Hex,
      success: true,
      now: 1_400,
    });
    expect(c.status).toBe('confirmed');
    expect(c.txHash).toBe('0xtx');
  });
});

describe('CAS / FSM ガード', () => {
  it('reserved から直接 confirmed にはできない (CAS 失敗)', () => {
    const { key } = setup();
    expect(() =>
      markConfirmed({ key, sender: SENDER, txHash: '0xtx' as Hex, success: true, now: 2_000 }),
    ).toThrow(PendingStateError);
  });

  it('署名済 op が無いまま markSubmitting すると throw (復旧不能防止)', () => {
    const { key } = setup();
    markAwaitingSignature({ key, sender: SENDER, now: 1_100 });
    // markSigned を飛ばす
    expect(() => markSubmitting({ key, sender: SENDER, now: 1_300 })).toThrow(
      /署名済 UserOp が無い/,
    );
  });

  it('submitting からは abandon できない (宙吊り防止)', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    expect(() => abandon({ key, sender: SENDER, now: 1_500 })).toThrow(
      PendingStateError,
    );
  });

  it('存在しない record の遷移は throw', () => {
    expect(() =>
      markAwaitingSignature({ key: 'nope', sender: SENDER, now: 1 }),
    ).toThrow(PendingStateError);
  });

  it('遷移時に別 sender だと authorization エラー', () => {
    const { key } = setup();
    expect(() =>
      markAwaitingSignature({ key, sender: OTHER, now: 1_100 }),
    ).toThrow(PendingAuthorizationError);
  });
});

// 第 10 回レビュー H-W: 復旧の送り直しの前の CAS。呼び出し側 (circleSend の recoverSubmitting) は receipt を最大 120 秒待った
// 後にここへ来る。待つ前に読んだ記録を信じず、「いまも submitting で、送り直す op の記録」のときだけ時刻を書く。
describe('markResending (送り直しの前の CAS)', () => {
  const HASH = '0xhash' as Hex; // advanceToSubmitting が書く userOpHash
  const raw = (key: string) => window.localStorage.getItem(PENDING_KEY_PREFIX + key);

  it('submitting で同じ userOpHash → 時刻だけ進む (status・op はそのまま)', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    const next = markResending({ key, sender: SENDER, userOpHash: HASH, now: 5_000 });
    expect(next.status).toBe('submitting');
    expect(next.updatedAt).toBe(5_000);
    const stored = loadPendingRecord(key);
    expect(stored?.status).toBe('submitting');
    expect(stored?.updatedAt).toBe(5_000);
    expect(stored?.userOpHash).toBe(HASH);
    expect(stored?.signedUserOp).toEqual(SIGNED_OP);
  });

  it('待つ間に confirmed になっていた → PendingStateError・記録を書き換えない', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    markConfirmed({ key, sender: SENDER, txHash: '0xtx' as Hex, success: true, now: 2_000 });
    const before = raw(key);
    expect(() =>
      markResending({ key, sender: SENDER, userOpHash: HASH, now: 5_000 }),
    ).toThrow(PendingStateError);
    expect(raw(key)).toBe(before);
  });

  it('userOpHash が違う (別の op の記録に替わっていた) → PendingStateError・記録を書き換えない', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    const before = raw(key);
    expect(() =>
      markResending({ key, sender: SENDER, userOpHash: '0xother' as Hex, now: 5_000 }),
    ).toThrow(PendingStateError);
    expect(raw(key)).toBe(before);
  });

  it('記録が無い → PendingStateError (作らない)', () => {
    expect(() =>
      markResending({ key: 'nope', sender: SENDER, userOpHash: HASH, now: 5_000 }),
    ).toThrow(PendingStateError);
    expect(raw('nope')).toBeNull();
  });

  it('signed (まだ送っていない記録) からは進めない → PendingStateError', () => {
    const { key } = setup();
    markAwaitingSignature({ key, sender: SENDER, now: 1_100 });
    markSigned({ key, sender: SENDER, signedUserOp: SIGNED_OP, userOpHash: HASH, now: 1_200 });
    expect(() =>
      markResending({ key, sender: SENDER, userOpHash: HASH, now: 5_000 }),
    ).toThrow(PendingStateError);
    expect(loadPendingRecord(key)?.status).toBe('signed');
  });

  it('別 sender だと authorization エラー (CAS の失敗とは別の error)', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    expect(() =>
      markResending({ key, sender: OTHER, userOpHash: HASH, now: 5_000 }),
    ).toThrow(PendingAuthorizationError);
  });

  it('書けなければ PendingStoreWriteError (CAS の失敗とは別の error)', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() =>
      markResending({ key, sender: SENDER, userOpHash: HASH, now: 5_000 }),
    ).toThrow(PendingStoreWriteError);
  });
});

// 第 10 回レビュー H-W: receipt を取った op の hash を渡すと、記録の userOpHash が同じときだけ confirmed にする。
describe('markConfirmed の userOpHash の確認', () => {
  const HASH = '0xhash' as Hex;
  const raw = (key: string) => window.localStorage.getItem(PENDING_KEY_PREFIX + key);
  // 保存済みの記録を直接書き換えて failed を作る (署名済みの op が残った形 = 旧 record)。markRejected が書く本物の failed
  // (署名済みの op を消した形) からの confirmed は、下の「markRejected」の describe で確かめる。
  function forceStatus(key: string, status: string) {
    const parsed = JSON.parse(raw(key)!) as Record<string, unknown>;
    window.localStorage.setItem(PENDING_KEY_PREFIX + key, JSON.stringify({ ...parsed, status }));
  }

  it('userOpHash が同じ → confirmed', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    const c = markConfirmed({
      key,
      sender: SENDER,
      txHash: '0xtx' as Hex,
      success: true,
      now: 2_000,
      userOpHash: HASH,
    });
    expect(c.status).toBe('confirmed');
    expect(loadPendingRecord(key)?.txHash).toBe('0xtx');
  });

  it('userOpHash が違う → PendingStateError・記録を書き換えない (別の op の記録を confirmed にしない)', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    const before = raw(key);
    expect(() =>
      markConfirmed({
        key,
        sender: SENDER,
        txHash: '0xtx' as Hex,
        success: true,
        now: 2_000,
        userOpHash: '0xother' as Hex,
      }),
    ).toThrow(PendingStateError);
    expect(raw(key)).toBe(before);
  });

  it('confirmed への再入も、userOpHash が同じときだけ', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    markConfirmed({ key, sender: SENDER, txHash: '0xtx' as Hex, success: true, now: 2_000, userOpHash: HASH });
    expect(
      markConfirmed({ key, sender: SENDER, txHash: '0xtx' as Hex, success: true, now: 2_100, userOpHash: HASH })
        .status,
    ).toBe('confirmed');
    expect(() =>
      markConfirmed({
        key,
        sender: SENDER,
        txHash: '0xtx2' as Hex,
        success: true,
        now: 2_200,
        userOpHash: '0xother' as Hex,
      }),
    ).toThrow(PendingStateError);
    expect(loadPendingRecord(key)?.txHash).toBe('0xtx');
  });

  it('failed の記録は、userOpHash が同じときだけ confirmed に直す (receipt が真実)・error の log を残す', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { key } = setup();
    advanceToSubmitting(key);
    forceStatus(key, 'failed');

    const c = markConfirmed({
      key,
      sender: SENDER,
      txHash: '0xtx' as Hex,
      success: true,
      now: 2_000,
      userOpHash: HASH,
    });

    expect(c.status).toBe('confirmed');
    expect(loadPendingRecord(key)?.status).toBe('confirmed');
    expect(loadPendingRecord(key)?.txHash).toBe('0xtx');
    expect(errorSpy).toHaveBeenCalledWith('circle.pending.confirmed-after-failed', {
      userOpHash: HASH,
      txHash: '0xtx',
    });
  });

  it('failed の記録は、userOpHash が違えば直さない', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { key } = setup();
    advanceToSubmitting(key);
    forceStatus(key, 'failed');
    const before = raw(key);
    expect(() =>
      markConfirmed({
        key,
        sender: SENDER,
        txHash: '0xtx' as Hex,
        success: true,
        now: 2_000,
        userOpHash: '0xother' as Hex,
      }),
    ).toThrow(PendingStateError);
    expect(raw(key)).toBe(before);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('userOpHash を渡さない呼び出しは今までどおり: failed からは confirmed にできない', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    forceStatus(key, 'failed');
    expect(() =>
      markConfirmed({ key, sender: SENDER, txHash: '0xtx' as Hex, success: true, now: 2_000 }),
    ).toThrow(PendingStateError);
    expect(loadPendingRecord(key)?.status).toBe('failed');
  });

  it('abandoned の記録は、userOpHash が同じでも confirmed にしない', () => {
    const { key } = setup();
    markAwaitingSignature({ key, sender: SENDER, now: 1_100 });
    markSigned({ key, sender: SENDER, signedUserOp: SIGNED_OP, userOpHash: HASH, now: 1_200 });
    abandon({ key, sender: SENDER, now: 1_300 });
    expect(() =>
      markConfirmed({
        key,
        sender: SENDER,
        txHash: '0xtx' as Hex,
        success: true,
        now: 2_000,
        userOpHash: HASH,
      }),
    ).toThrow(PendingStateError);
    expect(loadPendingRecord(key)?.status).toBe('abandoned');
  });
});

// 第 10 回レビュー H-X (PR-39b): 自分の最初の送信を bundler が検証で拒否したときに、その試みだけが記録を failed に閉じる。
// ここ (markRejected) が確かめるのは、記録がいまも「submitting・同じ userOpHash・updatedAt が自分の markSubmitting の返した
// 時刻」であることだけ (別のタブとの間で原子的ではない)。閉じる資格と時間の柵は呼び出し側 (lib/smartAccount/circleSend.ts) が見る
// = tests/lib/smartAccount/circleSend.test.ts の「F1」「F2」。
describe('markRejected (最初の送信の検証拒否で submitting → failed)', () => {
  const HASH = '0xhash' as Hex; // advanceToSubmitting が書く userOpHash
  const SUBMITTED_AT = 1_300; // advanceToSubmitting の markSubmitting が書く updatedAt
  const raw = (key: string) => window.localStorage.getItem(PENDING_KEY_PREFIX + key);
  const reject = (key: string, overrides: Partial<Parameters<typeof markRejected>[0]> = {}) =>
    markRejected({
      key,
      sender: SENDER,
      userOpHash: HASH,
      submittedAt: SUBMITTED_AT,
      errorMessage: 'bundler rejected (code -32501): AA33 reverted',
      now: 5_000,
      ...overrides,
    });

  it('自分が submitting にしたままの記録 → failed・errorMessage を残し、署名済みの op を記録から消す (userOpHash は残す)', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    expect(loadPendingRecord(key)?.signedUserOp).toEqual(SIGNED_OP);

    const next = reject(key);

    expect(next.status).toBe('failed');
    expect('signedUserOp' in next).toBe(false);
    const stored = JSON.parse(raw(key)!) as Record<string, unknown>;
    expect(stored.status).toBe('failed');
    expect(stored.updatedAt).toBe(5_000);
    expect(stored.errorMessage).toBe('bundler rejected (code -32501): AA33 reverted');
    expect(stored.userOpHash).toBe(HASH);
    expect('signedUserOp' in stored).toBe(false);
    // 署名 (SIGNED_OP.signature) が、記録のどこにも残っていない。
    expect(raw(key)).not.toContain(String(SIGNED_OP.signature));
  });

  it('markSubmitting の返した updatedAt を、そのまま submittedAt に渡せる', () => {
    const { key } = setup();
    markAwaitingSignature({ key, sender: SENDER, now: 1_100 });
    markSigned({ key, sender: SENDER, signedUserOp: SIGNED_OP, userOpHash: HASH, now: 1_200 });
    const submitted = markSubmitting({ key, sender: SENDER, now: 1_234 });
    expect(reject(key, { submittedAt: submitted.updatedAt }).status).toBe('failed');
  });

  it('updatedAt が違う (ほかの試みが送り直した = markResending が時刻を書いた) → PendingStateError・記録を書き換えない', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    markResending({ key, sender: SENDER, userOpHash: HASH, now: 4_000 });
    const before = raw(key);

    expect(() => reject(key)).toThrow(PendingStateError);

    expect(raw(key)).toBe(before);
    expect(loadPendingRecord(key)).toMatchObject({ status: 'submitting', signedUserOp: SIGNED_OP });
  });

  it('userOpHash が違う (別の op の記録に替わっていた) → PendingStateError・記録を書き換えない', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    const before = raw(key);
    expect(() => reject(key, { userOpHash: '0xother' as Hex })).toThrow(PendingStateError);
    expect(raw(key)).toBe(before);
  });

  it('confirmed になっていた (ほかの試みが receipt を取った) → PendingStateError・confirmed のまま', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    // 時刻は SUBMITTED_AT のまま (updatedAt の確認だけでは見分けられない形) にして、status の確認を固定する。
    markConfirmed({ key, sender: SENDER, txHash: '0xtx' as Hex, success: true, now: SUBMITTED_AT });
    const before = raw(key);
    expect(() => reject(key)).toThrow(PendingStateError);
    expect(raw(key)).toBe(before);
  });

  it.each(['signed', 'abandoned'] as const)('%s (送っていない記録) は failed にしない', (status) => {
    const { key } = setup();
    markAwaitingSignature({ key, sender: SENDER, now: 1_100 });
    markSigned({ key, sender: SENDER, signedUserOp: SIGNED_OP, userOpHash: HASH, now: SUBMITTED_AT });
    if (status === 'abandoned') abandon({ key, sender: SENDER, now: SUBMITTED_AT });
    expect(() => reject(key)).toThrow(PendingStateError);
    expect(loadPendingRecord(key)?.status).toBe(status);
  });

  it('記録が無い → PendingStateError (作らない)', () => {
    expect(() => reject('nope')).toThrow(PendingStateError);
    expect(raw('nope')).toBeNull();
  });

  it('errorMessage は 200 字で切って保存する', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    reject(key, { errorMessage: 'x'.repeat(500) });
    expect(loadPendingRecord(key)?.errorMessage).toBe('x'.repeat(200));
  });

  it('別 sender だと authorization エラー・書けなければ PendingStoreWriteError (CAS の失敗とは別の error)', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    expect(() => reject(key, { sender: OTHER })).toThrow(PendingAuthorizationError);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => reject(key)).toThrow(PendingStoreWriteError);
  });

  it('閉じた記録は、scan (findLiveByCallHash・findRecoverable) に出ない・24 時間で掃除される', () => {
    const { key, callHash } = setup();
    advanceToSubmitting(key);
    reject(key);
    expect(findLiveByCallHash({ sender: SENDER, chainId: CHAIN_ID, callHash })).toEqual([]);
    expect(findRecoverable({ sender: SENDER, chainId: CHAIN_ID })).toEqual([]);
    const DAY = 24 * 60 * 60 * 1000;
    expect(pruneTerminal(DAY, 5_000 + DAY)).toBe(0);
    expect(pruneTerminal(DAY, 5_000 + DAY + 1)).toBe(1);
    expect(raw(key)).toBeNull();
  });

  it('閉じた記録の op の receipt が取れたら、markConfirmed が confirmed に直す (閉じたのに取り込まれた)・error の log', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { key } = setup();
    advanceToSubmitting(key);
    reject(key);

    const c = markConfirmed({
      key,
      sender: SENDER,
      txHash: '0xtx' as Hex,
      success: true,
      now: 6_000,
      userOpHash: HASH,
    });

    expect(c.status).toBe('confirmed');
    expect(loadPendingRecord(key)).toMatchObject({ status: 'confirmed', txHash: '0xtx', userOpHash: HASH });
    expect(errorSpy).toHaveBeenCalledWith('circle.pending.confirmed-after-failed', {
      userOpHash: HASH,
      txHash: '0xtx',
    });
  });

  it('閉じた記録は、送り直しの前の CAS (markResending) も submitting への再入 (markSubmitting) も通さない', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    reject(key);
    expect(() => markResending({ key, sender: SENDER, userOpHash: HASH, now: 6_000 })).toThrow(
      PendingStateError,
    );
    expect(() => markSubmitting({ key, sender: SENDER, now: 6_000 })).toThrow(PendingStateError);
    expect(loadPendingRecord(key)?.status).toBe('failed');
  });
});

describe('pre-submit の retry / abandon', () => {
  it('signed (未 broadcast) は abandon して安全に retry できる', () => {
    const { key } = setup();
    markAwaitingSignature({ key, sender: SENDER, now: 1_100 });
    markSigned({
      key,
      sender: SENDER,
      signedUserOp: SIGNED_OP,
      userOpHash: '0xhash' as Hex,
      now: 1_200,
    });
    const ab = abandon({ key, sender: SENDER, now: 1_250 });
    expect(ab.status).toBe('abandoned');
  });

  it('signed → awaiting_signature に戻れる (再署名 supersede・A8)', () => {
    // markSigned と markSubmitting の間でタブを閉じると record は signed のまま残る。
    // 同一 attemptId で再開したとき markAwaitingSignature が throw すると、送金が
    // 一切起きていないのに恒久的に詰む → signed からの再入を許可する。
    const { key } = setup();
    markAwaitingSignature({ key, sender: SENDER, now: 1_100 });
    markSigned({
      key,
      sender: SENDER,
      signedUserOp: SIGNED_OP,
      userOpHash: '0xhash' as Hex,
      now: 1_200,
    });
    const again = markAwaitingSignature({ key, sender: SENDER, now: 1_250 });
    expect(again.status).toBe('awaiting_signature');
    // 再署名で上書きされるまで旧署名は残る (markSigned が patch で差し替える)。
    expect(again.signedUserOp).toEqual(SIGNED_OP);
  });

  it('markSubmitting は冪等再入できる (rebroadcast retry)', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    const again = markSubmitting({ key, sender: SENDER, now: 1_350 });
    expect(again.status).toBe('submitting');
    expect(again.signedUserOp).toEqual(SIGNED_OP);
  });
});

describe('fail-closed 書込', () => {
  it('setItem が throw したら PendingStoreWriteError (送信中止)', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    expect(() => setup()).toThrow(PendingStoreWriteError);
    spy.mockRestore();
  });

  it('read-back 不一致 (silent drop) でも PendingStoreWriteError', () => {
    // setItem は成功扱いだが書けていない状況を再現する。
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
    expect(() => setup()).toThrow(PendingStoreWriteError);
  });

  it('localStorage 自体が使えなければ PendingStoreUnavailableError', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: private mode');
    });
    expect(() => setup()).toThrow(PendingStoreUnavailableError);
  });
});

describe('findRecoverable (reload 後の復旧スキャン)', () => {
  it('submitting で宙吊りの自分の record のみ返す', () => {
    // 自分の submitting
    const mine = setup();
    advanceToSubmitting(mine.key);

    // 別 attempt: confirmed (対象外)
    const callHash = computeCallHash(CALLS);
    const otherKey = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER,
      paymentAttemptId: 'attempt-2',
      callHash,
    });
    reserveOrResume({
      key: otherKey,
      chainId: CHAIN_ID,
      sender: SENDER,
      callHash,
      paymentAttemptId: 'attempt-2',
      paymaster: PAYMASTER,
      now: 5_000,
    });
    markAwaitingSignature({ key: otherKey, sender: SENDER, now: 5_100 });
    markSigned({
      key: otherKey,
      sender: SENDER,
      signedUserOp: SIGNED_OP,
      userOpHash: '0xhash2' as Hex,
      now: 5_200,
    });
    markSubmitting({ key: otherKey, sender: SENDER, now: 5_300 });
    markConfirmed({
      key: otherKey,
      sender: SENDER,
      txHash: '0xtx2' as Hex,
      success: true,
      now: 5_400,
    });

    const found = findRecoverable({ sender: SENDER, chainId: CHAIN_ID });
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe(mine.key);
  });

  it('別 sender / 別 chain の submitting は返さない', () => {
    const mine = setup();
    advanceToSubmitting(mine.key);
    expect(
      findRecoverable({ sender: OTHER, chainId: CHAIN_ID }),
    ).toHaveLength(0);
    expect(findRecoverable({ sender: SENDER, chainId: 8453 })).toHaveLength(0);
  });

  it('復旧した submitting を rebroadcast→confirmed で確定できる', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    const [rec] = findRecoverable({ sender: SENDER, chainId: CHAIN_ID });
    expect(rec.signedUserOp).toEqual(SIGNED_OP);
    expect(rec.userOpHash).toBe('0xhash');
    // 冪等 rebroadcast (同一 op) → confirmed
    markSubmitting({ key: rec.key, sender: SENDER, now: 9_000 });
    const c = markConfirmed({
      key: rec.key,
      sender: SENDER,
      txHash: '0xtx' as Hex,
      success: true,
      now: 9_100,
    });
    expect(c.status).toBe('confirmed');
  });
});

describe('pruneTerminal', () => {
  it('古い terminal を消し、submitting は保持する', () => {
    // submitting (保持されるべき)
    const keep = setup();
    advanceToSubmitting(keep.key);

    // confirmed (古い → 削除対象)
    const callHash = computeCallHash(CALLS);
    const doneKey = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER,
      paymentAttemptId: 'done',
      callHash,
    });
    reserveOrResume({
      key: doneKey,
      chainId: CHAIN_ID,
      sender: SENDER,
      callHash,
      paymentAttemptId: 'done',
      paymaster: PAYMASTER,
      now: 1_000,
    });
    markAwaitingSignature({ key: doneKey, sender: SENDER, now: 1_100 });
    markSigned({
      key: doneKey,
      sender: SENDER,
      signedUserOp: SIGNED_OP,
      userOpHash: '0xh' as Hex,
      now: 1_200,
    });
    markSubmitting({ key: doneKey, sender: SENDER, now: 1_300 });
    markConfirmed({
      key: doneKey,
      sender: SENDER,
      txHash: '0xt' as Hex,
      success: true,
      now: 1_400,
    });

    const removed = pruneTerminal(60_000, 1_000_000);
    expect(removed).toBe(1);
    expect(loadPendingRecord(doneKey)).toBeUndefined();
    expect(loadPendingRecord(keep.key)?.status).toBe('submitting');
  });
});

describe('pruneStaleSubmitting', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETENTION = 7 * DAY_MS;

  function submittingAt(attemptId: string, now: number) {
    const callHash = computeCallHash(CALLS);
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER,
      paymentAttemptId: attemptId,
      callHash,
    });
    reserveOrResume({
      key,
      chainId: CHAIN_ID,
      sender: SENDER,
      callHash,
      paymentAttemptId: attemptId,
      paymaster: PAYMASTER,
      now,
    });
    markAwaitingSignature({ key, sender: SENDER, now: now + 1 });
    markSigned({
      key,
      sender: SENDER,
      signedUserOp: SIGNED_OP,
      userOpHash: '0xhash' as Hex,
      now: now + 2,
    });
    markSubmitting({ key, sender: SENDER, now: now + 3 });
    return key;
  }

  it('8 日前の submitting は物理削除する (緩慢リーク回収)', () => {
    const NOW = 100 * DAY_MS;
    const stale = submittingAt('stale', NOW - 8 * DAY_MS);
    pruneStaleSubmitting(RETENTION, NOW);
    expect(loadPendingRecord(stale)).toBeUndefined();
  });

  it('1 日前の submitting は残す (recover 手段を温存)', () => {
    const NOW = 100 * DAY_MS;
    const recent = submittingAt('recent', NOW - 1 * DAY_MS);
    pruneStaleSubmitting(RETENTION, NOW);
    expect(loadPendingRecord(recent)?.status).toBe('submitting');
  });

  it('terminal (confirmed) / pre-submit (reserved) には触れない (既存 GC の責務)', () => {
    const NOW = 100 * DAY_MS;
    // 古い confirmed (pruneTerminal の責務)。
    const callHash = computeCallHash(CALLS);
    const confKey = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER,
      paymentAttemptId: 'conf',
      callHash,
    });
    reserveOrResume({
      key: confKey,
      chainId: CHAIN_ID,
      sender: SENDER,
      callHash,
      paymentAttemptId: 'conf',
      paymaster: PAYMASTER,
      now: NOW - 30 * DAY_MS,
    });
    markAwaitingSignature({ key: confKey, sender: SENDER, now: NOW - 30 * DAY_MS + 1 });
    markSigned({
      key: confKey,
      sender: SENDER,
      signedUserOp: SIGNED_OP,
      userOpHash: '0xh' as Hex,
      now: NOW - 30 * DAY_MS + 2,
    });
    markSubmitting({ key: confKey, sender: SENDER, now: NOW - 30 * DAY_MS + 3 });
    markConfirmed({
      key: confKey,
      sender: SENDER,
      txHash: '0xt' as Hex,
      success: true,
      now: NOW - 30 * DAY_MS + 4,
    });
    // 古い reserved (pre-submit・gcStalePreSubmit の責務)。
    const reservedKey = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER,
      paymentAttemptId: 'reserved-old',
      callHash,
    });
    reserveOrResume({
      key: reservedKey,
      chainId: CHAIN_ID,
      sender: SENDER,
      callHash,
      paymentAttemptId: 'reserved-old',
      paymaster: PAYMASTER,
      now: NOW - 30 * DAY_MS,
    });

    pruneStaleSubmitting(RETENTION, NOW);
    expect(loadPendingRecord(confKey)?.status).toBe('confirmed');
    expect(loadPendingRecord(reservedKey)?.status).toBe('reserved');
  });

  it('storage 利用不可でも throw しない (best-effort)', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => pruneStaleSubmitting(0, 1)).not.toThrow();
  });
});

describe('gcStalePreSubmit', () => {
  function reserveAt(attemptId: string, now: number) {
    const callHash = computeCallHash(CALLS);
    const key = computeIdempotencyKey({
      chainId: CHAIN_ID,
      sender: SENDER,
      paymentAttemptId: attemptId,
      callHash,
    });
    reserveOrResume({
      key,
      chainId: CHAIN_ID,
      sender: SENDER,
      callHash,
      paymentAttemptId: attemptId,
      paymaster: PAYMASTER,
      now,
    });
    return key;
  }

  it('stale な pre-submit (別 attempt) を abandoned にし、fresh は残す', () => {
    const stale = reserveAt('stale', 1_000); // 経過 999_000ms
    const fresh = reserveAt('fresh', 990_000); // 経過 10_000ms
    const n = gcStalePreSubmit(60_000, 1_000_000);
    expect(n).toBe(1);
    expect(loadPendingRecord(stale)?.status).toBe('abandoned');
    expect(loadPendingRecord(fresh)?.status).toBe('reserved');
  });

  it('excludeKey (実行中の自 attempt) は stale でも触らない', () => {
    const self = reserveAt('self', 1_000);
    const other = reserveAt('other', 1_000);
    const n = gcStalePreSubmit(60_000, 1_000_000, self);
    expect(n).toBe(1);
    expect(loadPendingRecord(self)?.status).toBe('reserved'); // 保護される
    expect(loadPendingRecord(other)?.status).toBe('abandoned');
  });

  it('signed (pre-submit) も stale なら abandoned にする', () => {
    const key = reserveAt('signed-stale', 1_000);
    markAwaitingSignature({ key, sender: SENDER, now: 1_050 });
    markSigned({
      key,
      sender: SENDER,
      signedUserOp: SIGNED_OP,
      userOpHash: '0xh' as Hex,
      now: 1_100,
    });
    const n = gcStalePreSubmit(60_000, 1_000_000);
    expect(n).toBe(1);
    expect(loadPendingRecord(key)?.status).toBe('abandoned');
  });

  it('submitting / terminal には触れない (復旧情報を守る)', () => {
    const sub = setup(); // submitting
    advanceToSubmitting(sub.key);
    const conf = reserveAt('conf', 1_000);
    markAwaitingSignature({ key: conf, sender: SENDER, now: 1_100 });
    markSigned({
      key: conf,
      sender: SENDER,
      signedUserOp: SIGNED_OP,
      userOpHash: '0xh' as Hex,
      now: 1_200,
    });
    markSubmitting({ key: conf, sender: SENDER, now: 1_300 });
    markConfirmed({
      key: conf,
      sender: SENDER,
      txHash: '0xt' as Hex,
      success: true,
      now: 1_400,
    });
    const n = gcStalePreSubmit(60_000, 1_000_000);
    expect(n).toBe(0);
    expect(loadPendingRecord(sub.key)?.status).toBe('submitting');
    expect(loadPendingRecord(conf)?.status).toBe('confirmed');
  });

  it('storage 利用不可でも throw せず 0 (best-effort)', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(gcStalePreSubmit(0, 1)).toBe(0);
  });
});

describe('stableAttemptId / clearStableAttemptId (sessionStorage マッピング)', () => {
  const CALL_HASH = computeCallHash(CALLS);
  const OTHER_HASH = computeCallHash([
    { to: MERCHANT, data: '0xdead' as Hex },
  ]);

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  // stableAttemptId は { attemptId, saved } を返す (r10-ss)。保存できる前提の test は、saved が true であることを確かめてから
  // attemptId を使う (保存できていない id 同士の比較で空振りしない)。
  function savedAttemptId(args: Parameters<typeof stableAttemptId>[0]): string {
    const mapping = stableAttemptId(args);
    if (!mapping.saved) throw new Error('test: 対応を保存できなかった (stableAttemptId の saved が false)');
    return mapping.attemptId;
  }

  it('同一 (chainId,sender,callHash) は同じ attemptId を返す (再クリック/reload で resume)', () => {
    const a = savedAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    const b = savedAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    expect(a).toBe(b);
  });

  it('callHash が違えば別 attemptId (別決済 intent)', () => {
    const a = savedAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    const b = savedAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: OTHER_HASH });
    expect(a).not.toBe(b);
  });

  it('clear 後は新しい attemptId を採番する (次の同額購入は別 attempt)', () => {
    const a = savedAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    clearStableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH }, a);
    const b = savedAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    expect(b).not.toBe(a);
  });

  // 第 10 回レビュー 穴 B (Codex の指摘): マッピングは同じタブの別の試みと共有する。破棄は「マッピングがいまも、呼ぶ試みの
  // 知っている attemptId を指しているとき」だけ。
  describe('clearStableAttemptId は、期待した attemptId を指しているときだけ破棄する', () => {
    const ARGS = { chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH };

    it('別の値に替わっていたら (別の試みが付け替えた) 破棄しない', () => {
      const own = savedAttemptId(ARGS);
      setStableAttemptId(ARGS, 'attempt-of-other-tab');
      clearStableAttemptId(ARGS, own);
      expect(savedAttemptId(ARGS)).toBe('attempt-of-other-tab');
    });

    it('付け替えた先の attemptId を渡せば破棄する (付け替えた試み自身の後片付け)', () => {
      stableAttemptId(ARGS);
      setStableAttemptId(ARGS, 'attempt-of-other-tab');
      clearStableAttemptId(ARGS, 'attempt-of-other-tab');
      expect(window.sessionStorage.length).toBe(0);
    });

    it('マッピングが無いとき (別の試みが先に破棄した) は何もしない', () => {
      clearStableAttemptId(ARGS, 'some-attempt');
      expect(window.sessionStorage.length).toBe(0);
    });

    it('別の内容 (callHash) のマッピングには触らない', () => {
      const own = savedAttemptId(ARGS);
      const other = savedAttemptId({ ...ARGS, callHash: OTHER_HASH });
      clearStableAttemptId(ARGS, own);
      expect(window.sessionStorage.length).toBe(1);
      expect(savedAttemptId({ ...ARGS, callHash: OTHER_HASH })).toBe(other);
    });

    it('sessionStorage を読めない・消せないときは投げない (マッピングはそのまま)', () => {
      const own = savedAttemptId(ARGS);
      const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      expect(() => clearStableAttemptId(ARGS, own)).not.toThrow();
      getItem.mockRestore();
      const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      expect(() => clearStableAttemptId(ARGS, own)).not.toThrow();
      expect(removeItem).toHaveBeenCalledTimes(1);
      removeItem.mockRestore();
      expect(savedAttemptId(ARGS)).toBe(own);
    });
  });

  // r10-ss: attemptId と、それを sessionStorage に保存できたか (saved) を返す。保存できなければ、保存していない新しい UUID と
  // saved: false (hook はそれを executeCirclePayment に渡し、新しい記録を予約する直前で止まる。scan には、この id を使う)。
  // 直す前は、保存していない新しい UUID を黙って返していた (呼ぶ側は見分けられない): その端末で送った支払いが確認待ちで終わると、
  // 次の押下は別の attemptId になり、裏で確定した前の支払い (90 秒より前の confirmed) の後に 2 本目の署名を求める。
  describe('attemptId と、保存できたか (saved) を返す', () => {
    const ARGS = { chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH };
    const UNAVAILABLE = 'circle.attempt_mapping.unavailable';
    const UUID = /^[0-9a-f-]{36}$/i;

    // この describe の spy は sessionStorage だけを壊す (localStorage は本物のまま)。
    const realGetItem = Storage.prototype.getItem;
    const realSetItem = Storage.prototype.setItem;
    function spyWarn() {
      return vi.spyOn(logger, 'warn').mockImplementation(() => {});
    }
    function breakSessionWrites() {
      return vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, key: string, value: string) {
          if (this === window.sessionStorage) throw new Error('QuotaExceededError: private mode');
          return realSetItem.call(this, key, value);
        });
    }
    // 保存できなかった結果 (saved: false) であることを確かめ、その (保存していない) attemptId を返す。
    function unsavedAttemptId(): string {
      const mapping = stableAttemptId(ARGS);
      expect(mapping.saved).toBe(false);
      expect(mapping.attemptId).toMatch(UUID);
      expect(Object.keys(mapping).sort()).toEqual(['attemptId', 'saved']);
      return mapping.attemptId;
    }
    // sessionStorage に残っている対応の値 (無ければ空)。
    const storedValues = () =>
      Array.from({ length: window.sessionStorage.length }, (_, i) =>
        window.sessionStorage.getItem(window.sessionStorage.key(i)!),
      );

    it('対応が無い → 書いて、読み戻せた値と saved: true を返す (書くのは 1 回・2 回目は同じ値を読むだけ)。warn は出さない', () => {
      const warn = spyWarn();
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      const first = stableAttemptId(ARGS);
      expect(first).toEqual({ attemptId: expect.stringMatching(UUID), saved: true });
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(storedValues()).toEqual([first.attemptId]);

      expect(stableAttemptId(ARGS)).toEqual(first);
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('setItem が throw → saved: false と、保存していない UUID (押すたびに別の値)。何も残らない。warn は chainId と cause: write だけ', () => {
      const warn = spyWarn();
      const setItem = breakSessionWrites();
      const a = unsavedAttemptId();
      const b = unsavedAttemptId();
      expect(a).not.toBe(b);
      expect(setItem).toHaveBeenCalledTimes(2);
      setItem.mockRestore();
      expect(storedValues()).toEqual([]);
      expect(warn.mock.calls).toEqual([
        [UNAVAILABLE, { chainId: CHAIN_ID, cause: 'write' }],
        [UNAVAILABLE, { chainId: CHAIN_ID, cause: 'write' }],
      ]);
    });

    it('getItem が throw → saved: false (押すたびに別の UUID)。書きに行かない。warn は cause: read', () => {
      const warn = spyWarn();
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      const getItem = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(function (this: Storage, key: string) {
          if (this === window.sessionStorage) throw new Error('SecurityError: storage is not available');
          return realGetItem.call(this, key);
        });
      const a = unsavedAttemptId();
      const b = unsavedAttemptId();
      getItem.mockRestore();
      expect(a).not.toBe(b);
      expect(setItem).not.toHaveBeenCalled();
      expect(storedValues()).toEqual([]);
      expect(warn.mock.calls).toEqual([
        [UNAVAILABLE, { chainId: CHAIN_ID, cause: 'read' }],
        [UNAVAILABLE, { chainId: CHAIN_ID, cause: 'read' }],
      ]);
    });

    // 保存した後に読めなくなった端末: 既にある対応の値は返さない (読めないので分からない)。保存していない別の UUID を返す。
    it('対応を保存した後に getItem が throw するようになる → saved: false と、保存した値とは別の UUID。保存した値は残る', () => {
      const own = savedAttemptId(ARGS);
      const warn = spyWarn();
      const getItem = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(function (this: Storage, key: string) {
          if (this === window.sessionStorage) throw new Error('SecurityError: storage is not available');
          return realGetItem.call(this, key);
        });
      const unsaved = unsavedAttemptId();
      getItem.mockRestore();
      expect(unsaved).not.toBe(own);
      expect(storedValues()).toEqual([own]);
      expect(warn.mock.calls).toEqual([[UNAVAILABLE, { chainId: CHAIN_ID, cause: 'read' }]]);
      // 読めるようになれば、保存した値に戻る。
      expect(savedAttemptId(ARGS)).toBe(own);
    });

    it('setItem は通るが残らない (silent drop) → saved: false。warn は cause: readback', () => {
      const warn = spyWarn();
      const setItem = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, key: string, value: string) {
          if (this === window.sessionStorage) return;
          realSetItem.call(this, key, value);
        });
      unsavedAttemptId();
      expect(setItem).toHaveBeenCalledTimes(1);
      setItem.mockRestore();
      expect(storedValues()).toEqual([]);
      expect(warn.mock.calls).toEqual([[UNAVAILABLE, { chainId: CHAIN_ID, cause: 'readback' }]]);
    });

    it('読み戻すと別の値 → saved: false。返すのは、残った値ではなく、書こうとした UUID。warn は cause: readback', () => {
      const warn = spyWarn();
      const setItem = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, key: string, value: string) {
          realSetItem.call(this, key, this === window.sessionStorage ? 'some-other-value' : value);
        });
      const unsaved = unsavedAttemptId();
      setItem.mockRestore();
      expect(unsaved).not.toBe('some-other-value');
      expect(storedValues()).toEqual(['some-other-value']);
      expect(warn.mock.calls).toEqual([[UNAVAILABLE, { chainId: CHAIN_ID, cause: 'readback' }]]);
    });

    it('書いた後の読み戻しが throw → saved: false。warn は cause: readback', () => {
      const warn = spyWarn();
      let reads = 0;
      const getItem = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(function (this: Storage, key: string) {
          if (this === window.sessionStorage) {
            reads += 1;
            if (reads > 1) throw new Error('SecurityError: storage is not available');
          }
          return realGetItem.call(this, key);
        });
      unsavedAttemptId();
      getItem.mockRestore();
      expect(reads).toBe(2);
      expect(warn.mock.calls).toEqual([[UNAVAILABLE, { chainId: CHAIN_ID, cause: 'readback' }]]);
    });

    // 確認待ちの後の押下: 前の押下で保存できた対応は、その後に書けなくなっても読める (saved: true のまま = resume する)。
    it('既に対応がある → その値と saved: true を返し、書かない (setItem が throw する端末でも)', () => {
      const own = savedAttemptId(ARGS);
      const warn = spyWarn();
      const setItem = breakSessionWrites();
      expect(stableAttemptId(ARGS)).toEqual({ attemptId: own, saved: true });
      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
      expect(warn).not.toHaveBeenCalled();
    });

    it('見るのは sessionStorage だけ: localStorage の setItem だけが throw しても、対応は保存できる', () => {
      const setItem = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, key: string, value: string) {
          if (this === window.localStorage) throw new Error('QuotaExceededError');
          return realSetItem.call(this, key, value);
        });
      const id = savedAttemptId(ARGS);
      setItem.mockRestore();
      expect(id).toMatch(UUID);
      expect(savedAttemptId(ARGS)).toBe(id);
    });

    it('warn に sender・callHash・attemptId・error の文を入れない', () => {
      const warn = spyWarn();
      const setItem = breakSessionWrites();
      const unsaved = unsavedAttemptId();
      setItem.mockRestore();
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls).toLowerCase();
      expect(logged).not.toContain(SENDER.toLowerCase());
      expect(logged).not.toContain(CALL_HASH.toLowerCase());
      expect(logged).not.toContain(unsaved.toLowerCase());
      expect(logged).not.toContain('quotaexceedederror');
      expect(Object.keys(warn.mock.calls[0][1] ?? {}).sort()).toEqual(['cause', 'chainId']);
    });

    // UUID の採番は storage と関係ない。その失敗を「対応を保存できない」(saved: false) に化けさせない (今までも throw だった)。
    it('crypto.randomUUID の失敗は saved: false にしない (そのまま throw・warn は出さない)', () => {
      const warn = spyWarn();
      const uuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
        throw new Error('test: randomUUID is not available');
      });
      expect(() => stableAttemptId(ARGS)).toThrow('test: randomUUID is not available');
      uuid.mockRestore();
      expect(storedValues()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('key は ATTEMPT_KEY_PREFIX で始まり PENDING_KEY_PREFIX と衝突しない', () => {
    stableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const k = window.sessionStorage.key(i);
      if (k) keys.push(k);
    }
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(ATTEMPT_KEY_PREFIX)).toBe(true);
    expect(keys[0].startsWith(PENDING_KEY_PREFIX)).toBe(false);
  });

  // 第 10 回レビュー 穴 B: scan が別の key の記録の結果を受け取りに行くとき、hook が対応をその記録の attemptId に付け替える。
  describe('setStableAttemptId (対応の付け替え)', () => {
    const ARGS = { chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH };

    it('付け替えた後、同じ (chainId,sender,callHash) の stableAttemptId は渡した attemptId を返す (key は増えない)。書けたら true', () => {
      const own = savedAttemptId(ARGS);
      expect(setStableAttemptId(ARGS, 'attempt-of-other-tab')).toBe(true);
      expect(savedAttemptId(ARGS)).toBe('attempt-of-other-tab');
      expect(savedAttemptId(ARGS)).not.toBe(own);
      expect(window.sessionStorage.length).toBe(1);
    });

    it('sender の大文字・小文字が違っても同じ対応を書く (stableAttemptId と同じ key)', () => {
      stableAttemptId(ARGS);
      setStableAttemptId({ ...ARGS, sender: SENDER.toLowerCase() as Address }, 'attempt-of-other-tab');
      expect(savedAttemptId(ARGS)).toBe('attempt-of-other-tab');
      expect(window.sessionStorage.length).toBe(1);
    });

    it('別の内容 (callHash) の対応には触らない', () => {
      const other = savedAttemptId({ ...ARGS, callHash: OTHER_HASH });
      setStableAttemptId(ARGS, 'attempt-of-other-tab');
      expect(savedAttemptId({ ...ARGS, callHash: OTHER_HASH })).toBe(other);
    });

    it('sessionStorage.setItem が throw しても投げず、false を返す。対応は前のまま', () => {
      const own = savedAttemptId(ARGS);
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      expect(setStableAttemptId(ARGS, 'attempt-of-other-tab')).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect(savedAttemptId(ARGS)).toBe(own);
    });
  });
});

describe('status 述語', () => {
  it('isPreSubmit / isTerminal の分類', () => {
    expect(isPreSubmit('reserved')).toBe(true);
    expect(isPreSubmit('signed')).toBe(true);
    expect(isPreSubmit('submitting')).toBe(false);
    expect(isTerminal('confirmed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('abandoned')).toBe(true);
    expect(isTerminal('submitting')).toBe(false);
  });
});
