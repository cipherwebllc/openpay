'use client';

import type { ChainSlug } from '@/lib/chains';
import type { TokenSymbol } from '@/lib/tokens';
import { COLOR_PATTERN } from '@/lib/url';
import { useLocalStorageSettings } from './useLocalStorageSettings';
import { normalizeChainForToken } from './useQrSettings';

export type TipSettings = {
  receiver: string;
  token: TokenSymbol;
  // 送金チェーン (slug)。usdc は 4 chain 選択可、jpyc は polygon 固定。
  chain: ChainSlug;
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
  chain: 'polygon',
  name: '',
  message: '',
  color: '#2563eb',
  presets: '',
  thanks: '',
  thanksUrl: '',
  webhook: '',
};

function sanitize(loaded: Partial<TipSettings>): TipSettings {
  const token: TokenSymbol =
    loaded.token === 'jpyc' || loaded.token === 'usdc'
      ? loaded.token
      : DEFAULT_SETTINGS.token;
  return {
    receiver:
      typeof loaded.receiver === 'string'
        ? loaded.receiver
        : DEFAULT_SETTINGS.receiver,
    token,
    chain: normalizeChainForToken(token, loaded.chain),
    name:
      typeof loaded.name === 'string' ? loaded.name : DEFAULT_SETTINGS.name,
    message:
      typeof loaded.message === 'string'
        ? loaded.message
        : DEFAULT_SETTINGS.message,
    color:
      typeof loaded.color === 'string' && COLOR_PATTERN.test(loaded.color)
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
  return useLocalStorageSettings<TipSettings>(STORAGE_KEY, DEFAULT_SETTINGS, sanitize);
}
