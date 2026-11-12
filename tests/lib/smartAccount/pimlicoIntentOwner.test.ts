// 記録の「同じ intent」と「同じ版」の定義 (lib/smartAccount/pimlicoIntentOwner.ts・第 10 回レビュー PR-02 の Codex レビュー P1 と
// その 2 回目)。確定の片付けは同じ intent のとき、確定によらない後からの書き込み・削除は同じ版のときだけ行う (hook と intent の
// 関所の挙動は tests/hooks/useBatchPayment.intentOwner.test.tsx)。
import { describe, it, expect } from 'vitest';
import { isSameIntent, isSameVersion } from '@/lib/smartAccount/pimlicoIntentOwner';

const ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const OTHER_ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const SENDER = '0x9999999999999999999999999999999999999999';
const H1 = `0x${'a'.repeat(64)}`;
const H2 = `0x${'c'.repeat(64)}`;

const send = { entryPoint: ENTRY_POINT, sender: SENDER, nonceKey: '1700000000000', nonceSeq: '0' };
const ledger = { userOpHash: H1, send };

describe('isSameIntent', () => {
  it('送信の控えのある記録: EntryPoint・sender・nonce が同じなら、hash が違っても同じ intent (作り直し・hash の直し)', () => {
    expect(isSameIntent(ledger, { userOpHash: H2, send: { ...send } })).toBe(true);
  });

  it('address の大文字・小文字は区別しない', () => {
    expect(
      isSameIntent(ledger, {
        userOpHash: H1,
        send: { ...send, entryPoint: ENTRY_POINT.toLowerCase(), sender: SENDER.toUpperCase().replace('0X', '0x') },
      }),
    ).toBe(true);
  });

  it.each([
    { label: 'nonce の key', change: { nonceKey: '1700000000001' } },
    { label: 'nonce の seq', change: { nonceSeq: '1' } },
    { label: 'sender', change: { sender: '0x5555555555555555555555555555555555555555' } },
    { label: 'EntryPoint', change: { entryPoint: OTHER_ENTRY_POINT } },
  ])('$label が違えば、hash が同じでも別の intent', ({ change }) => {
    expect(isSameIntent(ledger, { userOpHash: H1, send: { ...send, ...change } })).toBe(false);
  });

  it('控えの無い記録 (MAv2 等) は hash だけで比べる', () => {
    expect(isSameIntent({ userOpHash: H1 }, { userOpHash: H1 })).toBe(true);
    expect(isSameIntent({ userOpHash: H1 }, { userOpHash: H2 })).toBe(false);
  });

  it('片方だけ控えがあれば、hash が同じでも別の intent', () => {
    expect(isSameIntent(ledger, { userOpHash: H1 })).toBe(false);
    expect(isSameIntent({ userOpHash: H1 }, ledger)).toBe(false);
  });
});

// 版 (確定によらない後からの書き込み・削除の compare-and-set に使う): 同じ intent・同じ hash・同じ updatedAt。
describe('isSameVersion', () => {
  const version = { ...ledger, updatedAt: 1_000, status: 'pending' };

  it('同じ intent・hash・updatedAt なら同じ版。status (pending / unknown) は版に入れない', () => {
    const answeredUnknown = { ...version, status: 'unknown' };
    expect(isSameVersion(version, answeredUnknown)).toBe(true);
  });

  it.each([
    { label: '送り直した (updatedAt が進んだ)', change: { updatedAt: 61_000 } },
    { label: '作り直した・hash を直した (hash が違う)', change: { userOpHash: H2 } },
    { label: '別の intent (nonce が違う)', change: { send: { ...send, nonceSeq: '1' } } },
  ])('$label 記録は別の版', ({ change }) => {
    expect(isSameVersion(version, { ...version, ...change })).toBe(false);
  });

  it('控えの無い記録は hash と updatedAt で比べる', () => {
    expect(isSameVersion({ userOpHash: H1, updatedAt: 1 }, { userOpHash: H1, updatedAt: 1 })).toBe(true);
    expect(isSameVersion({ userOpHash: H1, updatedAt: 1 }, { userOpHash: H1, updatedAt: 2 })).toBe(false);
  });

  // PR #1084 の Codex の 3 回目 (MUST 2): 時刻 (updatedAt) は送信を一意に決めない (同じ ms に送り直した別の画面の記録は、intent・
  // hash・updatedAt が全部同じ)。送るたびに書く一意の印 (rev) も比べる。
  describe('送信ごとの印 (rev)', () => {
    const REV_A = 'a'.repeat(32);
    const REV_B = 'b'.repeat(32);

    it('intent・hash・updatedAt が同じでも、rev が違えば別の版 (同じ時刻に送り直した記録)', () => {
      expect(isSameVersion({ ...version, rev: REV_A }, { ...version, rev: REV_B })).toBe(false);
    });

    it('rev も同じなら同じ版 (status だけ違う書き込み・hash の直しの前後は rev を保つ)', () => {
      const answeredUnknown = { ...version, rev: REV_A, status: 'unknown' };
      expect(isSameVersion({ ...version, rev: REV_A }, answeredUnknown)).toBe(true);
    });

    it('rev が同じでも、hash や updatedAt が違えば別の版 (今までの比較はそのまま)', () => {
      expect(isSameVersion({ ...version, rev: REV_A }, { ...version, rev: REV_A, userOpHash: H2 })).toBe(false);
      expect(isSameVersion({ ...version, rev: REV_A }, { ...version, rev: REV_A, updatedAt: 2_000 })).toBe(false);
    });

    it('片方だけ rev を持つ (rev を足す前のコードが書いた記録と、足した後の記録) → 別の版', () => {
      expect(isSameVersion({ ...version, rev: REV_A }, version)).toBe(false);
      expect(isSameVersion(version, { ...version, rev: REV_A })).toBe(false);
    });

    it('どちらも rev を持たない (古い記録どうし・控えの無い記録) → 今までどおり intent・hash・updatedAt で比べる', () => {
      expect(isSameVersion(version, { ...version })).toBe(true);
      expect(isSameVersion(version, { ...version, updatedAt: 2_000 })).toBe(false);
    });

    it('storage の rev が文字列でない (壊れた値) → 自分の版とは一致しない', () => {
      const broken = { ...version, rev: 123 } as unknown as typeof version & { rev: string };
      expect(isSameVersion({ ...version, rev: REV_A }, broken)).toBe(false);
      expect(isSameVersion(version, broken)).toBe(false);
    });
  });
});
