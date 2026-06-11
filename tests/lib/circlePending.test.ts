import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import {
  abandon,
  ATTEMPT_KEY_PREFIX,
  clearStableAttemptId,
  computeCallHash,
  computeIdempotencyKey,
  findRecoverable,
  gcStalePreSubmit,
  isPreSubmit,
  isTerminal,
  loadPendingRecord,
  markAwaitingSignature,
  markConfirmed,
  markFailed,
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
  stableAttemptId,
  type SerializedUserOp,
} from '@/lib/circlePending';

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

  it('submitting からは failed にできない (included しうる unknown 状態)', () => {
    const { key } = setup();
    advanceToSubmitting(key);
    expect(() =>
      markFailed({ key, sender: SENDER, errorMessage: 'rpc timeout', now: 1_500 }),
    ).toThrow(PendingStateError);
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

  it('同一 (chainId,sender,callHash) は同じ attemptId を返す (再クリック/reload で resume)', () => {
    const a = stableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    const b = stableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    expect(a).toBe(b);
  });

  it('callHash が違えば別 attemptId (別決済 intent)', () => {
    const a = stableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    const b = stableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: OTHER_HASH });
    expect(a).not.toBe(b);
  });

  it('clear 後は新しい attemptId を採番する (次の同額購入は別 attempt)', () => {
    const a = stableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    clearStableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    const b = stableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    expect(b).not.toBe(a);
  });

  it('sessionStorage.setItem が throw する環境では毎回新規 UUID (throw せず fallback)', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('SecurityError: private mode');
      });
    const a = stableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    const b = stableAttemptId({ chainId: CHAIN_ID, sender: SENDER, callHash: CALL_HASH });
    // 保存できないので安定しない (毎回新規)。だが throw はしない (決済可否を左右させない)。
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
    expect(b).toMatch(/^[0-9a-f-]{36}$/i);
    expect(a).not.toBe(b);
    spy.mockRestore();
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
