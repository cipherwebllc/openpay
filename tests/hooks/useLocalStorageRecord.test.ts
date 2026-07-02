// useLocalStorageRecord (P6-7 抽出) の focused unit test。二重支払い防止 resume 層が依存する
// 「round-trip / fail-safe null / key 分離 / storage-blocked no-throw」の契約を検証する。
// 実際の resume 挙動 (useJpycEntitlementPay 経由) は useProSubscribe / useCsvPassSubscribe test が担保。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLocalStorageRecord } from '@/hooks/useLocalStorageRecord';

type Rec = { id: string; n: number };
const isRec = (o: unknown): o is Rec => {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Partial<Rec>;
  return typeof r.id === 'string' && typeof r.n === 'number';
};

type Other = { flag: boolean };
const isOther = (o: unknown): o is Other => {
  if (typeof o !== 'object' || o === null) return false;
  return typeof (o as Partial<Other>).flag === 'boolean';
};

const KEY_A = 'test:recordA';
const KEY_B = 'test:recordB';

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('useLocalStorageRecord', () => {
  it('round-trip: save した値を load がそのまま返し JSON 直列化されている', () => {
    const { result } = renderHook(() => useLocalStorageRecord(KEY_A, isRec));
    const rec: Rec = { id: 'x', n: 42 };
    result.current.save(rec);
    expect(result.current.load()).toEqual(rec);
    expect(window.localStorage.getItem(KEY_A)).toBe(JSON.stringify(rec));
  });

  it('未保存 key は null (fail-safe)', () => {
    const { result } = renderHook(() => useLocalStorageRecord(KEY_A, isRec));
    expect(result.current.load()).toBeNull();
  });

  it('壊れた JSON は null (throw せず fail-safe)', () => {
    window.localStorage.setItem(KEY_A, '{not valid json');
    const { result } = renderHook(() => useLocalStorageRecord(KEY_A, isRec));
    expect(() => result.current.load()).not.toThrow();
    expect(result.current.load()).toBeNull();
  });

  it('shape 不正 (validator 不合格) は null', () => {
    window.localStorage.setItem(KEY_A, JSON.stringify({ id: 'x' })); // n 欠落
    const { result } = renderHook(() => useLocalStorageRecord(KEY_A, isRec));
    expect(result.current.load()).toBeNull();
  });

  it('primitive / null の保存値も null (throw せず)', () => {
    const { result } = renderHook(() => useLocalStorageRecord(KEY_A, isRec));
    window.localStorage.setItem(KEY_A, JSON.stringify(null));
    expect(result.current.load()).toBeNull();
    window.localStorage.setItem(KEY_A, JSON.stringify(5));
    expect(result.current.load()).toBeNull();
  });

  it('別 key は衝突せず独立した validator/namespace で扱う', () => {
    const a = renderHook(() => useLocalStorageRecord(KEY_A, isRec));
    const b = renderHook(() => useLocalStorageRecord(KEY_B, isOther));
    a.result.current.save({ id: 'a', n: 1 });
    b.result.current.save({ flag: true });
    expect(a.result.current.load()).toEqual({ id: 'a', n: 1 });
    expect(b.result.current.load()).toEqual({ flag: true });
    // A の validator は B 用の shape (別型) を弾く: B の値を A key に置くと null になる。
    window.localStorage.setItem(KEY_A, JSON.stringify({ flag: true }));
    expect(a.result.current.load()).toBeNull();
  });

  it('clear は該当 key のみ削除する (別 key は残す)', () => {
    const a = renderHook(() => useLocalStorageRecord(KEY_A, isRec));
    const b = renderHook(() => useLocalStorageRecord(KEY_B, isOther));
    a.result.current.save({ id: 'a', n: 1 });
    b.result.current.save({ flag: true });
    a.result.current.clear();
    expect(a.result.current.load()).toBeNull();
    expect(window.localStorage.getItem(KEY_A)).toBeNull();
    expect(b.result.current.load()).toEqual({ flag: true });
  });

  it('storage-blocked (getItem throw) でも load は null・no-throw', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const { result } = renderHook(() => useLocalStorageRecord(KEY_A, isRec));
    expect(() => result.current.load()).not.toThrow();
    expect(result.current.load()).toBeNull();
  });

  it('storage-blocked (setItem/removeItem throw) でも save/clear は no-throw', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const { result } = renderHook(() => useLocalStorageRecord(KEY_A, isRec));
    expect(() => result.current.save({ id: 'x', n: 1 })).not.toThrow();
    expect(() => result.current.clear()).not.toThrow();
  });
});
