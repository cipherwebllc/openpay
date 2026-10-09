'use client';

// LocalStorage 永続化 + sanitize 付き hydration の共通 hook。
// - 初回 mount で safeGet → sanitize → setSettings → hydrated=true
// - hydrated 後の settings 変更で safeSet (上書き防止: hydrated=false 中は書込まない)
// - 別のタブ・ウィンドウが同じ key を書いたら (storage イベント) 読み直して sanitize → setSettings。
//   同期しないと、古いタブで 1 項目だけ変えたときに設定オブジェクト全体 (受取先・インボイス番号など、
//   別のタブで直した値) を古い値で書き戻す。storage イベントは自分のタブでは発火しないので、
//   読み直しは別タブの書き込みに限られる (自分の変更は従来どおり setSettings → safeSet)。
// useQrSettings / useTipSettings などの共通基盤。

import { useEffect, useState } from 'react';
import { safeGet, safeSet } from '@/lib/storage';

export function useLocalStorageSettings<T>(
  storageKey: string,
  defaultValue: T,
  sanitize: (loaded: Partial<T>) => T,
) {
  const [settings, setSettings] = useState<T>(defaultValue);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const load = () => setSettings(sanitize(safeGet<Partial<T>>(storageKey, {})));
    load();
    setHydrated(true);
    // key === null は localStorage.clear() (全消去) なので同じく読み直す (既定に戻る)。
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey && e.key !== null) return;
      load();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey, sanitize]);

  useEffect(() => {
    if (!hydrated) return;
    safeSet(storageKey, settings);
  }, [storageKey, settings, hydrated]);

  return { settings, setSettings, hydrated };
}
