import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { hasSavedCctpResume } from '@/lib/crossChain/cctpResumePresence';
import { saveResumeState, type ResumeSessionKey } from '@/lib/crossChain/resumeStore';

// 親フォームの同期判定は resumeStore を import せず key の形だけを読む。実物の保存で書いた key を
// 当てられること (形のずれの検出) と、別の宛先・受取人・account・Gateway の記録に当たらないことを固定する。
const account = '0xAbCdEf0000000000000000000000000000000001' as Address;
const recipient = '0x00000000000000000000000000000000000aBcD2' as Address;
const key: ResumeSessionKey = {
  account, kind: 'cctp-v2', sourceChainId: 84532, destChainId: 80002, recipient, valueAtomic: 999_000n, feeAtomic: 1_000n,
};
const scope = { account, destChainId: 80002, recipient };

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('hasSavedCctpResume', () => {
  it('finds a record written by resumeStore for any source and amount', () => {
    expect(hasSavedCctpResume(scope)).toBe(false);
    saveResumeState(key, { burnTxHash: `0x${'ab'.repeat(32)}` });
    expect(hasSavedCctpResume(scope)).toBe(true);
    expect(hasSavedCctpResume({ ...scope, account: account.toLowerCase(), recipient: recipient.toUpperCase().replace('0X', '0x') })).toBe(true);
  });

  it.each([
    ['another destination', { ...scope, destChainId: 84532 }],
    ['another recipient', { ...scope, recipient: account }],
    ['another account', { ...scope, account: recipient }],
  ])('ignores a record for %s', (_name, other) => {
    saveResumeState(key, { burnTxHash: `0x${'ab'.repeat(32)}` });
    expect(hasSavedCctpResume(other)).toBe(false);
  });

  it('ignores a Gateway record for the same invoice', () => {
    saveResumeState({ ...key, kind: 'gateway' }, {});
    expect(hasSavedCctpResume(scope)).toBe(false);
  });

  it('waits for the child scan when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new Error('denied'); });
    saveResumeState(key, { burnTxHash: `0x${'ab'.repeat(32)}` });
    expect(hasSavedCctpResume(scope)).toBe(true);
  });
});
