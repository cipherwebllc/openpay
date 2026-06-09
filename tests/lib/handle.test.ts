import { describe, it, expect } from 'vitest';
import { getAddress } from 'viem';
import {
  normalizeHandle,
  isValidHandleFormat,
  isReserved,
  validateHandle,
  validateTipConfig,
  configToSearchParams,
  parseHandleRecord,
  serializeHandleRecord,
  MAX_HANDLES_PER_WALLET,
  type HandleRecord,
  type PublishableTipConfig,
} from '@/lib/handle';
import { parseTipParams } from '@/lib/url';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

describe('normalizeHandle', () => {
  it('strips leading @, lowercases, trims', () => {
    expect(normalizeHandle('@Alice')).toBe('alice');
    expect(normalizeHandle('  @@Bob ')).toBe('bob');
    expect(normalizeHandle('CDX_01')).toBe('cdx_01');
  });
});

describe('isValidHandleFormat', () => {
  it('accepts 3-30 lowercase alnum + underscore', () => {
    expect(isValidHandleFormat('abc')).toBe(true);
    expect(isValidHandleFormat('good_one_99')).toBe(true);
    expect(isValidHandleFormat('a'.repeat(30))).toBe(true);
  });
  it('rejects too short / too long / bad chars', () => {
    expect(isValidHandleFormat('ab')).toBe(false);
    expect(isValidHandleFormat('a'.repeat(31))).toBe(false);
    expect(isValidHandleFormat('has-dash')).toBe(false);
    expect(isValidHandleFormat('has space')).toBe(false);
    expect(isValidHandleFormat('UpperCase')).toBe(false);
    expect(isValidHandleFormat('emoji😀x')).toBe(false);
  });
});

describe('isReserved', () => {
  it('flags routes, locales, brand terms; allows normal names', () => {
    expect(isReserved('api')).toBe(true);
    expect(isReserved('pay')).toBe(true);
    expect(isReserved('tip')).toBe(true);
    expect(isReserved('ja')).toBe(true);
    expect(isReserved('openpay')).toBe(true);
    expect(isReserved('alice')).toBe(false);
  });
});

describe('validateHandle', () => {
  it('normalizes and accepts a good handle', () => {
    expect(validateHandle('@Alice')).toEqual({ ok: true, handle: 'alice' });
    expect(validateHandle('good_one')).toEqual({ ok: true, handle: 'good_one' });
  });
  it('rejects reserved with reason=reserved', () => {
    expect(validateHandle('pay')).toEqual({ ok: false, reason: 'reserved' });
    expect(validateHandle('@OpenPay')).toEqual({ ok: false, reason: 'reserved' });
  });
  it('rejects bad format with reason=format', () => {
    expect(validateHandle('ab')).toEqual({ ok: false, reason: 'format' });
    expect(validateHandle('has-dash')).toEqual({ ok: false, reason: 'format' });
  });
});

describe('validateTipConfig', () => {
  it('accepts a valid jpyc config and returns a checksummed, parsed config', () => {
    const res = validateTipConfig({ to: ADDR.toLowerCase(), token: 'jpyc' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.to).toBe(getAddress(ADDR));
      expect(res.config.token).toBe('jpyc');
    }
  });
  it('rejects non-object / missing fields', () => {
    expect(validateTipConfig(null).ok).toBe(false);
    expect(validateTipConfig('x').ok).toBe(false);
    expect(validateTipConfig({ token: 'jpyc' }).ok).toBe(false);
    expect(validateTipConfig({ to: ADDR }).ok).toBe(false);
  });
  it('rejects invalid address / token (delegates to parseTipParams)', () => {
    expect(validateTipConfig({ to: '0xnope', token: 'jpyc' }).ok).toBe(false);
    expect(validateTipConfig({ to: ADDR, token: 'eth' }).ok).toBe(false);
  });
});

describe('configToSearchParams', () => {
  it('round-trips back through parseTipParams', () => {
    const config: PublishableTipConfig = {
      to: ADDR,
      token: 'usdc',
      chain: 'base',
      name: 'Alice',
      crossChain: false,
    };
    const parsed = parseTipParams(config.to, configToSearchParams(config));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.token).toBe('usdc');
      expect(parsed.params.chain).toBe('base');
      expect(parsed.params.name).toBe('Alice');
      expect(parsed.params.crossChain).toBe(false);
    }
  });
});

describe('parseHandleRecord', () => {
  const good: HandleRecord = {
    owner: ADDR,
    config: { to: ADDR, token: 'jpyc', name: 'Alice' },
    createdAt: 1,
    updatedAt: 2,
  };

  it('parses a well-formed record (round-trip)', () => {
    expect(parseHandleRecord(serializeHandleRecord(good))).toEqual(good);
  });
  it('returns null for null / malformed JSON', () => {
    expect(parseHandleRecord(null)).toBeNull();
    expect(parseHandleRecord('not json')).toBeNull();
    expect(parseHandleRecord('123')).toBeNull();
  });
  it('returns null when required fields are missing or mistyped', () => {
    expect(parseHandleRecord(JSON.stringify({ owner: ADDR }))).toBeNull();
    expect(
      parseHandleRecord(JSON.stringify({ ...good, owner: 123 })),
    ).toBeNull();
    expect(
      parseHandleRecord(JSON.stringify({ ...good, config: { token: 'jpyc' } })),
    ).toBeNull();
    expect(
      parseHandleRecord(
        JSON.stringify({ ...good, config: { to: ADDR, token: 'jpyc', presets: [1, 2] } }),
      ),
    ).toBeNull();
  });
});

describe('MAX_HANDLES_PER_WALLET', () => {
  it('is 3 (D2)', () => {
    expect(MAX_HANDLES_PER_WALLET).toBe(3);
  });
});
