import { describe, it, expect } from 'vitest';
import { isHandlePagePath } from '@/lib/handlePath';

describe('isHandlePagePath', () => {
  it('@handle ページ (decoded / encoded / en) を検出', () => {
    expect(isHandlePagePath('/ja/@aoi')).toBe(true);
    expect(isHandlePagePath('/ja/%40aoi')).toBe(true);
    expect(isHandlePagePath('/en/@aoi')).toBe(true);
    expect(isHandlePagePath('/ja/%40Aoi')).toBe(true); // 大文字 %40 も
  });

  it('通常ページは false', () => {
    expect(isHandlePagePath('/ja')).toBe(false);
    expect(isHandlePagePath('/ja/create')).toBe(false);
    expect(isHandlePagePath('/en/history')).toBe(false);
    expect(isHandlePagePath('/ja/discovery')).toBe(false);
  });

  it('null/undefined/空 は false (provider 無し=通常扱い)', () => {
    expect(isHandlePagePath(null)).toBe(false);
    expect(isHandlePagePath(undefined)).toBe(false);
    expect(isHandlePagePath('')).toBe(false);
  });
});
