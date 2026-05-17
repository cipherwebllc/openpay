'use client';

// LocalStorage 上の HistoryEntry[] を React state として購読する。
//
// 二経路で再 load する:
//   1. window 'storage' event  — 別タブで LocalStorage が書き換わったとき
//   2. CustomEvent 'openpay:history-changed' — 自タブで appendHistory が呼ばれたとき
//      (LocalStorage の storage event は他タブにしか発火しない仕様の補完)
//
// SSR では `loadHistory()` が空配列を返す (storage.ts が typeof window で early
// return)。client mount 後の初回 effect で改めて load する必要はなく、
// useState の initializer が client では既に localStorage を読んでいる。

import { useEffect, useState } from 'react';
import {
  HISTORY_CHANGED_EVENT,
  HISTORY_STORAGE_KEY,
  loadHistory,
  type HistoryEntry,
} from '@/lib/history';

export function useHistory(): {
  entries: HistoryEntry[];
  /** ハイドレート完了後の true。SSR 初回描画と client mount 後の差分を吸収。 */
  hydrated: boolean;
} {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // SSR では initializer が [] を返すので、mount 後に正しい値で同期。
    setEntries(loadHistory());
    setHydrated(true);

    const reload = () => setEntries(loadHistory());

    const onStorage = (e: StorageEvent) => {
      // 他タブの 'storage' event は key を指定するが、clear() 時は key=null。
      // どちらも reload する (clear なら空配列が返るだけ)。
      if (e.key === null || e.key === HISTORY_STORAGE_KEY) {
        reload();
      }
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(HISTORY_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(HISTORY_CHANGED_EVENT, reload);
    };
  }, []);

  return { entries, hydrated };
}
