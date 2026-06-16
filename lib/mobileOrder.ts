// モバイルオーダーの設定 (店舗メニュー + 店舗設定) の型 + 注文ページ URL コーデック。
//
// 設計 (plans/mobile-order-nostr.md):
// - ノンカストディ/DB なしの思想を維持。店舗設定は LocalStorage に保存し (P1.2)、
//   顧客へは **設定一式を URL に同梱** して渡す (顧客端末には店舗の LocalStorage が無いため)。
// - エンコードは base64url(utf8(JSON))。日本語/絵文字を含むため UTF-8 を経由し、
//   %エンコードより compact (QR 長対策)。decode は **untrusted 入力** として全項目を検証し、
//   不正は throw でなく null を返す (呼び出し側がフォールバック描画する)。
// - 手数料率 (店頭1%/モバイル3%) はここに持たない: 課金の実行は P2 + 開示更新 (P0) ゲート後。
//   本モジュールは P1.1 = 設定/メニュー/URL のみ (本番 inert・money-path 非該当)。

import { isAddress, type Address } from 'viem';

export type MobileOrderMode = 'storefront' | 'preorder'; // 店頭/券売機 | 事前モバイルオーダー
export type FeePayer = 'merchant' | 'customer'; // 3% を店舗負担 | 顧客上乗せ (preorder 時のみ意味を持つ)

export type MenuVisual =
  | { kind: 'emoji'; value: string }
  | { kind: 'image'; url: string };

export type MenuItem = {
  id: string;
  name: string;
  /** 人間可読 decimal (JPYC 単位、例 "500")。 */
  price: string;
  visual?: MenuVisual;
};

export type ShopSocials = { x?: string; instagram?: string };

export type MobileOrderConfig = {
  receiver: Address; // 店舗ウォレット (着金先)
  shopName: string;
  mode: MobileOrderMode;
  feePayer: FeePayer;
  socials: ShopSocials;
  menu: MenuItem[];
};

export const SHOP_NAME_MAX = 48;
export const MENU_NAME_MAX = 80;
export const MENU_MAX = 60;
export const EMOJI_MAX = 8; // JS 文字長 (絵文字は 2+ code unit ゆえ実質 2〜4 絵文字)
export const URL_FIELD_MAX = 512; // SNS / 画像 URL の上限

// ── base64url(utf8) コーデック (browser / jsdom / Node 共通: btoa/atob + TextEncoder) ──
function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64); // 不正な base64 は throw → decodeOrderConfig が catch
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ── 検証ヘルパ (decode は untrusted: すべて型 + 範囲を確認) ──
function isNonEmptyStr(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function isHttpsUrl(v: unknown): v is string {
  return (
    typeof v === 'string' && v.length <= URL_FIELD_MAX && /^https:\/\/\S+$/i.test(v)
  );
}

// 正の decimal (整数部 1-12 桁、小数部 0-18 桁・JPYC は 18 decimals)。
function isPositiveDecimal(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{1,12}(\.\d{1,18})?$/.test(v)) return false;
  return Number(v) > 0;
}

function validVisual(v: unknown): MenuVisual | undefined | null {
  if (v == null) return undefined; // 任意
  if (typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'emoji') {
    return isNonEmptyStr(o.value, EMOJI_MAX) ? { kind: 'emoji', value: o.value } : null;
  }
  if (o.kind === 'image') {
    return isHttpsUrl(o.url) ? { kind: 'image', url: o.url } : null;
  }
  return null;
}

function validMenuItem(v: unknown): MenuItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyStr(o.id, 64)) return null;
  if (!isNonEmptyStr(o.name, MENU_NAME_MAX)) return null;
  if (!isPositiveDecimal(o.price)) return null;
  const visual = validVisual(o.visual);
  if (visual === null) return null; // 指定されたが不正
  const item: MenuItem = { id: o.id, name: o.name, price: o.price };
  if (visual) item.visual = visual;
  return item;
}

/** 設定一式を注文ページ URL 用の単一トークンへエンコード (base64url(utf8(JSON)))。 */
export function encodeOrderConfig(config: MobileOrderConfig): string {
  return toBase64Url(JSON.stringify(config));
}

/**
 * 注文ページ URL のトークンを検証付きでデコード。untrusted 入力ゆえ全項目を検証し、
 * 一つでも不正なら **null** を返す (例外は投げない)。
 */
export function decodeOrderConfig(token: string): MobileOrderConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(token));
  } catch {
    return null; // 不正な base64 / JSON
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.receiver !== 'string' || !isAddress(o.receiver)) return null;
  if (!isNonEmptyStr(o.shopName, SHOP_NAME_MAX)) return null;
  if (o.mode !== 'storefront' && o.mode !== 'preorder') return null;
  if (o.feePayer !== 'merchant' && o.feePayer !== 'customer') return null;

  // socials (任意・あれば https のみ)
  const socials: ShopSocials = {};
  const rawSocials =
    o.socials && typeof o.socials === 'object'
      ? (o.socials as Record<string, unknown>)
      : {};
  if (rawSocials.x != null) {
    if (!isHttpsUrl(rawSocials.x)) return null;
    socials.x = rawSocials.x;
  }
  if (rawSocials.instagram != null) {
    if (!isHttpsUrl(rawSocials.instagram)) return null;
    socials.instagram = rawSocials.instagram;
  }

  // menu (1..MENU_MAX・各項目検証)
  if (!Array.isArray(o.menu) || o.menu.length < 1 || o.menu.length > MENU_MAX) {
    return null;
  }
  const menu: MenuItem[] = [];
  for (const m of o.menu) {
    const item = validMenuItem(m);
    if (!item) return null;
    menu.push(item);
  }

  return {
    receiver: o.receiver,
    shopName: o.shopName,
    mode: o.mode,
    feePayer: o.feePayer,
    socials,
    menu,
  };
}
