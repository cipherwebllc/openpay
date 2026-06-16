'use client';

// モバイルオーダー店舗設定 (受取先 + 店舗 + メニュー) の下書きを LocalStorage 永続化する。
// ノンカストディ / DB なしの思想を維持 (店舗設定は端末ローカル・顧客へは URL に同梱して渡す)。
//
// 編集中の「下書き」型 (MobileOrderDraft) は、URL に載せる検証済み型 (MobileOrderConfig) とは
// 別物にしている:
//   - receiver は生入力 (アドレス/ENS)・URL 生成時に解決して検証する (useHandleProfileDraft と同型)。
//   - メニューの visual は編集時に絵文字↔画像を切替えても両方の入力を保持したいので、
//     discriminated union ではなく flat な {visualKind, emoji, imageUrl} で持つ。
//   - 検証 (空/不正の除外) は **URL 生成時** に draftToConfig → validateOrderConfig で 1 回だけ行い、
//     入力途中の値はそのまま下書きとして保持する (useHandleProfileDraft の socials/links と同思想)。
//
// useLocalStorageSettings の sanitize は useEffect 依存に入るため **モジュールレベル関数**で渡す。

import { useCallback } from 'react';
import type { Address } from 'viem';
import { randomId } from '@/lib/id';
import { isJpycChainSlug, type JpycChainSlug } from '@/lib/chains';
import {
  validateOrderConfig,
  SHOP_NAME_MAX,
  MENU_NAME_MAX,
  MENU_MAX,
  EMOJI_MAX,
  URL_FIELD_MAX,
  type MobileOrderConfig,
  type MobileOrderMode,
  type MenuVisual,
  type MenuItem,
  type ShopSocials,
  type FeePayer,
} from '@/lib/mobileOrder';
import type { ReceiverSource } from './useReceiverAutofill';
import { useLocalStorageSettings } from './useLocalStorageSettings';

export type MenuVisualKind = 'none' | 'emoji' | 'image';

export type MenuDraftItem = {
  id: string;
  name: string;
  /** 人間可読 decimal (JPYC 単位)。入力途中 ("5." 等) も保持し、検証は URL 生成時。 */
  price: string;
  visualKind: MenuVisualKind;
  emoji: string;
  imageUrl: string;
};

export interface MobileOrderDraft {
  receiver: string; // 生入力 (アドレス/ENS)・URL 生成時に解決
  receiverSource: ReceiverSource; // 接続ウォレット追従の可否 (useReceiverAutofill 用)
  chain: JpycChainSlug; // 受取チェーン (JPYC・単一)
  shopName: string;
  mode: MobileOrderMode; // 'storefront' (店頭/券売機) | 'preorder' (事前モバイルオーダー)
  feePayer: FeePayer; // 手数料の負担者 (preorder 時のみ意味を持つ)
  socialX: string; // 公式 X URL (任意)
  socialInstagram: string; // 公式 Instagram URL (任意)
  menu: MenuDraftItem[];
}

const STORAGE_KEY = 'openpay:mobile-order-draft:v1';

// 初期サンプル (店頭メニュー)。ユーザは削除/編集可能・全削除後の再 load では復活しない。
const SEED_MENU: ReadonlyArray<Omit<MenuDraftItem, 'id'>> = [
  { name: 'ブレンドコーヒー', price: '500', visualKind: 'emoji', emoji: '☕', imageUrl: '' },
  { name: 'チーズケーキ', price: '650', visualKind: 'emoji', emoji: '🍰', imageUrl: '' },
];

function seedMenu(): MenuDraftItem[] {
  return SEED_MENU.map((m) => ({ ...m, id: randomId() }));
}

function emptyItem(): MenuDraftItem {
  return { id: randomId(), name: '', price: '', visualKind: 'none', emoji: '', imageUrl: '' };
}

// 下書きは入力途中を尊重するため trim せず length だけ clamp (再 load 時の暴走防止)。
function clampStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

// 価格入力は [\d.] のみ残す (途中の "5." は保持)。正の decimal 検証は draftToConfig 側。
export function sanitizePriceInput(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[^\d.]/g, '').slice(0, 24);
}

function sanitizeMenuItem(raw: unknown): MenuDraftItem | null {
  if (!raw || typeof raw !== 'object') return null; // 壊れた行は drop
  const o = raw as Record<string, unknown>;
  const visualKind: MenuVisualKind =
    o.visualKind === 'emoji' || o.visualKind === 'image' ? o.visualKind : 'none';
  return {
    id: typeof o.id === 'string' && o.id.length > 0 ? o.id : randomId(),
    name: clampStr(o.name, MENU_NAME_MAX),
    price: sanitizePriceInput(o.price),
    visualKind,
    emoji: clampStr(o.emoji, EMOJI_MAX),
    imageUrl: clampStr(o.imageUrl, URL_FIELD_MAX),
  };
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
  menu: seedMenu(),
};

function sanitize(loaded: Partial<MobileOrderDraft>): MobileOrderDraft {
  // menu key の有無で seed 判定: 不在 (初回) のみ seed、存在すれば (空配列でも) 尊重。
  const menu = Array.isArray(loaded.menu)
    ? loaded.menu
        .map(sanitizeMenuItem)
        .filter((m): m is MenuDraftItem => m !== null)
        .slice(0, MENU_MAX)
    : seedMenu();
  return {
    receiver: typeof loaded.receiver === 'string' ? loaded.receiver : '',
    receiverSource: loaded.receiverSource === 'manual' ? 'manual' : 'auto',
    chain:
      typeof loaded.chain === 'string' && isJpycChainSlug(loaded.chain)
        ? loaded.chain
        : 'polygon',
    shopName: clampStr(loaded.shopName, SHOP_NAME_MAX),
    mode: loaded.mode === 'preorder' ? 'preorder' : 'storefront',
    feePayer: loaded.feePayer === 'customer' ? 'customer' : 'merchant',
    socialX: clampStr(loaded.socialX, URL_FIELD_MAX),
    socialInstagram: clampStr(loaded.socialInstagram, URL_FIELD_MAX),
    menu,
  };
}

// 下書きの 1 メニュー行から visual を導く。不正な extras (空絵文字 / 非 https 画像) は
// **行ごと落とさず visual だけ省く** (HandleProfileBuilder が socials/links を落とす思想と同じ)。
function attachVisual(m: MenuDraftItem): MenuVisual | undefined {
  if (m.visualKind === 'emoji') {
    const v = m.emoji.trim();
    return v && v.length <= EMOJI_MAX ? { kind: 'emoji', value: v } : undefined;
  }
  if (m.visualKind === 'image') {
    const u = m.imageUrl.trim();
    return u && u.length <= URL_FIELD_MAX && /^https:\/\/\S+$/i.test(u)
      ? { kind: 'image', url: u }
      : undefined;
  }
  return undefined;
}

/**
 * 下書き + 解決済み受取先 → 検証済み MobileOrderConfig (URL 生成可能なら) or null。
 * 名前/価格が未入力の行は除外 (= 追加直後の空行で URL がブロックされない)。最終検証は
 * validateOrderConfig に委譲 (decode と単一情報源)。価格不正/店名過長など core の不備は null。
 */
export function draftToConfig(
  draft: MobileOrderDraft,
  effectiveReceiver: Address | null,
): MobileOrderConfig | null {
  const socials: ShopSocials = {};
  const x = draft.socialX.trim();
  const ig = draft.socialInstagram.trim();
  if (x) socials.x = x;
  if (ig) socials.instagram = ig;

  const menu = draft.menu
    .filter((m) => m.name.trim() !== '' && m.price.trim() !== '') // 未入力行は除外
    .map((m) => {
      const item: MenuItem = { id: m.id, name: m.name.trim(), price: m.price.trim() };
      const visual = attachVisual(m);
      if (visual) item.visual = visual;
      return item;
    });

  return validateOrderConfig({
    receiver: effectiveReceiver ?? '',
    chain: draft.chain,
    shopName: draft.shopName.trim(),
    mode: draft.mode,
    feePayer: draft.feePayer,
    socials,
    menu,
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

  const addItem = useCallback(() => {
    setSettings((s) =>
      s.menu.length >= MENU_MAX ? s : { ...s, menu: [...s.menu, emptyItem()] },
    );
  }, [setSettings]);

  const updateItem = useCallback(
    (id: string, patch: Partial<Omit<MenuDraftItem, 'id'>>) => {
      setSettings((s) => ({
        ...s,
        menu: s.menu.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      }));
    },
    [setSettings],
  );

  const removeItem = useCallback(
    (id: string) => {
      setSettings((s) => ({ ...s, menu: s.menu.filter((m) => m.id !== id) }));
    },
    [setSettings],
  );

  // 配列順を表示順とし、隣と入れ替える。
  const moveItem = useCallback(
    (id: string, dir: 'up' | 'down') => {
      setSettings((s) => {
        const idx = s.menu.findIndex((m) => m.id === id);
        if (idx === -1) return s;
        const swap = dir === 'up' ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= s.menu.length) return s;
        const next = [...s.menu];
        [next[idx], next[swap]] = [next[swap], next[idx]];
        return { ...s, menu: next };
      });
    },
    [setSettings],
  );

  return {
    settings,
    setSettings,
    hydrated,
    setReceiver,
    addItem,
    updateItem,
    removeItem,
    moveItem,
  };
}
