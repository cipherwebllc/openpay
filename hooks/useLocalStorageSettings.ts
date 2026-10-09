'use client';

// LocalStorage 永続化 + sanitize 付き hydration の共通 hook。
// - 初回 mount で safeGet → sanitize → setSettings → hydrated=true。hydrate 直後の 1 回は設定全体を書く
//   (旧 schema の移行 = sanitize が落としたキーを保存からも消す)。
// - それ以降の保存は「このタブが変えたキーだけを、最新の保存値に重ねて書く」(read-modify-write)。
//   古い state のタブが 1 項目だけ変えたときに、別のタブで直した受取先・インボイス番号などを古い値で
//   書き戻さないため。最新の保存値が読めない (消えた・壊れた) ときは設定全体を書く (変えたキーだけで
//   上書きして他のキーを失わない)。
// - 別のタブ・ウィンドウが同じ key を書いたら (storage イベント)、oldValue と newValue を比べて
//   **変わったキーだけ** を今の state に重ねて sanitize する。全消去 (key === null)・この key の削除
//   (newValue === null)・読めない値は無視して今の state を保つ (既定への復元として扱わない: 受取先が
//   空欄に戻ると接続ウォレットからの自動補完 (useReceiverAutofill) が走り、受取先が別のウォレットに
//   変わる波及を断つ)。storage イベントは自分のタブでは発火しないので、取り込みは別タブの書き込みに限られる。
// useQrSettings / useTipSettings などの共通基盤。

import { useEffect, useRef, useState } from 'react';
import { logger } from '@/lib/logger';
import { safeGet, safeSet } from '@/lib/storage';

/** 保存文字列を JSON の object として読む。null・読めない・object でない (配列・文字列) は null。 */
function parseStoredObject<T extends object>(raw: string | null): Partial<T> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<T>) : null;
  } catch {
    return null;
  }
}

/** localStorage の生の値 (保存の直前に最新を読むため)。storage 利用不可は null (呼び出し側は全体を書く)。 */
function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    logger.warn('localStorage.get failed', { key, error });
    return null;
  }
}

/** 2 つの object で値 (JSON として) が違うキー。片方にしか無いキーも含む。 */
function changedKeys<T extends object>(a: Partial<T>, b: Partial<T>): (keyof T)[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof T)[]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function pick<T extends object>(source: Partial<T>, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    if (k in source) out[k] = source[k];
  }
  return out;
}

export function useLocalStorageSettings<T extends object>(
  storageKey: string,
  defaultValue: T,
  sanitize: (loaded: Partial<T>) => T,
) {
  const [settings, setSettings] = useState<T>(defaultValue);
  const [hydrated, setHydrated] = useState(false);
  // このタブが最後に保存した (または別タブから取り込んだ) 状態。次の保存で「このタブが変えたキー」を割り出す。
  // null = hydrate 直後でまだ保存していない (そのときは全体を書く)。
  const writtenRef = useRef<T | null>(null);

  useEffect(() => {
    writtenRef.current = null;
    setSettings(sanitize(safeGet<Partial<T>>(storageKey, {})));
    setHydrated(true);
    const onStorage = (e: StorageEvent) => {
      // key === null は localStorage.clear()。この key の削除 (newValue === null) と同じく無視する (上記)。
      if (e.key !== storageKey) return;
      const next = parseStoredObject<T>(e.newValue);
      if (!next) return;
      const prev = parseStoredObject<T>(e.oldValue) ?? {};
      const changed = changedKeys(prev, next);
      if (changed.length === 0) return;
      setSettings((current) => sanitize({ ...current, ...pick(next, changed) }));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey, sanitize]);

  useEffect(() => {
    if (!hydrated) return;
    const written = writtenRef.current;
    if (written === null) {
      safeSet(storageKey, settings);
      writtenRef.current = settings;
      return;
    }
    const changed = changedKeys(written, settings);
    if (changed.length === 0) return;
    const latest = parseStoredObject<T>(readRaw(storageKey));
    if (latest) {
      // このタブが変えたキーだけを重ねる。このタブが外したキー (undefined) は保存からも外す (全体を書いていた
      // 従来と同じ結果)。他のキーは最新の保存値のまま。
      const merged: Partial<T> = { ...latest };
      for (const k of changed) {
        if (k in settings) merged[k] = settings[k];
        else delete merged[k];
      }
      safeSet(storageKey, merged);
    } else {
      safeSet(storageKey, settings);
    }
    writtenRef.current = settings;
  }, [storageKey, settings, hydrated]);

  return { settings, setSettings, hydrated };
}
