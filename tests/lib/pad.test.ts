import { describe, it, expect } from 'vitest';
import { pad } from '@/lib/pad';

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
