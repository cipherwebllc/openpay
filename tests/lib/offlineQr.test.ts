import { describe, it, expect } from 'vitest';
import {
  isLastQrRecord,
  LAST_QR_KEY,
  type LastQrRecord,
} from '@/lib/offlineQr';

const valid: LastQrRecord = {
  payUrl: 'https://open-pay.jp/ja/pay?to=0xabc&amount=1000',
  amountLabel: '1,000 JPYC',
  tokenChainLabel: 'JPYC · Polygon',
  storeName: '神田珈琲',
  ts: 1_700_000_000_000,
};

describe('offlineQr', () => {
  it('uses a versioned key', () => {
    expect(LAST_QR_KEY).toBe('openpay:lastQr:v1');
  });

  it('accepts a valid record (round-trips through JSON)', () => {
    expect(isLastQrRecord(valid)).toBe(true);
    const parsed = JSON.parse(JSON.stringify(valid)) as unknown;
    expect(isLastQrRecord(parsed)).toBe(true);
  });

  it('accepts a record without the optional storeName', () => {
    const { storeName: _omit, ...rest } = valid;
    expect(isLastQrRecord(rest)).toBe(true);
  });

  it('rejects non-objects', () => {
    for (const o of [null, undefined, 'x', 42, [], true]) {
      expect(isLastQrRecord(o)).toBe(false);
    }
  });

  it('rejects an empty or non-string payUrl', () => {
    expect(isLastQrRecord({ ...valid, payUrl: '' })).toBe(false);
    expect(isLastQrRecord({ ...valid, payUrl: 123 })).toBe(false);
  });

  it('rejects missing label fields', () => {
    const { amountLabel: _a, ...noAmount } = valid;
    const { tokenChainLabel: _t, ...noChain } = valid;
    expect(isLastQrRecord(noAmount)).toBe(false);
    expect(isLastQrRecord(noChain)).toBe(false);
  });

  it('rejects a non-string storeName when present', () => {
    expect(isLastQrRecord({ ...valid, storeName: 5 })).toBe(false);
  });

  it('rejects a non-positive or non-finite ts', () => {
    expect(isLastQrRecord({ ...valid, ts: 0 })).toBe(false);
    expect(isLastQrRecord({ ...valid, ts: -1 })).toBe(false);
    expect(isLastQrRecord({ ...valid, ts: Number.NaN })).toBe(false);
    expect(isLastQrRecord({ ...valid, ts: '1700000000000' })).toBe(false);
  });
});
