'use client';

// モバイルオーダー店舗設定 (受取先 + 店舗 + SNS) の下書きを LocalStorage 永続化する。
// **メニューは独立管理しない** — レジの商品プリセット (useProductPresets) を単一カタログとして
// 共有し、draftToConfig が「有効な JPYC presets」をメニューへ変換する。二重入力なし・税率も共有。
// ノンカストディ/DB なしの思想を維持 (店舗設定は端末ローカル・顧客へは URL に同梱して渡す)。
//
// 下書き型 (MobileOrderDraft) は URL に載せる検証済み型 (MobileOrderConfig) とは別:
//   - receiver は生入力 (アドレス/ENS)・URL 生成時に解決して検証 (useHandleProfileDraft と同型)。
//   - 検証 (空/不正除外) は draftToConfig → validateOrderConfig で 1 回だけ (decode と単一情報源)。
//
// useLocalStorageSettings の sanitize は useEffect 依存に入るため **モジュールレベル関数**で渡す。

import { useCallback } from 'react';
import type { Address } from 'viem';
import { isJpycChainSlug, type JpycChainSlug } from '@/lib/chains';
import {
  validateOrderConfig,
  SHOP_NAME_MAX,
  URL_FIELD_MAX,
  type MobileOrderConfig,
  type MobileOrderMode,
  type MenuItem,
  type ShopSocials,
  type FeePayer,
} from '@/lib/mobileOrder';
import type { ProductPreset } from './useProductPresets';
import type { ReceiverSource } from './useReceiverAutofill';
import { useLocalStorageSettings } from './useLocalStorageSettings';

export interface MobileOrderDraft {
  receiver: string; // 生入力 (アドレス/ENS)・URL 生成時に解決
  receiverSource: ReceiverSource; // 接続ウォレット追従の可否 (useReceiverAutofill 用)
  chain: JpycChainSlug; // 受取チェーン (JPYC・単一)
  shopName: string;
  mode: MobileOrderMode; // 'storefront' (店頭/券売機) | 'preorder' (事前モバイルオーダー)
  feePayer: FeePayer; // 手数料の負担者 (preorder 時のみ意味を持つ)
  socialX: string; // 公式 X URL (任意)
  socialInstagram: string; // 公式 Instagram URL (任意)
}

const STORAGE_KEY = 'openpay:mobile-order-draft:v1';

// 下書きは入力途中を尊重するため trim せず length だけ clamp (再 load 時の暴走防止)。
function clampStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

export const DEFAULT_MOBILE_ORDER_DRAFT: MobileOrderDraft = {
  receiver: '',
  receiverSource: 'auto',
  chain: 'polygon', // JPYC の既定チェーン (店主が変更可)
  shopName: '',
  mode: 'storefront', // 最も安全な経路 (その場払いその場受取) を既定に
  feePayer: 'merchant',
  socialX: '',
  socialInstagram: '',
};

// 旧 schema (menu フィールド) は無視される — メニューは presets が単一情報源になったため。
function sanitize(loaded: Partial<MobileOrderDraft>): MobileOrderDraft {
  return {
    receiver: typeof loaded.receiver === 'string' ? loaded.receiver : '',
    receiverSource: loaded.receiverSource === 'manual' ? 'manual' : 'auto',
    chain:
      typeof loaded.chain === 'string' && isJpycChainSlug(loaded.chain) ? loaded.chain : 'polygon',
    shopName: clampStr(loaded.shopName, SHOP_NAME_MAX),
    mode: loaded.mode === 'preorder' ? 'preorder' : 'storefront',
    feePayer: loaded.feePayer === 'customer' ? 'customer' : 'merchant',
    socialX: clampStr(loaded.socialX, URL_FIELD_MAX),
    socialInstagram: clampStr(loaded.socialInstagram, URL_FIELD_MAX),
  };
}

const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

// 1 商品プリセット → メニュー項目。名前/正の価格が無い壊れ preset は null (除外)。
// 画像は https のみ、税率/税区分があれば引き継ぐ (/checkout のレシート小計・うち税額へ)。
function presetToMenuItem(p: ProductPreset): MenuItem | null {
  const name = p.name.trim();
  const price = p.unitPrice.trim();
  if (!name || !POSITIVE_DECIMAL.test(price) || Number(price) <= 0) return null;
  const item: MenuItem = { id: p.id, name, price };
  if (p.image && /^https:\/\/\S+$/i.test(p.image)) {
    item.visual = { kind: 'image', url: p.image };
  }
  if (typeof p.taxRate === 'number' && Number.isFinite(p.taxRate) && p.taxRate >= 0) {
    item.taxRate = p.taxRate;
  }
  if (p.taxCategory) item.taxCategory = p.taxCategory;
  return item;
}

/** 「有効な JPYC 商品プリセット」を MenuItem[] へ (レジ表示順を維持・不正除外)。 */
export function presetsToMenu(presets: ProductPreset[]): MenuItem[] {
  return presets
    .filter((p) => p.enabled && p.token === 'jpyc')
    .map(presetToMenuItem)
    .filter((m): m is MenuItem => m !== null);
}

/**
 * 下書き + 解決済み受取先 + 商品プリセット → 検証済み MobileOrderConfig or null。
 * メニューは **レジの有効な JPYC 商品** から生成 (単一カタログ)。最終検証は validateOrderConfig
 * に委譲 (decode と単一情報源)。受取先/店名/有効商品 が揃わなければ null。
 */
export function draftToConfig(
  draft: MobileOrderDraft,
  effectiveReceiver: Address | null,
  presets: ProductPreset[],
): MobileOrderConfig | null {
  const socials: ShopSocials = {};
  const x = draft.socialX.trim();
  const ig = draft.socialInstagram.trim();
  if (x) socials.x = x;
  if (ig) socials.instagram = ig;

  return validateOrderConfig({
    receiver: effectiveReceiver ?? '',
    chain: draft.chain,
    shopName: draft.shopName.trim(),
    mode: draft.mode,
    feePayer: draft.feePayer,
    socials,
    menu: presetsToMenu(presets),
  });
}

export function useMobileOrderDraft() {
  const { settings, setSettings, hydrated } = useLocalStorageSettings<MobileOrderDraft>(
    STORAGE_KEY,
    DEFAULT_MOBILE_ORDER_DRAFT,
    sanitize,
  );

  // useReceiverAutofill 用: receiver と source をまとめて更新する安定 setter。
  const setReceiver = useCallback(
    (value: string, source: ReceiverSource) =>
      setSettings((s) => ({ ...s, receiver: value, receiverSource: source })),
    [setSettings],
  );

  return { settings, setSettings, hydrated, setReceiver };
}
