// isUint256Dec: 受け取った 10 進文字列が uint256 (0〜2^256-1) に入るか。abi の uint256 として符号化する前の確認
// (入らない値は viem が IntegerOutOfRangeError を投げる・2026-11-24 relay status の forwarder の照会で 500 になっていた)。

import { describe, expect, it } from 'vitest';
import { maxUint256 } from 'viem';
import { isUint256Dec } from '@/lib/relay/relayRoute';

describe('isUint256Dec', () => {
  it.each([
    '0',
    '1',
    '1000000000000000000',
    maxUint256.toString(),
    // 先頭に 0 を並べた正しい値 (main では受け付けていた・文字列の長さで断らない)
    '0'.repeat(79),
    `${'0'.repeat(10)}${maxUint256.toString()}`,
  ])(
    '%s は入る',
    (v) => {
      expect(isUint256Dec(v)).toBe(true);
    },
  );

  it.each([
    ['2^256', (maxUint256 + 1n).toString()],
    ['79 桁', '1'.repeat(79)],
    ['1,000 桁', '9'.repeat(1000)],
    ['負', '-1'],
    ['小数', '1.0'],
    ['空', ''],
    ['数でない', 'abc'],
  ])('%s は入らない', (_label, v) => {
    expect(isUint256Dec(v)).toBe(false);
  });

  it('文字列でないものは入らない', () => {
    expect(isUint256Dec(1)).toBe(false);
    expect(isUint256Dec(null)).toBe(false);
    expect(isUint256Dec(2n)).toBe(false);
  });
});
