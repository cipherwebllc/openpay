import { describe, expect, it } from 'vitest';
import { parseExpiresAt } from '@/lib/timedGrant';

describe('parseExpiresAt', () => {
  it.each([
    ['null', null, null],
    ['空文字', '', null],
    ['空白', '   ', 0],
    ['非数値', 'not-a-number', null],
    ['有限な数値', ' 1750000000000 ', 1_750_000_000_000],
  ] as const)('%s を既存の expiresAt 規約どおり解釈する', (_name, raw, expected) => {
    expect(parseExpiresAt(raw)).toBe(expected);
  });
});
