'use client';

import { JPYC_CHAINS, type ChainSlug } from '@/lib/chains';
import type { PayMode } from '@/lib/fee';
import { isSettledReceiverInput } from '@/lib/format';
import { ORDER_LINK_ID_MAX, ORDER_LINK_STORE_NAME_MAX, orderLinkChains } from '@/lib/orderLink';
import { SHOP_CONTACT_MAIL_MAX, type ShopContactKind } from '@/lib/shopContact';
import { DECIMAL_PATTERN } from '@/lib/url/shared';
import { useLocalStorageSettings, type SettingsSyncRules } from './useLocalStorageSettings';
import { normalizeChainForToken } from './useQrSettings';

// 注文リンクの端末の設定。1 度決めたら変わらないものと、連番のために最後に使った番号だけを残す
// (商品名・単価・説明は注文ごとの値なので保存しない)。
type OrderLinkSettings = {
  // お客様の画面の頭と控えに出す店名 (空なら出さない)。
  storeName: string;
  receiver: string;
  // 受取先の由来。'auto' = 接続ウォレットからの自動補完 (切替に追従)、'manual' = 手入力。
  receiverSource: 'auto' | 'manual';
  chain: ChainSlug;
  payMode: PayMode;
  // 送料はお店ごとにほぼ同じなので覚える。
  shipping: string;
  // 最後にコピーや共有をした注文の番号。次の番号はここから決める (端末ごと)。
  lastOrderId: string;
  // リンクの種類。'reusable' = 番号なしで何度でも使える (ship=ask)。お店の使い方は大体どちらかに決まるので覚える。
  linkKind: 'single' | 'reusable';
  // 注文の送り先 (お客様の完了画面が開く LINE 公式アカウントかメール)。値は打ったままの文字列で持つ。
  contactKind: 'none' | ShopContactKind;
  contactValue: string;
};

const STORAGE_KEY = 'openpay:order-link-settings:v1';

const DEFAULT_SETTINGS: OrderLinkSettings = {
  storeName: '',
  receiver: '',
  receiverSource: 'manual',
  chain: 'polygon',
  payMode: 'gasless',
  shipping: '',
  lastOrderId: '',
  linkKind: 'single',
  contactKind: 'none',
  contactValue: '',
};

function sanitize(loaded: Partial<OrderLinkSettings>): OrderLinkSettings {
  // 画面の選択肢に無いチェーンを残さない (保存のあとでガスレスが使えなくなったチェーン)。
  const chain = normalizeChainForToken('jpyc', loaded.chain);
  return {
    storeName: typeof loaded.storeName === 'string' ? loaded.storeName.slice(0, ORDER_LINK_STORE_NAME_MAX) : '',
    receiver: typeof loaded.receiver === 'string' ? loaded.receiver : '',
    receiverSource: loaded.receiverSource === 'auto' ? 'auto' : 'manual',
    chain: orderLinkChains(JPYC_CHAINS).includes(chain) ? chain : DEFAULT_SETTINGS.chain,
    payMode: loaded.payMode === 'standard' ? 'standard' : 'gasless',
    shipping: typeof loaded.shipping === 'string' && DECIMAL_PATTERN.test(loaded.shipping) ? loaded.shipping : '',
    lastOrderId:
      typeof loaded.lastOrderId === 'string' ? loaded.lastOrderId.slice(0, ORDER_LINK_ID_MAX) : '',
    linkKind: loaded.linkKind === 'reusable' ? 'reusable' : 'single',
    contactKind: loaded.contactKind === 'line' || loaded.contactKind === 'mail' ? loaded.contactKind : 'none',
    contactValue:
      typeof loaded.contactValue === 'string' ? loaded.contactValue.slice(0, SHOP_CONTACT_MAIL_MAX) : '',
  };
}

const SYNC_RULES: SettingsSyncRules<OrderLinkSettings> = {
  groups: [
    ['receiver', 'receiverSource'],
    ['chain', 'payMode'],
    ['contactKind', 'contactValue'],
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
