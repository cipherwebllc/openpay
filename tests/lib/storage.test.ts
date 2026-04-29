import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  // jsdom の Storage 実装は WebIDL Proxy でラップされており、setItem を
  // 個別に上書きしても内部 [[Set]] が動作する。代わりに window.localStorage
  // 全体を fake オブジェクトで一時差替え、safeSet の catch path を発火させる。
  function withFailingStorage(
    overrides: Partial<Storage>,
    fn: () => void,
  ) {
    const original = window.localStorage;
    const fake: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {},
      ...overrides,
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: fake,
    });
    try {
      fn();
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: original,
      });
    }
  }

  it('safeSet が throw する状況 (Safari ITP / quota exceeded) でも例外漏れなし', () => {
    let observedThrow = false;
    withFailingStorage(
      {
        setItem: () => {
          observedThrow = true;
          throw new DOMException('quota exceeded', 'QuotaExceededError');
        },
      },
      () => {
        expect(() => safeSet('full', { large: 'payload' })).not.toThrow();
      },
    );
    expect(observedThrow).toBe(true);
  });

  it('safeSet が throw した後でも別 key の書込は成功する (storage 復元後)', () => {
    withFailingStorage(
      {
        setItem: () => {
          throw new Error('transient');
        },
      },
      () => {
        safeSet('a', { v: 1 }); // throw 経路 (storage は fake)
      },
    );
    // 元の localStorage に戻った後の通常経路
    safeSet('b', { v: 2 });
    expect(safeGet('b', null)).toEqual({ v: 2 });
  });

  it('SSR (typeof window === "undefined"): safeGet は fallback を返し、safeSet は no-op', () => {
    const originalWindow = globalThis.window;
    // window 全体を undefined 化して SSR 環境を再現。
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });
    try {
      expect(safeGet('any-key', { ssr: 'fallback' })).toEqual({ ssr: 'fallback' });
      // safeSet は no-op (例外も値の変化も無し)
      expect(() => safeSet('any-key', { ignored: true })).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
    // window 復元後は通常通り書き込み可能
    safeSet('after-ssr', { restored: true });
    expect(safeGet('after-ssr', null)).toEqual({ restored: true });
  });

  it('safeGet が getItem の throw でも fallback (Safari private mode 等)', () => {
    let observedThrow = false;
    withFailingStorage(
      {
        getItem: () => {
          observedThrow = true;
          throw new Error('SecurityError');
        },
      },
      () => {
        expect(safeGet('any', { fallback: 'ok' })).toEqual({ fallback: 'ok' });
      },
    );
    expect(observedThrow).toBe(true);
  });
});
