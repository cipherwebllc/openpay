import type { GatewayResumeState } from '@/lib/crossChain/gatewayRecovery';
import { gatewayAttestation } from '../../fixtures/gateway';
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

describe('X12 Gateway fail-closed enumeration', () => {
  const key = { ...baseKey, kind: 'gateway' as const };
  it.each(['{broken', 'null', '[]', '{}', '{"merchant":{"attempts":[]}}'])('keeps unreadable %s distinct from absence', async (raw) => {
    const { loadGatewayResumeState, scanGatewayResumeStates } = await import('@/lib/crossChain/resumeStore');
    saveResumeStateStrict(key, { merchantAttestation: gatewayAttestation() });
    const name = localStorage.key(0)!;
    localStorage.setItem(name, raw);
    expect(loadGatewayResumeState(key).kind).toBe('unreadable');
    expect(scanGatewayResumeStates(key).kind).toBe('unreadable');
    expect(localStorage.getItem(name)).toBe(raw);
  });
  it('scans persisted sources that no longer appear in supported path options', async () => {
    const { scanGatewayResumeStates } = await import('@/lib/crossChain/resumeStore');
    saveResumeStateStrict({ ...key, sourceChainId: 999999 }, { merchantAttestation: gatewayAttestation() });
    saveResumeStateStrict(key, { merchantAttestation: gatewayAttestation() });
    const result = scanGatewayResumeStates(key);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.entries.map((e) => e.key.sourceChainId)).toEqual([999999, key.sourceChainId]);
  });
  it('storage enumeration failure is unreadable, never an empty list', async () => {
    const { scanGatewayResumeStates } = await import('@/lib/crossChain/resumeStore');
    const spy = vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new Error('denied'); });
    saveResumeStateStrict(key, { merchantAttestation: gatewayAttestation() });
    expect(scanGatewayResumeStates(key).kind).toBe('unreadable');
    spy.mockRestore();
  });
});


it('ignores malformed keys outside this account/invoice before strict key validation', async () => {
  const { scanGatewayResumeStates } = await import('@/lib/crossChain/resumeStore');
  const key = { ...baseKey, kind: 'gateway' as const };
  localStorage.setItem('openpay.xchain.resume.gateway:malformed:another-account', '{broken');
  saveResumeStateStrict({ ...key, account: RECIPIENT }, { merchantAttestation: gatewayAttestation() });
  const other = localStorage.key(1)!; localStorage.setItem(`${other}:extra`, '{broken');
  expect(scanGatewayResumeStates(key)).toEqual({ kind: 'ok', entries: [] });
  saveResumeStateStrict(key, { merchantAttestation: gatewayAttestation() });
  const own = localStorage.key(3)!; localStorage.setItem(`${own}:extra`, '{broken');
  expect(scanGatewayResumeStates(key).kind).toBe('unreadable');
});

it('compares the active identity before signing and merges concurrent history instead of deleting it', async () => {
  const { saveGatewayResumeStateStrict } = await import('@/lib/crossChain/resumeStore');
  const { decodeGatewayAttestation } = await import('@/lib/crossChain/gatewayAttestation');
  const { gatewaySpec } = await import('../../fixtures/gateway');
  const { pad } = await import('viem');
  const make = (salt: `0x${string}`) => {
    const attestation = gatewayAttestation({ ...gatewaySpec, salt });
    const decoded = decodeGatewayAttestation(attestation.attestation);
    return { transferSpecHash: decoded.transferSpecHash, spec: { ...decoded.spec, value: String(decoded.spec.value) },
      attestation, maxBlockHeight: '100', txHashes: [], observations: [], status: 'replaceable' as const };
  };
  const key = { ...baseKey, kind: 'gateway' as const };
  const prior = make(pad('0x01')); const ours = make(pad('0x02')); const theirs = make(pad('0x03'));
  const before = { merchant: { attempts: [prior] } };
  const concurrent = { merchant: { attempts: [prior, theirs] } };
  saveResumeStateStrict(key, concurrent);
  expect(() => saveGatewayResumeStateStrict(key, { merchant: { attempts: [prior, ours] } }, before)).toThrow('changed before signing');
  expect(loadResumeState(key)).toEqual(concurrent);
  saveGatewayResumeStateStrict(key, before);
  expect(loadResumeState(key)).toEqual(concurrent);
});


it.each([false, true])('keeps interrupted paid records (unresolved fee=%s) locked until explicit completion', async (unresolvedFee) => {
  const { loadGatewayResumeState, loadGatewayReceipts, scanGatewayResumeStates } = await import('@/lib/crossChain/resumeStore');
  const { decodeGatewayAttestation } = await import('@/lib/crossChain/gatewayAttestation');
  const { gatewaySpec } = await import('../../fixtures/gateway');
  const { pad } = await import('viem');
  const attestation = gatewayAttestation();
  const decoded = decodeGatewayAttestation(attestation.attestation);
  const merchant = { attempts: [{ transferSpecHash: decoded.transferSpecHash, spec: { ...decoded.spec, value: String(decoded.spec.value) },
    attestation, maxBlockHeight: '100', txHashes: [], status: 'paid' as const,
    observations: [{ status: 'paid' as const, used: true, blockHash: pad('0x01'), blockNumber: '101', height: '101' }] }] };
  const feeAttestation = unresolvedFee ? gatewayAttestation({ ...gatewaySpec, value: 1000n, salt: pad('0x02') }) : undefined;
  const key = { ...baseKey, kind: 'gateway' as const };
  saveResumeStateStrict(key, { merchant, merchantAttestation: attestation, feeAttestation });
  expect(loadGatewayResumeState(key)).toMatchObject({ kind: 'present', state: { merchant } });
  expect(scanGatewayResumeStates(key)).toMatchObject({ kind: 'ok', entries: [{ key, state: { merchant } }] });
  expect(loadGatewayReceipts(ACCOUNT, key.destChainId)).toHaveLength(0);
  saveResumeStateStrict(key, { merchant, merchantAttestation: attestation, feeAttestation, completion: 'settled', feeUnresolved: unresolvedFee });
  expect(loadGatewayResumeState(key)).toEqual({ kind: 'absent' });
  expect(scanGatewayResumeStates(key)).toEqual({ kind: 'ok', entries: [] });
  const receipt = loadGatewayReceipts(ACCOUNT, key.destChainId)[0];
  expect(receipt.state).toMatchObject({ completion: 'settled', feeUnresolved: unresolvedFee, merchant, merchantAttestation: attestation });
  expect(receipt.state.feeAttestation).toEqual(feeAttestation);
});

it.each(['abandoned-unsigned', 'abandoned-unsent', 'rejected-request'] as const)('never revives a concurrent %s attempt', async (status) => {
  const { saveGatewayResumeStateStrict } = await import('@/lib/crossChain/resumeStore');
  const { decodeGatewayAttestation } = await import('@/lib/crossChain/gatewayAttestation');
  const decoded = decodeGatewayAttestation(gatewayAttestation().attestation);
  const attempt = { transferSpecHash: decoded.transferSpecHash, spec: { ...decoded.spec, value: String(decoded.spec.value) },
    txHashes: [], observations: [], intent: { maxBlockHeight: '1000', maxFee: '1000', requestTracked: true as const }, status };
  const key = { ...baseKey, kind: 'gateway' as const };
  saveResumeStateStrict(key, { merchant: { attempts: [attempt] } });
  saveGatewayResumeStateStrict(key, { merchant: { attempts: [{ ...attempt, status: 'unknown', intent: { ...attempt.intent, signature: gatewayAttestation().signature } }] } });
  expect(loadResumeState<GatewayResumeState>(key)?.merchant?.attempts[0].status).toBe(status);
});
