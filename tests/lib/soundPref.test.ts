import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isSuccessSoundEnabled, setSuccessSoundEnabled } from '@/lib/soundPref';

const KEY = 'openpay:success-sound';

describe('lib/soundPref', () => {
  beforeEach(() => {
    window.localStorage.removeItem(KEY);
  });

  it('既定は ON (未設定時 true)', () => {
    expect(isSuccessSoundEnabled()).toBe(true);
  });

  it("'0' 保存時のみ OFF、それ以外は ON", () => {
    setSuccessSoundEnabled(false);
    expect(window.localStorage.getItem(KEY)).toBe('0');
    expect(isSuccessSoundEnabled()).toBe(false);

    setSuccessSoundEnabled(true);
    expect(window.localStorage.getItem(KEY)).toBe('1');
    expect(isSuccessSoundEnabled()).toBe(true);
  });

  it('未知の値は ON 扱い (=「0 でなければ ON」)', () => {
    window.localStorage.setItem(KEY, 'garbage');
    expect(isSuccessSoundEnabled()).toBe(true);
  });

  describe('storage 不可環境でも throw しない', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('getItem が throw → 既定 ON にフォールバック', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      expect(() => isSuccessSoundEnabled()).not.toThrow();
      expect(isSuccessSoundEnabled()).toBe(true);
    });

    it('setItem が throw → 黙って諦める (no throw)', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      expect(() => setSuccessSoundEnabled(false)).not.toThrow();
    });
  });
});
