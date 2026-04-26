import { describe, it, expect, beforeEach } from 'vitest';
import { safeGet, safeSet } from '@/lib/storage';

describe('safeGet / safeSet', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未保存 → fallback を返す', () => {
    expect(safeGet('absent', { a: 1 })).toEqual({ a: 1 });
  });

  it('roundtrip: 保存した値を読み戻す', () => {
    safeSet('k1', { foo: 'bar', n: 42 });
    expect(safeGet('k1', null)).toEqual({ foo: 'bar', n: 42 });
  });

  it('プリミティブ (string / number / boolean) も保存できる', () => {
    safeSet('s', 'hello');
    safeSet('n', 99);
    safeSet('b', true);
    expect(safeGet('s', '')).toBe('hello');
    expect(safeGet('n', 0)).toBe(99);
    expect(safeGet('b', false)).toBe(true);
  });

  it('壊れた JSON が入っていても fallback を返す (例外を投げない)', () => {
    window.localStorage.setItem('broken', '{not json');
    expect(safeGet('broken', { default: 1 })).toEqual({ default: 1 });
  });

  it('null は明示的に保存可能 (上書き)', () => {
    safeSet('x', null);
    expect(safeGet('x', 'fallback')).toBeNull();
  });

  it('上書き保存', () => {
    safeSet('k', 'v1');
    safeSet('k', 'v2');
    expect(safeGet('k', '')).toBe('v2');
  });
});
