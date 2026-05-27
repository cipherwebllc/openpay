import { describe, it, expect } from 'vitest';
import { truncateAmount, normalizeAmountList } from '@/lib/amount';

describe('truncateAmount', () => {
  it('digit / 小数点以外を除去する', () => {
    expect(truncateAmount('1a2b3', 6)).toBe('123');
    expect(truncateAmount('1,000', 6)).toBe('1000');
    expect(truncateAmount('¥500', 6)).toBe('500');
  });

  it('小数桁を decimals に切り詰める', () => {
    expect(truncateAmount('0.1234567890', 6)).toBe('0.123456');
    expect(truncateAmount('1.5', 6)).toBe('1.5'); // decimals 以内はそのまま
    expect(truncateAmount('10', 6)).toBe('10'); // 小数点なしはそのまま
  });

  it('digit を含まない入力は空文字を返す', () => {
    expect(truncateAmount('abc', 6)).toBe('');
    expect(truncateAmount('', 6)).toBe('');
  });
});

describe('normalizeAmountList', () => {
  it('0 / 不正 / 空を除外し、有効値のみ残す', () => {
    expect(normalizeAmountList(['500', '0', 'abc', '', '1000'], 6)).toEqual([
      '500',
      '1000',
    ]);
  });

  it('decimals に丸め、丸め後に重複する値はマージする', () => {
    // USDC (6 桁) では 0.1234567890123 と 0.1234567890124 が同値に潰れる
    expect(
      normalizeAmountList(['0.1234567890123', '0.1234567890124', '500'], 6),
    ).toEqual(['0.123456', '500']);
  });

  it('丸め後に 0 になる値は除外する', () => {
    // 0.0000001 (7 桁) は USDC (6 桁) で 0.000000 → 0 になり除外
    expect(normalizeAmountList(['0.0000001', '500'], 6)).toEqual(['500']);
  });

  it('JPYC (18 桁) では高精度値もそのまま保持する', () => {
    expect(normalizeAmountList(['0.1234567890123', '500'], 18)).toEqual([
      '0.1234567890123',
      '500',
    ]);
  });

  it('全件無効なら空配列を返す (fallback は呼び出し側の責務)', () => {
    expect(normalizeAmountList(['0', 'abc', ''], 6)).toEqual([]);
  });
});
