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
  TAGLINE_MAX,
  SOCIALS_MAX,
  URL_FIELD_MAX,
  ADDRESS_MAX,
  HOURS_MAX,
  PHONE_MAX,
  MOBILE_ORDER_CHAINS,
  type MobileOrderConfig,
  type MobileOrderMode,
  type MenuItem,
  type FeePayer,
  type StorefrontParts,
} from '@/lib/mobileOrder';
import type { ProductPreset } from './useProductPresets';
import type { ReceiverSource } from './useReceiverAutofill';
import { useLocalStorageSettings } from './useLocalStorageSettings';

export interface MobileOrderDraft {
  receiver: string; // 生入力 (アドレス/ENS)・URL 生成時に解決
  receiverSource: ReceiverSource; // 接続ウォレット追従の可否 (useReceiverAutofill 用)
  chains: JpycChainSlug[]; // 受取チェーン集合 (JPYC・1 件以上)。複数なら注文ページで顧客が選ぶ。
  shopName: string;
  tagline: string; // 店名の下のひとこと (任意・生入力)
  avatar: string; // 店舗アイコン画像 URL (生入力・https 検証は URL 生成時・@handle と同型)
  mode: MobileOrderMode; // 'storefront' (店頭/券売機) | 'preorder' (事前モバイルオーダー)
  feePayer: FeePayer; // 手数料の負担者 (preorder 時のみ意味を持つ)
  socials: string[]; // SNS URL の配列 (生入力・並び替え可・https 検証は URL 生成時)
  address: string; // 住所 (任意・生入力)
  hours: string; // 営業時間 (任意・自由記入)
  phone: string; // 電話番号 (任意・生入力)
  acceptingOrders: boolean; // 注文受付 (既定 true)。false で公開ページの支払いを止める。
  dineIn: boolean; // 提供形態 (既定 false=テイクアウト)。true=店内 (注文時にテーブル番号を入力)。
  // 時間系 (Phase 4・生入力)。検証 (HH:mm / 数値範囲) は draftToConfig→validateOrderConfig が行う。
  lastOrder: string; // ラストオーダー "HH:mm" (空=無制限)
  minLeadMinutes: string; // 最短受け渡し分 (数値文字列・空=即時)
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
  chains: ['polygon'], // JPYC の既定チェーン (店主が複数選択可)
  shopName: '',
  tagline: '',
  avatar: '',
  mode: 'storefront', // 最も安全な経路 (その場払いその場受取) を既定に
  feePayer: 'merchant',
  socials: [],
  address: '',
  hours: '',
  phone: '',
  acceptingOrders: true, // 既定は受付中
  dineIn: false, // 既定はテイクアウト・店頭受け渡し (テーブル番号入力なし)
  lastOrder: '', // 既定は無制限 (ラストオーダーなし)
  minLeadMinutes: '', // 既定は即時 (最短受け渡し指定なし)
};

// 旧 schema (menu フィールド) は無視される — メニューは presets が単一情報源になったため。
function sanitize(loaded: Partial<MobileOrderDraft>): MobileOrderDraft {
  return {
    receiver: typeof loaded.receiver === 'string' ? loaded.receiver : '',
    receiverSource: loaded.receiverSource === 'manual' ? 'manual' : 'auto',
    chains: (() => {
      // 旧 schema (単一 chain) を後方互換で配列化。有効な JPYC チェーンのみ・重複除去・1 件以上。
      const legacyChain = (loaded as { chain?: unknown }).chain;
      const src: unknown[] = Array.isArray(loaded.chains)
        ? loaded.chains
        : typeof legacyChain === 'string'
          ? [legacyChain]
          : [];
      const valid = src.filter(
        (c): c is JpycChainSlug =>
          typeof c === 'string' && isJpycChainSlug(c) && MOBILE_ORDER_CHAINS.includes(c),
      );
      const uniq = [...new Set(valid)];
      return uniq.length > 0 ? uniq : ['polygon'];
    })(),
    shopName: clampStr(loaded.shopName, SHOP_NAME_MAX),
    tagline: clampStr(loaded.tagline, TAGLINE_MAX),
    avatar: clampStr(loaded.avatar, URL_FIELD_MAX), // https 検証は URL 生成時。length だけ clamp。
    mode: loaded.mode === 'preorder' ? 'preorder' : 'storefront',
    feePayer: loaded.feePayer === 'customer' ? 'customer' : 'merchant',
    // SNS は入力途中の値も下書きとして保持 (https 検証は URL 生成時)。length と件数だけ clamp。
    socials: Array.isArray(loaded.socials)
      ? loaded.socials
          .filter((s): s is string => typeof s === 'string')
          .map((s) => clampStr(s, URL_FIELD_MAX))
          .slice(0, SOCIALS_MAX)
      : [],
    address: clampStr(loaded.address, ADDRESS_MAX),
    hours: clampStr(loaded.hours, HOURS_MAX),
    phone: clampStr(loaded.phone, PHONE_MAX),
    // 既定は受付中 (true)。明示的に false のときだけ停止として復元。
    acceptingOrders: loaded.acceptingOrders === false ? false : true,
    // 既定はテイクアウト (false)。明示的に true のときだけ店内 (テーブル番号) として復元。
    dineIn: loaded.dineIn === true,
    // 時間系 (生入力)。length だけ clamp (HH:mm=5・分は最大 4 桁=1440)。検証は draftToConfig。
    lastOrder: clampStr(loaded.lastOrder, 5),
    minLeadMinutes: clampStr(loaded.minLeadMinutes, 4),
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
  // 公開ページのカテゴリー見出し用。trim して揃える (updatePreset は sanitize を通らないため・
  // 「ドリンク」と「ドリンク 」を別グループにしない)。空は付けない。
  if (p.category && p.category.trim()) item.category = p.category.trim();
  // おすすめ (公開ページ先頭の「おすすめ」セクション用)。true のときだけ載せる。
  if (p.recommended) item.recommended = true;
  // オプション (サイズ/トッピング)。最終検証は validateOrderConfig→validMenuItem が行う。
  if (p.options && p.options.length > 0) item.options = p.options;
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
  return validateOrderConfig({
    receiver: effectiveReceiver ?? '',
    // chain = 既定 (先頭)、chains = 顧客が選べる集合 (validateOrderConfig が 2 件以上で採用)。
    chain: draft.chains[0] ?? 'polygon',
    chains: draft.chains,
    shopName: draft.shopName.trim(),
    tagline: draft.tagline.trim(), // 空/length 超過の除外は validateOrderConfig が行う。
    // trim のみ。https 検証 + 空/不正の除外は validateOrderConfig が行う。
    avatar: draft.avatar.trim(),
    mode: draft.mode,
    feePayer: draft.feePayer,
    // trim のみ。https 検証 + 件数 slice は validateOrderConfig が行う。
    socials: draft.socials.map((s) => s.trim()),
    menu: presetsToMenu(presets),
    // 店舗情報 (trim のみ・空/不正の除外は validateOrderConfig)。acceptingOrders は
    // 停止時のみ false として保存される (true は載らない・round-trip 最小化)。
    address: draft.address.trim(),
    hours: draft.hours.trim(),
    phone: draft.phone.trim(),
    acceptingOrders: draft.acceptingOrders,
    // 店内のときだけ true が保存される (validateOrderConfig が round-trip 最小化)。
    dineIn: draft.dineIn,
    // 時間系: lastOrder は "HH:mm" 検証、minLeadMinutes は数値化 (空/不正は undefined=未設定)。
    // 検証/範囲 clamp は validateOrderConfig (parseHHMM / sanitizeMinLead) に委譲。
    lastOrder: draft.lastOrder.trim(),
    minLeadMinutes: draft.minLeadMinutes.trim() ? Number(draft.minLeadMinutes.trim()) : undefined,
  });
}

/**
 * MenuItem[] → ProductPreset[] (presetsToMenu の逆写像)。別端末で公開中の @handle を編集する
 * ため、公開済みメニューを商品カタログ (レジと共有) へ復元する。メニューは「有効な JPYC 商品」
 * だけで構成されるため token は jpyc 固定・enabled=true。memo はメニューに無いので null、画像は
 * image visual のみ復元 (emoji visual は presets が持てないので落ちる)。表示順は配列順で採番。
 */
export function menuToPresets(menu: MenuItem[]): ProductPreset[] {
  return menu.map((m, i) => ({
    id: m.id,
    name: m.name,
    unitPrice: m.price,
    token: 'jpyc',
    taxRate: typeof m.taxRate === 'number' ? m.taxRate : null,
    taxCategory: m.taxCategory ?? null,
    memo: null,
    image: m.visual?.kind === 'image' ? m.visual.url : undefined,
    category: m.category,
    recommended: m.recommended ? true : undefined,
    options: m.options,
    sortOrder: i,
    enabled: true,
  }));
}

/**
 * 公開済み StorefrontParts + 受取先 (= @handle config.to) → 下書き (MobileOrderDraft)。
 * 別端末で公開中の @handle を「読み込んで編集」するための復元写像。受取先は @handle が権威
 * なので manual 固定 (接続ウォレットに追従させない)。メニューは別途 menuToPresets で復元する
 * (本写像は店舗設定のみ)。値は公開時に validateStorefrontParts 済みなので上限内。
 */
export function storefrontPartsToDraft(
  parts: StorefrontParts,
  receiver: string,
): MobileOrderDraft {
  const rawChains =
    parts.chains && parts.chains.length > 0 ? parts.chains : [parts.chain];
  const chains = rawChains.filter((c) => MOBILE_ORDER_CHAINS.includes(c));
  return {
    receiver,
    receiverSource: 'manual',
    chains: chains.length > 0 ? chains : ['polygon'],
    shopName: parts.shopName ?? '',
    tagline: parts.tagline ?? '',
    avatar: parts.avatar ?? '',
    mode: parts.mode,
    feePayer: parts.feePayer,
    socials: parts.socials ?? [],
    address: parts.address ?? '',
    hours: parts.hours ?? '',
    phone: parts.phone ?? '',
    acceptingOrders: parts.acceptingOrders ?? true,
    dineIn: parts.dineIn ?? false,
    lastOrder: parts.lastOrder ?? '',
    minLeadMinutes: parts.minLeadMinutes != null ? String(parts.minLeadMinutes) : '',
  };
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
