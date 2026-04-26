'use client';

import { useEffect, useState } from 'react';
import { safeGet, safeSet } from '@/lib/storage';
import type { TokenSymbol } from '@/lib/tokens';

export type TipSettings = {
  receiver: string;
  token: TokenSymbol;
  name: string;
  message: string;
  color: string;
  presets: string;
  thanks: string;
  thanksUrl: string;
  webhook: string;
};

const STORAGE_KEY = 'openpay:tip-settings:v2';

const DEFAULT_SETTINGS: TipSettings = {
  receiver: '',
  token: 'jpyc',
  name: '',
  message: '',
  color: '#2563eb',
  presets: '',
  thanks: '',
  thanksUrl: '',
  webhook: '',
};

function sanitize(loaded: Partial<TipSettings>): TipSettings {
  return {
    receiver:
      typeof loaded.receiver === 'string'
        ? loaded.receiver
        : DEFAULT_SETTINGS.receiver,
    token:
      loaded.token === 'jpyc' || loaded.token === 'usdc'
        ? loaded.token
        : DEFAULT_SETTINGS.token,
    name:
      typeof loaded.name === 'string' ? loaded.name : DEFAULT_SETTINGS.name,
    message:
      typeof loaded.message === 'string'
        ? loaded.message
        : DEFAULT_SETTINGS.message,
    color:
      typeof loaded.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(loaded.color)
        ? loaded.color.toLowerCase()
        : DEFAULT_SETTINGS.color,
    presets:
      typeof loaded.presets === 'string'
        ? loaded.presets
        : DEFAULT_SETTINGS.presets,
    thanks:
      typeof loaded.thanks === 'string'
        ? loaded.thanks
        : DEFAULT_SETTINGS.thanks,
    thanksUrl:
      typeof loaded.thanksUrl === 'string'
        ? loaded.thanksUrl
        : DEFAULT_SETTINGS.thanksUrl,
    webhook:
      typeof loaded.webhook === 'string'
        ? loaded.webhook
        : DEFAULT_SETTINGS.webhook,
  };
}

export function useTipSettings() {
  const [settings, setSettings] = useState<TipSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const loaded = safeGet<Partial<TipSettings>>(STORAGE_KEY, {});
    setSettings(sanitize(loaded));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    safeSet(STORAGE_KEY, settings);
  }, [settings, hydrated]);

  return { settings, setSettings, hydrated };
}
