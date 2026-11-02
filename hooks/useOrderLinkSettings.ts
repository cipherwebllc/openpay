'use client';

import type { ChainSlug } from '@/lib/chains';
import type { PayMode } from '@/lib/fee';
import { isSettledReceiverInput } from '@/lib/format';
import { useLocalStorageSettings, type SettingsSyncRules } from './useLocalStorageSettings';
import { normalizeChainForToken } from './useQrSettings';

// 注文リンクの端末の設定。受取先・チェーン・支払い方法だけを残す
// (商品名・金額・注文番号は注文ごとの値なので保存しない)。
type OrderLinkSettings = {
  receiver: string;
  // 受取先の由来。'auto' = 接続ウォレットからの自動補完 (切替に追従)、'manual' = 手入力。
  receiverSource: 'auto' | 'manual';
  chain: ChainSlug;
  payMode: PayMode;
};

const STORAGE_KEY = 'openpay:order-link-settings:v1';

const DEFAULT_SETTINGS: OrderLinkSettings = {
  receiver: '',
  receiverSource: 'manual',
  chain: 'polygon',
  payMode: 'gasless',
};

function sanitize(loaded: Partial<OrderLinkSettings>): OrderLinkSettings {
  return {
    receiver: typeof loaded.receiver === 'string' ? loaded.receiver : '',
    receiverSource: loaded.receiverSource === 'auto' ? 'auto' : 'manual',
    chain: normalizeChainForToken('jpyc', loaded.chain),
    payMode: loaded.payMode === 'standard' ? 'standard' : 'gasless',
  };
}

const SYNC_RULES: SettingsSyncRules<OrderLinkSettings> = {
  groups: [['receiver', 'receiverSource']],
  importable: { receiver: isSettledReceiverInput },
};

export function useOrderLinkSettings() {
  return useLocalStorageSettings<OrderLinkSettings>(STORAGE_KEY, DEFAULT_SETTINGS, sanitize, SYNC_RULES);
}
