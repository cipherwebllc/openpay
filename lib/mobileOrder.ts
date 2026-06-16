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
import { isJpycChainSlug, type JpycChainSlug } from './chains';
import { isTaxCategory, type TaxCategory } from './tax';

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
  /** 税率 % (0〜100・任意)。レジ商品 (presets) 由来 → /checkout のレシート小計/うち税額へ。 */
  taxRate?: number;
  /** 税区分 (任意・presets 由来)。 */
  taxCategory?: TaxCategory;
};

export const SOCIALS_MAX = 6; // SNS リンク上限 (@handle と同数)

export type MobileOrderConfig = {
  receiver: Address; // 店舗ウォレット (着金先)・全 EVM チェーン共通
  chain: JpycChainSlug; // 受取チェーン (JPYC のみ・単一)。顧客はこのチェーンで支払う (P2)。
  shopName: string;
  avatar?: string; // 店舗アイコン画像 URL (https のみ・任意・@handle のアバターと同型)
  mode: MobileOrderMode;
  feePayer: FeePayer;
  socials: string[]; // SNS URL 配列 (https のみ・表示順保持・SocialIconLinks がドメイン自動判定)
  menu: MenuItem[];
};

/**
 * モバイルオーダーの「店舗固有部分」(chain/mode/feePayer/menu)。@handle ストアに保存する形。
 * identity (receiver/shopName/avatar/socials) は handle レコードから補完するため持たない
 * (open-pay.jp/@shop = 固定店舗 URL。lib/handle.handleStorefrontConfig が両者を合成する)。
 */
export type StorefrontParts = {
  chain: JpycChainSlug;
  mode: MobileOrderMode;
  feePayer: FeePayer;
  menu: MenuItem[];
};

export const SHOP_NAME_MAX = 48;
export const MENU_NAME_MAX = 80;
export const MENU_MAX = 60;
export const EMOJI_MAX = 8; // JS 文字長 (絵文字は 2+ code unit ゆえ実質 2〜4 絵文字)
export const URL_FIELD_MAX = 512; // SNS / 画像 URL の上限

/** 受取チェーンの表示名 (ブランド名・非翻訳)。builder の選択肢 + 注文ページのバッジで共有。 */
export const JPYC_CHAIN_LABEL: Record<JpycChainSlug, string> = {
  polygon: 'Polygon',
  kaia: 'Kaia',
  avalanche: 'Avalanche',
  ethereum: 'Ethereum',
};

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
  // 税 (任意・accounting メタ)。不正なら黙って無視 (注文自体は壊さない・/checkout 側で再検証)。
  if (typeof o.taxRate === 'number' && Number.isFinite(o.taxRate) && o.taxRate >= 0 && o.taxRate <= 100) {
    item.taxRate = o.taxRate;
  }
  if (isTaxCategory(o.taxCategory)) {
    item.taxCategory = o.taxCategory;
  }
  return item;
}

/** 設定一式を注文ページ URL 用の単一トークンへエンコード (base64url(utf8(JSON)))。 */
export function encodeOrderConfig(config: MobileOrderConfig): string {
  return toBase64Url(JSON.stringify(config));
}

/** 注文ページのルート path (locale prefix 無し・middleware が解決。/pay・/tip と同流儀)。 */
export const ORDER_PATH = '/order';

/**
 * 検証済み設定を注文ページのフル URL へ。token は base64url ([A-Za-z0-9_-]) ゆえ
 * URL 安全なので再エンコード不要。呼出側は valid な config (validateOrderConfig 通過) を渡す。
 */
export function buildOrderUrl(origin: string, config: MobileOrderConfig): string {
  return `${origin}${ORDER_PATH}?s=${encodeOrderConfig(config)}`;
}

/**
 * href / src へ描画してよい URL を返す (不可なら undefined)。**https のみ許可**
 * (validateOrderConfig と同じ scheme 契約)。
 *
 * config は decode/build 時に既に https のみへ検証済みだが、注文トークンは
 * **attacker-controllable** (誰でも /order?s=… を作って送れる) ため、`<a href>` /
 * `<img src>` という XSS sink へ描画する直前にも scheme を再確認する二重防御。
 * `javascript:` / `data:` / `http:` は undefined を返し、呼出側はリンク/画像を描画しない。
 */
export function safeHttpUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
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
  return validateOrderConfig(raw);
}

/**
 * 任意の untrusted な値 (URL 由来 / builder 由来) を MobileOrderConfig へ検証する。
 * 一つでも不正なら null。**decode (URL 取込) と builder (URL 生成前) の単一情報源** —
 * 同じ検証を 2 か所に複製しないため切り出している。
 */
/**
 * untrusted な {chain, mode, feePayer, menu} を検証 (menu は validMenuItem 共有・1..MENU_MAX)。
 * identity を持たない点以外は validateOrderConfig と同じ規則。不正は一つでもあれば null。
 * **validateOrderConfig と @handle storefront の単一情報源** (同じ検証を複製しない)。
 */
export function validateStorefrontParts(raw: unknown): StorefrontParts | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  // chain は JPYC チェーンのみ (flag-gated JPYC_CHAINS のメンバ)。OFF のチェーンは受理しない。
  if (typeof o.chain !== 'string' || !isJpycChainSlug(o.chain)) return null;
  if (o.mode !== 'storefront' && o.mode !== 'preorder') return null;
  if (o.feePayer !== 'merchant' && o.feePayer !== 'customer') return null;
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
  return { chain: o.chain, mode: o.mode, feePayer: o.feePayer, menu };
}

export function validateOrderConfig(raw: unknown): MobileOrderConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.receiver !== 'string' || !isAddress(o.receiver)) return null;
  if (!isNonEmptyStr(o.shopName, SHOP_NAME_MAX)) return null;

  // chain/mode/feePayer/menu は @handle storefront と同一規則 (単一情報源)。
  const parts = validateStorefrontParts(o);
  if (!parts) return null;

  // avatar (任意・https のみ)。不正/空は黙って除外 (注文は壊さない・socials と同じ寛容さ)。
  const avatar = isHttpsUrl(o.avatar) ? o.avatar : undefined;

  // socials (任意・https のみ・≤ SOCIALS_MAX・表示順保持)。不正 URL は黙って除外 (注文は壊さない)。
  const socials = Array.isArray(o.socials)
    ? o.socials.filter((s): s is string => isHttpsUrl(s)).slice(0, SOCIALS_MAX)
    : [];

  const config: MobileOrderConfig = {
    receiver: o.receiver,
    chain: parts.chain,
    shopName: o.shopName,
    mode: parts.mode,
    feePayer: parts.feePayer,
    socials,
    menu: parts.menu,
  };
  if (avatar) config.avatar = avatar; // 任意・有効時のみ載せる (round-trip を最小形に保つ)
  return config;
}
