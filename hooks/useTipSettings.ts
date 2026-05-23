'use client';

import type { ChainSlug } from '@/lib/chains';
import { deploymentForSlug, isGaslessSupported, type TokenSymbol } from '@/lib/tokens';
import { COLOR_PATTERN } from '@/lib/url';
import { useLocalStorageSettings } from './useLocalStorageSettings';
import { normalizeChainForToken, sanitizeTokenSymbol } from './useQrSettings';

type TipSettings = {
  receiver: string;
  token: TokenSymbol;
  // 送金チェーン (slug)。usdc は gasless 対応 chain 選択可 (Ethereum L1 は tip 不可)、
  // jpyc は polygon 固定。
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
  const token = sanitizeTokenSymbol(loaded.token, DEFAULT_SETTINGS.token);
  // tip widget は gasless 必須。USDC + Ethereum L1 のような gasless 非対応 chain は
  // sanitize 段階で token の default chain (usdc → base) にフォールバック。
  // localStorage に旧 'ethereum' が残っていても安全に切り替わる。
  const normalized = normalizeChainForToken(token, loaded.chain);
  const chain = isGaslessSupported(deploymentForSlug(token, normalized))
    ? normalized
    : normalizeChainForToken(token, undefined);
  return {
    receiver:
      typeof loaded.receiver === 'string'
        ? loaded.receiver
        : DEFAULT_SETTINGS.receiver,
    token,
    chain,
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
