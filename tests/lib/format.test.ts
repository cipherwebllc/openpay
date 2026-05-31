import { describe, it, expect } from 'vitest';
import { shortAddress, pad } from '@/lib/format';

describe('pad', () => {
  it('1 桁はゼロ埋めして 2 桁にする', () => {
    expect(pad(0)).toBe('00');
    expect(pad(1)).toBe('01');
    expect(pad(9)).toBe('09');
  });

  it('2 桁はそのまま', () => {
    expect(pad(10)).toBe('10');
    expect(pad(23)).toBe('23');
    expect(pad(59)).toBe('59');
  });

  it('3 桁以上は切り詰めず全桁返す (padStart の挙動)', () => {
    expect(pad(100)).toBe('100');
    expect(pad(2026)).toBe('2026');
  });
});

describe('shortAddress', () => {
  it('42 文字の checksum address を 0x123456…1234 形式へ短縮', () => {
    expect(shortAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(
      '0x8335…2913',
    );
  });

  it('12 文字以下はそのまま返す (ENS 等の短い文字列保護)', () => {
    expect(shortAddress('0xabc')).toBe('0xabc');
    expect(shortAddress('vitalik.eth')).toBe('vitalik.eth');
    expect(shortAddress('123456789012')).toBe('123456789012'); // 12 文字
  });

  it('13 文字以上は短縮', () => {
    expect(shortAddress('1234567890123')).toBe('123456…0123');
  });

  it('空文字はそのまま返す', () => {
    expect(shortAddress('')).toBe('');
  });
});
