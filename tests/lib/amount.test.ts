import { describe, it, expect } from 'vitest';
import { editGroupedAmount, groupAmountDigits, truncateAmount, normalizeAmountList } from '@/lib/amount';

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

describe('groupAmountDigits', () => {
  it('整数部だけに 3 桁区切りを入れる (文字列のまま・丸めない)', () => {
    expect(groupAmountDigits('3000')).toBe('3,000');
    expect(groupAmountDigits('1000.5')).toBe('1,000.5');
    expect(groupAmountDigits('1234567.123456789012345678')).toBe('1,234,567.123456789012345678');
    expect(groupAmountDigits('')).toBe('');
    expect(groupAmountDigits('.5')).toBe('.5');
  });

  it('最初の小数点より後ろは落とさない (入力途中の文字を表示から消さない)', () => {
    expect(groupAmountDigits('12.5.')).toBe('12.5.');
  });
});

describe('editGroupedAmount (桁区切りつきの金額欄の編集)', () => {
  const edit = (value: string, caret: number, prev: string, inputType = 'insertText', decimals = 18) =>
    editGroupedAmount({ value, caret, inputType, prev, decimals });

  it('打つたびに区切りが動いても、caret は打った文字の直後', () => {
    // 1,234 の 1 の後ろに 9 → 19,234 (caret は 9 の直後 = 左に 2 文字)
    expect(edit('19,234', 2, '1234')).toEqual({ amount: '19234', caretLeft: 2 });
    // 末尾に打つ
    expect(edit('1,2345', 6, '1234')).toEqual({ amount: '12345', caretLeft: 5 });
  });

  it('区切りの直後で Backspace → 区切りの左の数字を消す (値が変わらないまま caret が末尾へ飛ばない)', () => {
    // 12,|345 で Backspace → 入力欄は 12345 (caret 2) → 1345 (caret は 1 の直後)
    expect(edit('12345', 2, '12345', 'deleteContentBackward')).toEqual({ amount: '1345', caretLeft: 1 });
  });

  it('区切りの直前で Delete → 区切りの右の数字を消す', () => {
    // 12|,345 で Delete → 入力欄は 12345 (caret 2) → 1245 (caret は 2 の直後のまま)
    expect(edit('12345', 2, '12345', 'deleteContentForward')).toEqual({ amount: '1245', caretLeft: 2 });
  });

  it('小数の桁を超えて切り捨てても、caret は打った数字の直後 (USDC 6 桁)', () => {
    // 1.|234567 に 9 → 1.9234567 → 1.923456 (caret は 9 の直後 = 左に 3 文字)
    expect(edit('1.9234567', 3, '1.234567', 'insertText', 6)).toEqual({ amount: '1.923456', caretLeft: 3 });
  });

  it('小数点は 1 つだけ: 2 つ目は受け付けず、caret は打つ前の位置', () => {
    expect(edit('12.5.', 5, '12.5')).toEqual({ amount: '12.5', caretLeft: 4 });
    expect(edit('1.2.5', 2, '12.5')).toEqual({ amount: '12.5', caretLeft: 1 });
  });

  it('区切りつきの貼り付け・数字以外は値に入れない (URL に入る値は区切りなし)', () => {
    expect(edit('1,500', 5, '')).toEqual({ amount: '1500', caretLeft: 4 });
    expect(edit('1a0', 2, '10')).toEqual({ amount: '10', caretLeft: 1 });
  });
});
