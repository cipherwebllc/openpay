import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isSuccessSoundEnabled,
  setSuccessSoundEnabled,
  isOrderAlertSoundEnabled,
  setOrderAlertSoundEnabled,
} from '@/lib/soundPref';

const KEY = 'openpay:success-sound';
const ORDER_KEY = 'openpay:order-alert-sound';

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

  // 新着アラート音は **既定 OFF** ('1' のときだけ ON) = 完了音と逆の既定。
  describe('order-alert pref (既定 OFF・明示オプトイン)', () => {
    beforeEach(() => window.localStorage.removeItem(ORDER_KEY));

    it('既定は OFF (未設定時 false)', () => {
      expect(isOrderAlertSoundEnabled()).toBe(false);
    });

    it("'1' 保存時のみ ON、それ以外は OFF", () => {
      setOrderAlertSoundEnabled(true);
      expect(window.localStorage.getItem(ORDER_KEY)).toBe('1');
      expect(isOrderAlertSoundEnabled()).toBe(true);

      setOrderAlertSoundEnabled(false);
      expect(window.localStorage.getItem(ORDER_KEY)).toBe('0');
      expect(isOrderAlertSoundEnabled()).toBe(false);
    });

    it('未知の値は OFF 扱い', () => {
      window.localStorage.setItem(ORDER_KEY, 'garbage');
      expect(isOrderAlertSoundEnabled()).toBe(false);
    });

    it('getItem が throw → 既定 OFF にフォールバック (no throw)', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      expect(isOrderAlertSoundEnabled()).toBe(false);
      vi.restoreAllMocks();
    });
  });
});
