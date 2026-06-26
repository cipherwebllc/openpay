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

  it('base64url 文字集合のみ (+ / = を含まない・URL 安全)', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateStatusToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(token).not.toMatch(/[+/=]/);
    }
  });

  it('decode すると 32 byte (256-bit) に戻る — 実データ検査', () => {
    const token = generateStatusToken();
    // base64url → 標準 base64 に戻し padding を補って atob → byte 列。
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    expect(atob(padded).length).toBe(32);
  });
});
