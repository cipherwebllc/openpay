import { describe, it, expect } from 'vitest';
import { generateStatusToken } from '@/lib/orderStatusToken';
import { isOrderTokenLike } from '@/lib/orderToken';

describe('generateStatusToken', () => {
  it('isOrderTokenLike を満たす 43字 base64url を返す', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateStatusToken();
      expect(token).toHaveLength(43);
      expect(isOrderTokenLike(token)).toBe(true);
    }
  });

  it('呼ぶたびに異なる (乱数・推測不能)', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateStatusToken()));
    expect(set.size).toBe(100);
  });
});
