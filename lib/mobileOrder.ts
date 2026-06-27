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
import { isJpycChainSlug, JPYC_CHAINS, type JpycChainSlug } from './chains';
import { isTaxCategory, type TaxCategory } from './tax';
import { validOptionGroups, type OptionGroup } from './menuOptions';
import { parseHHMM, sanitizeMinLead } from './shopTime';

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
  /** カテゴリー名 (任意・presets 由来)。公開ページで見出し別にグループ化して表示。 */
  category?: string;
  /** おすすめ (任意・presets 由来)。true のとき公開ページ先頭の「おすすめ」セクションに出す。 */
  recommended?: boolean;
  /** オプション (任意・presets 由来)。サイズ/トッピング。選択で実効単価+名前サフィックス化 (lib/menuOptions)。 */
  options?: OptionGroup[];
};

export const CATEGORY_MAX = 24; // カテゴリー名の上限 (短い分類名を想定)

export const SOCIALS_MAX = 6; // SNS リンク上限 (@handle と同数)

export type MobileOrderConfig = {
  receiver: Address; // 店舗ウォレット (着金先)・全 EVM チェーン共通
  chain: JpycChainSlug; // 既定/単一の受取チェーン。chains 未指定 or 1 件のときはこれを使う。
  // 顧客が選べる受取チェーン集合 (chain を含む)。2 件以上のとき注文ページに選択 UI を出す。
  // 受取先 (receiver) は全 EVM チェーン共通の 1 アドレスなのでチェーンだけ切り替える。
  chains?: JpycChainSlug[];
  shopName: string;
  tagline?: string; // 店名の下に出す短いひとこと (任意・キャッチコピー・表示専用)
  accent?: string; // テーマ色 #rrggbb (@handle の config.color 由来)。注文ページのアクセントに使用。未設定はブランド既定。
  avatar?: string; // 店舗アイコン画像 URL (https のみ・任意・@handle のアバターと同型)
  cover?: string; // 店舗カバー(ヘッダー背景)画像 URL (https のみ・任意・アバターの背後に敷く)
  mode: MobileOrderMode;
  feePayer: FeePayer;
  socials: string[]; // SNS URL 配列 (https のみ・表示順保持・SocialIconLinks がドメイン自動判定)
  menu: MenuItem[];
  // 店舗情報 (任意・表示専用)。住所/営業時間/電話は入力時のみ公開ページに描画。
  address?: string;
  hours?: string;
  phone?: string;
  // 注文受付の可否。false のとき公開ページは支払いを止める (不可逆決済の事故防止)。
  // 既定 (未設定) は受付中。
  acceptingOrders?: boolean;
  // 提供形態。true=店内 (注文時に顧客がテーブル番号を入力)、false/未設定=テイクアウト・店頭受け渡し。
  // **storefront のときのみ有効** — preorder (事前注文) は来店前ゆえテーブル予約不可で常にテイクアウト。
  dineIn?: boolean;
  // 時間系 (Phase 4・flag NEXT_PUBLIC_ENABLE_PREORDER_TIME)。タイムゾーンは Asia/Tokyo 固定。
  lastOrder?: string; // ラストオーダー "HH:mm" (超過で受付停止・同日セマンティクス・lib/shopTime)
  minLeadMinutes?: number; // 最短受け渡しまでの分 (preorder のスロット起点・1..MIN_LEAD_MAX)
};

/**
 * モバイルオーダーの「店舗固有部分」(chain/mode/feePayer/menu)。@handle ストアに保存する形。
 * identity (receiver/shopName/avatar/socials) は handle レコードから補完するため持たない
 * (open-pay.jp/@shop = 固定店舗 URL。lib/handle.handleStorefrontConfig が両者を合成する)。
 */
export type StorefrontParts = {
  chain: JpycChainSlug; // 既定/単一の受取チェーン
  chains?: JpycChainSlug[]; // 顧客が選べる受取チェーン集合 (chain を含む・2 件以上で選択 UI)
  mode: MobileOrderMode;
  feePayer: FeePayer;
  // 店舗のブランディング (ビルダー由来)。公開ページはこれを優先し、無ければ @handle 側の
  // 名前/アバター/SNS にフォールバックする (handleStorefrontConfig)。受取先は @handle が権威。
  shopName?: string;
  tagline?: string; // 店名の下の短いひとこと (任意・表示専用)
  avatar?: string; // https のみ
  cover?: string; // カバー(ヘッダー背景)画像・https のみ
  socials?: string[]; // https のみ・表示順
  menu: MenuItem[];
  // 店舗情報 (任意・公開ページの表示/受付制御。identity ではない)。
  address?: string;
  hours?: string;
  phone?: string;
  acceptingOrders?: boolean;
  dineIn?: boolean; // true=店内 (テーブル番号入力)、false/未設定=テイクアウト。storefront のみ (preorder は常にテイクアウト)
  lastOrder?: string; // ラストオーダー "HH:mm" (Phase 4・Asia/Tokyo・超過で受付停止)
  minLeadMinutes?: number; // 最短受け渡し分 (Phase 4・preorder のスロット起点)
};

export const SHOP_NAME_MAX = 48;
export const TAGLINE_MAX = 60; // 店名下のひとこと (短いキャッチコピーを想定)
export const MENU_NAME_MAX = 80;
export const MENU_MAX = 60;
export const EMOJI_MAX = 8; // JS 文字長 (絵文字は 2+ code unit ゆえ実質 2〜4 絵文字)
export const URL_FIELD_MAX = 512; // SNS / 画像 URL の上限
export const ADDRESS_MAX = 120; // 住所 (建物名込みを許容)
export const HOURS_MAX = 120; // 営業時間 (自由記入・例 "11:00〜22:00 (水曜定休)")
export const PHONE_MAX = 32; // 電話番号 (国番号/内線/区切り込み)

// モバイルオーダーで顧客に提示できる受取チェーン (JPYC・ガスレス可)。Ethereum L1 は標準モード
// (顧客が ETH ガスを負担) で体験が大きく異なるため除外。flag で有効な JPYC チェーンに自動追従
// (本番では Polygon/Kaia + Avalanche)。builder の複数選択肢の単一情報源。
export const MOBILE_ORDER_CHAINS: readonly JpycChainSlug[] = JPYC_CHAINS.filter(
  (c) => c !== 'ethereum',
);

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
  if (isNonEmptyStr(o.category, CATEGORY_MAX)) {
    item.category = o.category.trim();
  }
  // おすすめ (任意)。round-trip 最小化のため true のときだけ保持。
  if (o.recommended === true) item.recommended = true;
  // オプション (任意・untrusted)。不正な group/choice は drop し有効分のみ・全 drop なら付けない。
  const options = validOptionGroups(o.options);
  if (options) item.options = options;
  return item;
}

/**
 * メニューをカテゴリー別にグループ化 (カテゴリーの**出現順**を保持・各グループ内も menu 順)。
 * 未分類 (category 無し) は category:null のグループにまとめる (出現位置に従う)。
 * 公開ページの「カテゴリー見出し + 2 カラム」表示の単一情報源 (純関数・テスト可能)。
 */
export function groupMenuByCategory(
  menu: MenuItem[],
): { category: string | null; items: MenuItem[] }[] {
  const groups: { category: string | null; items: MenuItem[] }[] = [];
  const byKey = new Map<string, { category: string | null; items: MenuItem[] }>();
  for (const item of menu) {
    const cat = item.category ?? null;
    const key = cat === null ? '__none__' : cat; // null と "" 等の衝突を避ける
    let g = byKey.get(key);
    if (!g) {
      g = { category: cat, items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
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
 * 電話番号を `tel:` リンク用に正規化 (数字と先頭 + のみ)。組めない (数字なし) なら undefined。
 * 表示は検証済みの生テキスト、href だけこの正規化値を使う (属性/scheme インジェクション回避)。
 */
export function telHref(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  // 数字と + 以外を除去 → 先頭以外の + も除去 (国番号の先頭 + のみ残す)。
  const norm = phone.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return /\d/.test(norm) ? `tel:${norm}` : undefined;
}

/** 住所を地図検索リンク (Google Maps・https) へ。空なら undefined。 */
export function mapSearchHref(address: string | undefined): string | undefined {
  const a = address?.trim();
  if (!a) return undefined;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
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
  const parts: StorefrontParts = { chain: o.chain, mode: o.mode, feePayer: o.feePayer, menu };
  // 受取チェーン集合 (任意)。有効な JPYC チェーンのみ・重複除去・chain を必ず含める。
  // 2 件以上のときだけ持つ (1 件は単一扱いで chain と同義)。
  if (Array.isArray(o.chains)) {
    const cs: JpycChainSlug[] = [];
    for (const c of o.chains) {
      if (typeof c === 'string' && isJpycChainSlug(c) && !cs.includes(c)) cs.push(c);
    }
    if (!cs.includes(parts.chain)) cs.unshift(parts.chain);
    if (cs.length > 1) parts.chains = cs;
  }
  // 任意のブランディング (不正は黙って除外・注文は壊さない)。avatar/socials は https のみ。
  if (isNonEmptyStr(o.shopName, SHOP_NAME_MAX)) parts.shopName = o.shopName.trim();
  if (isNonEmptyStr(o.tagline, TAGLINE_MAX)) parts.tagline = o.tagline.trim();
  if (isHttpsUrl(o.avatar)) parts.avatar = o.avatar;
  if (isHttpsUrl(o.cover)) parts.cover = o.cover;
  if (Array.isArray(o.socials)) {
    const socials = o.socials.filter((s): s is string => isHttpsUrl(s)).slice(0, SOCIALS_MAX);
    if (socials.length > 0) parts.socials = socials;
  }
  // 店舗情報 (任意・不正は黙って除外・注文は壊さない)。
  if (isNonEmptyStr(o.address, ADDRESS_MAX)) parts.address = o.address.trim();
  if (isNonEmptyStr(o.hours, HOURS_MAX)) parts.hours = o.hours.trim();
  if (isNonEmptyStr(o.phone, PHONE_MAX)) parts.phone = o.phone.trim();
  // 既定 (受付中) は「フィールド無し」で表し、停止時のみ false を保持 (round-trip 最小化)。
  if (o.acceptingOrders === false) parts.acceptingOrders = false;
  // 提供形態: 既定 (テイクアウト) は「フィールド無し」、店内のときのみ true を保持。
  // ただし事前モバイルオーダー (preorder) は来店前注文ゆえテーブル予約が不可能 → 常にテイクアウト。
  // 店内は storefront のときだけ採用する (decode/builder/@handle 公開の単一情報源でこの不変条件を保証)。
  if (o.dineIn === true && parts.mode === 'storefront') parts.dineIn = true;
  // 時間系 (任意・不正は黙って除外・注文は壊さない)。lastOrder は "HH:mm"・minLeadMinutes は 1..上限。
  if (parseHHMM(o.lastOrder) !== null) parts.lastOrder = o.lastOrder as string;
  const minLead = sanitizeMinLead(o.minLeadMinutes);
  if (minLead !== null) parts.minLeadMinutes = minLead;
  return parts;
}

export function validateOrderConfig(raw: unknown): MobileOrderConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.receiver !== 'string' || !isAddress(o.receiver)) return null;
  if (!isNonEmptyStr(o.shopName, SHOP_NAME_MAX)) return null;

  // chain/mode/feePayer/menu は @handle storefront と同一規則 (単一情報源)。
  const parts = validateStorefrontParts(o);
  if (!parts) return null;

  // avatar/cover (任意・https のみ)。不正/空は黙って除外 (注文は壊さない・socials と同じ寛容さ)。
  const avatar = isHttpsUrl(o.avatar) ? o.avatar : undefined;
  const cover = isHttpsUrl(o.cover) ? o.cover : undefined;

  // accent (任意・テーマ色 #rrggbb)。@handle の config.color 由来。不正は黙って除外 (既定色になる)。
  const accent =
    typeof o.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.accent)
      ? o.accent
      : undefined;

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
  if (cover) config.cover = cover; // カバー画像 (任意・https のみ)
  if (accent) config.accent = accent; // テーマ色 (任意・有効 #rrggbb のみ)
  if (parts.tagline) config.tagline = parts.tagline; // 店名下のひとこと (任意)
  if (parts.chains) config.chains = parts.chains; // 受取チェーン集合 (2 件以上のときのみ)
  // 店舗情報は parts (validateStorefrontParts) で検証済み → そのまま載せる (単一情報源)。
  if (parts.address) config.address = parts.address;
  if (parts.hours) config.hours = parts.hours;
  if (parts.phone) config.phone = parts.phone;
  if (parts.acceptingOrders === false) config.acceptingOrders = false;
  if (parts.dineIn) config.dineIn = true;
  // 時間系は parts (validateStorefrontParts) で検証済み → そのまま載せる (単一情報源)。
  if (parts.lastOrder) config.lastOrder = parts.lastOrder;
  if (parts.minLeadMinutes) config.minLeadMinutes = parts.minLeadMinutes;
  return config;
}
