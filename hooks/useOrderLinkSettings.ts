'use client';

import { JPYC_CHAINS, type ChainSlug } from '@/lib/chains';
import type { PayMode } from '@/lib/fee';
import { isSettledReceiverInput } from '@/lib/format';
import { orderLinkChains } from '@/lib/orderLink';
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
  // 画面の選択肢に無いチェーンを残さない (保存のあとでガスレスが使えなくなったチェーン)。
  const chain = normalizeChainForToken('jpyc', loaded.chain);
  return {
    receiver: typeof loaded.receiver === 'string' ? loaded.receiver : '',
    receiverSource: loaded.receiverSource === 'auto' ? 'auto' : 'manual',
    chain: orderLinkChains(JPYC_CHAINS).includes(chain) ? chain : DEFAULT_SETTINGS.chain,
    payMode: loaded.payMode === 'standard' ? 'standard' : 'gasless',
  };
}

const SYNC_RULES: SettingsSyncRules<OrderLinkSettings> = {
  groups: [
    ['receiver', 'receiverSource'],
    ['chain', 'payMode'],
  ],
  importable: { receiver: isSettledReceiverInput },
};

// holdImport: 注文を入力している間は別のタブの設定を取り込まない。取り込むと、注文の内容はそのままで
// リンクの受取先だけが変わる。
export function useOrderLinkSettings(options: { holdImport?: boolean } = {}) {
  return useLocalStorageSettings<OrderLinkSettings>(
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    sanitize,
    SYNC_RULES,
    options.holdImport ?? false,
  );
}
