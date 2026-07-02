'use client';

// localStorage に「単一レコード」を型安全に永続化する汎用 hook。JSON parse → validate → stringify →
// remove の定型 (try-catch で storage ブロック環境 = SNS アプリ内ブラウザ / SSR = window 不在 でも
// throw させない best-effort) を一箇所に集約する。
//
// ⚠️ money-path 隣接: 二重支払い防止の resume 層 (useJpycEntitlementPay) がこの hook に依存する。
// load は **未保存 / parse 失敗 / 不正 shape のいずれでも null を返す fail-safe** を厳守する。呼び出し側の
// validator (isValid 型ガード) と key は tier / 用途ごとに固有であり、絶対に混同しないこと (validator を
// 取り違えると resume-safety が静かに壊れる)。
//
// key が動的 (tier ごと・per-wallet 等) なため factory ではなく hook 形態にする。返す load/save/clear は
// key 単位で安定 (useCallback) し、既存の effect / callback 依存配列にそのまま入れられる。

import { useCallback } from 'react';

export type LocalStorageRecord<T> = {
  /** 保存値を検証して返す。未保存 / parse 失敗 / 不正 shape はすべて null (fail-safe)。 */
  load: () => T | null;
  /** JSON.stringify で保存する (storage 利用不可なら黙って諦める)。 */
  save: (value: T) => void;
  /** 記録を削除する (storage 利用不可なら noop)。 */
  clear: () => void;
};

export function useLocalStorageRecord<T>(
  key: string,
  isValid: (o: unknown) => o is T,
): LocalStorageRecord<T> {
  const load = useCallback((): T | null => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const o = JSON.parse(raw) as unknown;
      if (isValid(o)) return o;
    } catch {
      /* storage 利用不可 / 不正値 */
    }
    return null;
  }, [key, isValid]);
  const save = useCallback(
    (value: T): void => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* 永続化を諦める (呼び出し側は今回のメモリ上で続行する) */
      }
    },
    [key],
  );
  const clear = useCallback((): void => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  }, [key]);
  return { load, save, clear };
}
