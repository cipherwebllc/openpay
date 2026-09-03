import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAddress } from 'viem';
import {
  loadResumeState,
  saveResumeState,
  saveResumeStateStrict,
  clearResumeState,
  hasResumeState,
  ResumeStoreWriteError,
  type ResumeSessionKey,
} from '@/lib/crossChain/resumeStore';
import type { CctpResumeState } from '@/lib/crossChain/execute';
import type { BurnIntentMarker } from '@/lib/crossChain/burnMarker';

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

  it('getItem が throw しても load=undefined / has=false (render/決済を巻き込まない)', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError');
      });
    expect(loadResumeState(baseKey)).toBeUndefined();
    expect(hasResumeState(baseKey)).toBe(false);
    spy.mockRestore();
  });

  it('removeItem が throw しても clear は throw しない (完了決済を error にしない)', () => {
    saveResumeState(baseKey, { burnTxHash: '0xburn' });
    const spy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => {
        throw new Error('SecurityError');
      });
    expect(() => clearResumeState(baseKey)).not.toThrow();
    spy.mockRestore();
  });
});

// A1: burn-intent marker 用の fail-closed 書込。best-effort な saveResumeState と違い、
// 「書けたことを read-back で確証できなければ throw」= 記録なしで burn させない。
describe('lib/crossChain/resumeStore.saveResumeStateStrict (fail-closed)', () => {
  const marker: BurnIntentMarker = {
    v: 1,
    chainId: 84532,
    block: '1000',
    nonceLatest: 5,
    noncePending: 5,
    at: 1_700_000_000_000,
    depositor: ACCOUNT,
    burnToken: getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
    mintRecipient: RECIPIENT,
    amount: '9900000',
    destinationDomain: 7,
  };

  it('成功時は marker 込みの state が load で読み戻せる', () => {
    saveResumeStateStrict(baseKey, { approveTxHash: '0xa', burnIntent: marker });
    expect(loadResumeState<CctpResumeState>(baseKey)).toEqual({
      approveTxHash: '0xa',
      burnIntent: marker,
    });
  });

  it('setItem が throw したら ResumeStoreWriteError', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    expect(() =>
      saveResumeStateStrict(baseKey, { burnIntent: marker }),
    ).toThrow(ResumeStoreWriteError);
    spy.mockRestore();
  });

  it('read-back 不一致 (silent drop) も ResumeStoreWriteError', () => {
    const setSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => undefined); // 書いたふりだけする private mode
    const getSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockReturnValue(null);
    expect(() =>
      saveResumeStateStrict(baseKey, { burnIntent: marker }),
    ).toThrow(ResumeStoreWriteError);
    setSpy.mockRestore();
    getSpy.mockRestore();
  });

  it('read-back が throw しても ResumeStoreWriteError (握り潰さない)', () => {
    const getSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError');
      });
    expect(() =>
      saveResumeStateStrict(baseKey, { burnIntent: marker }),
    ).toThrow(ResumeStoreWriteError);
    getSpy.mockRestore();
  });

  it('既存 saveResumeState の best-effort 挙動は変わっていない (setItem throw で throw しない)', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    expect(() => saveResumeState(baseKey, { burnIntent: marker })).not.toThrow();
    spy.mockRestore();
  });
});
