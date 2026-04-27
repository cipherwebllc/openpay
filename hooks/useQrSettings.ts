'use client';

import { useEffect, useState } from 'react';
import { safeGet, safeSet } from '@/lib/storage';
import type { TokenSymbol } from '@/lib/tokens';
import type { SplitDraft } from '@/lib/url';

export type QrSettings = {
  receiver: string;
  token: TokenSymbol;
  // 上級者向け: 顧客がガス代を負担する直接送金モード。
  // false (gasless+1%手数料) を既定にする。
  directTransfer: boolean;
  // 追加受取人 (最大 3、合計 % < 100)。空配列 = 単独受取人 (現行 UX)
  splits: SplitDraft[];
};

const STORAGE_KEY = 'openpay:qr-settings:v2';

const DEFAULT_SETTINGS: QrSettings = {
  receiver: '',
  token: 'usdc',
  directTransfer: false,
  splits: [],
};

function sanitizeSplits(loaded: unknown): SplitDraft[] {
  if (!Array.isArray(loaded)) return [];
  return loaded
    .filter(
      (e): e is SplitDraft =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as SplitDraft).address === 'string' &&
        typeof (e as SplitDraft).percent === 'string',
    )
    .slice(0, 3);
}

function sanitize(loaded: Partial<QrSettings>): QrSettings {
  return {
    receiver:
      typeof loaded.receiver === 'string'
        ? loaded.receiver
        : DEFAULT_SETTINGS.receiver,
    token:
      loaded.token === 'jpyc' || loaded.token === 'usdc'
        ? loaded.token
        : DEFAULT_SETTINGS.token,
    directTransfer:
      typeof loaded.directTransfer === 'boolean'
        ? loaded.directTransfer
        : DEFAULT_SETTINGS.directTransfer,
    splits: sanitizeSplits(loaded.splits),
  };
}

export function useQrSettings() {
  const [settings, setSettings] = useState<QrSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const loaded = safeGet<Partial<QrSettings>>(STORAGE_KEY, {});
    setSettings(sanitize(loaded));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    safeSet(STORAGE_KEY, settings);
  }, [settings, hydrated]);

  return { settings, setSettings, hydrated };
}
