import { describe, it, expect } from 'vitest';
import { shortAddress } from '@/lib/format';

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
