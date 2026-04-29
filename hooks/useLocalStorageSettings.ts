'use client';

// LocalStorage 永続化 + sanitize 付き hydration の共通 hook。
// - 初回 mount で safeGet → sanitize → setSettings → hydrated=true
// - hydrated 後の settings 変更で safeSet (上書き防止: hydrated=false 中は書込まない)
// useQrSettings / useTipSettings / useCheckoutSettings の 3 hook 共通基盤。

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
    const loaded = safeGet<Partial<T>>(storageKey, {});
    setSettings(sanitize(loaded));
    setHydrated(true);
  }, [storageKey, sanitize]);

  useEffect(() => {
    if (!hydrated) return;
    safeSet(storageKey, settings);
  }, [storageKey, settings, hydrated]);

  return { settings, setSettings, hydrated };
}
