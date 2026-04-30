'use client';

import { isValidChainSlug, type ChainSlug } from '@/lib/chains';
import type { GasMode } from '@/lib/fee';
import { DEFAULT_CHAIN_FOR_SYMBOL, type TokenSymbol } from '@/lib/tokens';
import type { SplitDraft } from '@/lib/url';
import { useLocalStorageSettings } from './useLocalStorageSettings';

type QrSettings = {
  receiver: string;
  token: TokenSymbol;
  // 送金チェーン (slug)。usdc では 4 chain から選択可能、jpyc は polygon 固定。
  chain: ChainSlug;
  // ネットワーク手数料 (gas) の負担者: customer (顧客上乗せ) / merchant (店主吸収)。
  // 運営手数料は両モードとも常に店主負担。既定 customer (gas spike を店主が被らない安全側)。
  gasMode: GasMode;
  // 上級者向け: 顧客がガス代を負担する直接送金モード。
  // false (gasless+1%手数料) を既定にする。
  directTransfer: boolean;
  // 追加受取人 (最大 3、合計 % < 100)。空配列 = 単独受取人 (現行 UX)
  splits: SplitDraft[];
};

const STORAGE_KEY = 'openpay:qr-settings:v2';

const DEFAULT_SETTINGS: QrSettings = {
  receiver: '',
  token: 'jpyc',
  chain: 'polygon',
  gasMode: 'customer',
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

// (token, chain) ペアの妥当性を保つ。jpyc は polygon 固定、usdc は 4 chain 許容。
// 不正な組合せが入った場合は token の default chain に倒す。
export function normalizeChainForToken(
  token: TokenSymbol,
  chain: string | undefined,
): ChainSlug {
  if (token === 'jpyc') return 'polygon';
  if (chain && isValidChainSlug(chain)) return chain;
  return DEFAULT_CHAIN_FOR_SYMBOL[token];
}

export function sanitizeTokenSymbol(
  value: unknown,
  fallback: TokenSymbol,
): TokenSymbol {
  return value === 'jpyc' || value === 'usdc' ? value : fallback;
}

function sanitize(loaded: Partial<QrSettings>): QrSettings {
  const token = sanitizeTokenSymbol(loaded.token, DEFAULT_SETTINGS.token);
  return {
    receiver:
      typeof loaded.receiver === 'string'
        ? loaded.receiver
        : DEFAULT_SETTINGS.receiver,
    token,
    chain: normalizeChainForToken(token, loaded.chain),
    gasMode:
      loaded.gasMode === 'customer' || loaded.gasMode === 'merchant'
        ? loaded.gasMode
        : DEFAULT_SETTINGS.gasMode,
    directTransfer:
      typeof loaded.directTransfer === 'boolean'
        ? loaded.directTransfer
        : DEFAULT_SETTINGS.directTransfer,
    splits: sanitizeSplits(loaded.splits),
  };
}

export function useQrSettings() {
  return useLocalStorageSettings<QrSettings>(STORAGE_KEY, DEFAULT_SETTINGS, sanitize);
}
