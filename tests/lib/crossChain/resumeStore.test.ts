import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAddress } from 'viem';
import {
  loadResumeState,
  saveResumeState,
  clearResumeState,
  hasResumeState,
  type ResumeSessionKey,
} from '@/lib/crossChain/resumeStore';
import type { CctpResumeState } from '@/lib/crossChain/execute';

const ACCOUNT = getAddress('0x1234567890123456789012345678901234567890');
const RECIPIENT = getAddress('0x000000000000000000000000000000000000aBcd');

const baseKey: ResumeSessionKey = {
  account: ACCOUNT,
  kind: 'cctp-v2',
  sourceChainId: 84532,
  destChainId: 80002,
  recipient: RECIPIENT,
  valueAtomic: 9_900_000n,
  feeAtomic: 100_000n,
};

beforeEach(() => {
  localStorage.clear();
});

describe('lib/crossChain/resumeStore', () => {
  it('save → load で同じ state を取り戻す', () => {
    const state: CctpResumeState = {
      approveTxHash: '0xapprove',
      burnTxHash: '0xburn',
      feeBurnTxHash: '0xfeeburn',
    };
    saveResumeState(baseKey, state);
    expect(loadResumeState<CctpResumeState>(baseKey)).toEqual(state);
  });

  it('未保存の key は undefined / hasResumeState=false', () => {
    expect(loadResumeState(baseKey)).toBeUndefined();
    expect(hasResumeState(baseKey)).toBe(false);
  });

  it('clear で削除される', () => {
    saveResumeState(baseKey, { burnTxHash: '0xburn' });
    expect(hasResumeState(baseKey)).toBe(true);
    clearResumeState(baseKey);
    expect(hasResumeState(baseKey)).toBe(false);
    expect(loadResumeState(baseKey)).toBeUndefined();
  });

  it('key が違えば (kind/金額/recipient/chain) 別スロットになる', () => {
    saveResumeState(baseKey, { burnTxHash: '0xcctp' });
    // kind 違い
    const gatewayKey = { ...baseKey, kind: 'gateway' as const };
    expect(hasResumeState(gatewayKey)).toBe(false);
    // 金額違い
    const otherAmount = { ...baseKey, valueAtomic: 1n };
    expect(hasResumeState(otherAmount)).toBe(false);
    // recipient 違い
    const otherRecipient = { ...baseKey, recipient: ACCOUNT };
    expect(hasResumeState(otherRecipient)).toBe(false);
    // 元の key は影響を受けない
    expect(loadResumeState<CctpResumeState>(baseKey)).toEqual({
      burnTxHash: '0xcctp',
    });
  });

  it('save は上書きする (進捗の累積保存)', () => {
    saveResumeState(baseKey, { burnTxHash: '0xburn' });
    saveResumeState(baseKey, {
      burnTxHash: '0xburn',
      feeBurnTxHash: '0xfeeburn',
      mintTxHash: '0xmint',
    });
    expect(loadResumeState<CctpResumeState>(baseKey)).toEqual({
      burnTxHash: '0xburn',
      feeBurnTxHash: '0xfeeburn',
      mintTxHash: '0xmint',
    });
  });

  it('setItem が throw しても save は throw しない (best-effort・決済を巻き込まない)', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    expect(() =>
      saveResumeState(baseKey, { burnTxHash: '0xburn' }),
    ).not.toThrow();
    spy.mockRestore();
  });

  it('corrupt JSON の entry は load で undefined (決済開始を block しない)', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockReturnValue('{not valid json');
    expect(loadResumeState(baseKey)).toBeUndefined();
    spy.mockRestore();
  });
});
