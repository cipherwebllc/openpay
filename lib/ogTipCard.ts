// /tip/[address] の OGP (SNS シェアカード) 用の純粋ヘルパ。
//
// 役割は 2 つ:
//   1. app/api/og/tip/route.tsx — 動的 OG 画像 (1200x630) の描画モデル。
//   2. /tip/[address] の generateMetadata — og:image URL / title / description。
// レンダリング非依存なので単体テスト可能 (route 本体は next/og の ImageResponse を
// 呼ぶだけの薄い層にする)。
//
// 不正/欠落パラメータでも throw せず generic に倒す方針 (SNS に貼った時に画像が
// 壊れた見た目になるのを防ぐ。tip ページの入力検証は parse* が担う)。
//
// 2 系統の tip を扱う:
//   - ERC20 (jpyc/usdc): gasless (ファンはガス不要)。?token= で指定。
//   - native (POL/KAIA): 送り手が自分のガスを払う = gasless ではない。?native= で指定。
// native で「ガス不要」と書くと不正確なので、gasless フラグで文言を分岐する。

import { isAddress } from 'viem';
import { isValidTokenSymbol, type TokenSymbol } from '@/lib/tokens';
import { isJpycChainSlug, type JpycChainSlug } from '@/lib/chains';
import { COLOR_PATTERN } from '@/lib/url';
import { stripControlChars } from '@/lib/sanitize';
import {
  handlePageTheme,
  isHandleTheme,
  type HandleTheme,
} from '@/lib/handleTheme';

export type TipOgLocale = 'ja' | 'en';

// OG カードに描く名前の表示上限。URL 上は TIP_NAME_MAX=60 まで許容するが、1200x630
// に収めるため表示は短く切る (超過は末尾を … に置換)。
const OG_NAME_DISPLAY_MAX = 20;

// creator 色が無効/未指定のときの既定アクセント (emerald)。背景は常に暗色なので
// アクセント (TIP ピル / URL 文字色) としてのみ使い、任意色でも白文字の可読性を保つ。
export const OG_DEFAULT_COLOR = '#10b981';

const TOKEN_LABEL: Record<TokenSymbol, string> = { jpyc: 'JPYC', usdc: 'USDC' };
const NATIVE_LABEL: Record<JpycChainSlug, string> = {
  polygon: 'POL',
  kaia: 'KAIA',
  avalanche: 'AVAX',
  ethereum: 'ETH',
};
const BOTH_TOKENS_LABEL = 'JPYC / USDC';

function normalizeLocale(raw: string | null | undefined): TipOgLocale {
  return raw === 'en' ? 'en' : 'ja';
}

// コードポイント単位の truncate (… 付き)。UTF-16 code unit 単位の slice は絵文字や
// 補助多言語面の漢字 (例: 𠮷田・サロゲートペア) を途中で割り tofu/U+FFFD を生むため、
// [...str] でコードポイント配列にしてから切る。
export function truncateGraphemes(str: string, max: number): string {
  const cps = [...str];
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : str;
}

// 先頭1コードポイント (アバター無し時のイニシャル円用)。サロゲートを割らない。
export function firstGrapheme(str: string): string {
  return [...str][0] ?? '';
}

// 制御文字を除去し、表示上限で truncate (… 付き)。空なら undefined。
function displayName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = stripControlChars(raw).trim();
  if (cleaned.length === 0) return undefined;
  return truncateGraphemes(cleaned, OG_NAME_DISPLAY_MAX);
}

// ?token= の表示ラベル。未指定/不正は両トークン併記に倒す。
export function tokenLabelFor(raw: string | null | undefined): string {
  return raw && isValidTokenSymbol(raw) ? TOKEN_LABEL[raw] : BOTH_TOKENS_LABEL;
}

// native chain (polygon/kaia) のネイティブトークン表示ラベル。
export function nativeLabelFor(chain: JpycChainSlug): string {
  return NATIVE_LABEL[chain];
}

export interface TipOgModel {
  locale: TipOgLocale;
  color: string;
  brand: string;
  heading: string;
  sub: string;
  footer: string;
  url: string;
  theme?: HandleTheme;
}

// route から渡される URLSearchParams (または .get を持つ任意) から描画モデルを作る。
// native (POL/KAIA) は gasless ではないので「ガス不要」を出さない。
export function buildTipOgModel(sp: {
  get(key: string): string | null;
}): TipOgModel {
  const locale = normalizeLocale(sp.get('locale'));
  const to = sp.get('to');
  const tokenRaw = sp.get('token');
  const nativeRaw = sp.get('native');
  const nativeChain =
    nativeRaw != null && isJpycChainSlug(nativeRaw) ? nativeRaw : null;
  const tokenSym =
    tokenRaw != null && isValidTokenSymbol(tokenRaw) ? tokenRaw : null;
  // 有効な tip = 宛先 address + (token か native)。これを満たさない直接アクセス
  // (例: /api/og/tip?name=任意) は name を採らず generic に倒す。public endpoint で
  // 任意文言の OpenPay ブランドカードを生成されるのを防ぐ。
  const valid =
    to != null && isAddress(to) && (nativeChain != null || tokenSym != null);
  const name = valid ? displayName(sp.get('name')) : undefined;
  let tokenLabel = BOTH_TOKENS_LABEL;
  if (valid) {
    if (nativeChain != null) tokenLabel = NATIVE_LABEL[nativeChain];
    else if (tokenSym != null) tokenLabel = TOKEN_LABEL[tokenSym];
  }
  // native (POL/KAIA) は gasless ではない。無効リクエストは generic gasless カード。
  const gasless = !(valid && nativeChain != null);
  const colorRaw = sp.get('color');
  const color =
    colorRaw && COLOR_PATTERN.test(colorRaw) ? colorRaw : OG_DEFAULT_COLOR;
  const ja = locale === 'ja';
  return {
    locale,
    color,
    brand: 'OpenPay',
    heading: name
      ? ja
        ? `${name} さんへ`
        : `Tip ${name}`
      : ja
        ? 'チップを送る'
        : 'Send a tip',
    sub: ja
      ? gasless
        ? `${tokenLabel}で応援 · ガス不要`
        : `${tokenLabel}で応援`
      : gasless
        ? `Support with ${tokenLabel} · no gas`
        : `Support with ${tokenLabel}`,
    footer: ja ? 'ウォレットで直接受け取り' : 'Straight to your wallet',
    url: 'open-pay.jp',
    ...(isHandleTheme(sp.get('theme'))
      ? { theme: sp.get('theme') as HandleTheme }
      : {}),
  };
}

// generateMetadata 用: og:image を指す相対パス (metadataBase で絶対化される)。
// token (ERC20) か native (POL/KAIA) のどちらかを載せる。name は full (≤60) のまま
// 渡し、描画側で truncate。
export function buildTipOgImageUrl(
  address: string,
  params: {
    token?: TokenSymbol;
    native?: JpycChainSlug;
    name?: string;
    color?: string;
    theme?: HandleTheme;
  },
  locale: TipOgLocale,
): string {
  const q = new URLSearchParams();
  q.set('to', address);
  if (params.native) q.set('native', params.native);
  else if (params.token) q.set('token', params.token);
  if (params.name) q.set('name', params.name);
  if (params.color) q.set('color', params.color);
  if (isHandleTheme(params.theme)) q.set('theme', params.theme);
  q.set('locale', locale);
  return `/api/og/tip?${q.toString()}`;
}

// generateMetadata の title/description を組み立てるための正規化済み事実。
export interface TipCardFacts {
  name?: string;
  tokenLabel: string; // 'JPYC' | 'USDC' | 'POL' | 'KAIA'
  gasless: boolean; // ERC20 gasless tip=true、native tip=false
}

// generateMetadata 用: locale 別の title / description。facts=null は generic
// (URL 不正など — ページは案内を出すが meta はブランド汎用に倒す)。native (gasless=false)
// では「ガス不要」を出さない。
export function buildTipMeta(
  facts: TipCardFacts | null,
  locale: TipOgLocale,
): { title: string; description: string } {
  const ja = locale === 'ja';
  const name = facts?.name ? displayName(facts.name) : undefined;
  const tokenLabel = facts ? facts.tokenLabel : BOTH_TOKENS_LABEL;
  const gasless = facts ? facts.gasless : true;
  const noGasJa = gasless ? 'アプリ不要・ガス不要、' : 'アプリ不要、';
  const noGasEn = gasless ? 'No app, no gas — ' : 'No app — ';
  if (name) {
    return ja
      ? {
          title: `${name} さんへチップ — OpenPay`,
          description: `${tokenLabel} で ${name} さんを応援。${noGasJa}ウォレットで直接受け取り。`,
        }
      : {
          title: `Tip ${name} — OpenPay`,
          description: `Support ${name} with ${tokenLabel}. ${noGasEn}straight to their wallet.`,
        };
  }
  return ja
    ? {
        title: 'OpenPay でチップを送る',
        description: `${tokenLabel} でクリエイターを応援。${noGasJa}ウォレットで直接受け取り。`,
      }
    : {
        title: 'Send a tip with OpenPay',
        description: `Support creators with ${tokenLabel}. ${noGasEn}straight to their wallet.`,
      };
}

// ─────────────────────────────────────────────────────────────────────────────
// 共有カード描画モデル (チップ / プロフ共通)。app/api/og/_card.tsx がこの形を描く。
// ─────────────────────────────────────────────────────────────────────────────

// プロフの bio をカードに載せる際の表示上限 (1 行に収める)。
const OG_BIO_DISPLAY_MAX = 48;

/** #rrggbb → rgba() 文字列。カードのアクセント発光/チップ背景に使う (純関数)。 */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  const v = m ? m[1] : OG_DEFAULT_COLOR.slice(1);
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 共有カードの描画モデル。tip / handle 両ルートがこれに正規化してから描く。
export interface OgCardModel {
  accent: string; // #rrggbb (検証済み)
  heading: string; // 名前 or 汎用見出し
  handleLine?: string; // '@alice' (プロフのみ)
  bio?: string; // 1 行 bio (プロフのみ・truncate 済)
  chips: string[]; // 'JPYC で応援' / 'ガス不要' などのピル
  initial: string; // アバター無し時の円内文字 (1 文字 or 短語)
  footer: string;
  url: string; // 'open-pay.jp'
  brand: string; // 'OpenPay'
  themeStyle?: OgCardThemeStyle;
}

export interface OgCardThemeStyle {
  backgroundColor: string;
  backgroundImage: string;
  panelBackgroundColor: string;
  headingColor: string;
  secondaryTextColor: string;
  chipTextColor: string;
  chipBackgroundColor: string;
  brandTextColor: string;
  footerTextColor: string;
  urlTextColor: string;
}

function tipOgThemeStyle(
  accent: string,
  theme: HandleTheme,
): OgCardThemeStyle {
  const page = handlePageTheme(accent, theme);
  const defaultGlow = `radial-gradient(circle at 88% -12%, ${hexToRgba(accent, 0.45)} 0%, rgba(0,0,0,0) 52%), radial-gradient(circle at -8% 112%, ${hexToRgba(accent, 0.25)} 0%, rgba(0,0,0,0) 46%)`;
  switch (theme) {
    case 'gradient':
      return {
        backgroundColor: '#ffffff',
        backgroundImage: page.background,
        panelBackgroundColor: 'rgba(255,255,255,0.92)',
        headingColor: '#0f172a',
        secondaryTextColor: '#475569',
        chipTextColor: accent,
        chipBackgroundColor: hexToRgba(accent, 0.14),
        brandTextColor: '#0f172a',
        footerTextColor: '#475569',
        urlTextColor: accent,
      };
    case 'bold':
      return {
        backgroundColor: accent,
        backgroundImage: `linear-gradient(135deg, ${accent} 0%, #0f172a 145%)`,
        panelBackgroundColor: '#ffffff',
        headingColor: '#0f172a',
        secondaryTextColor: '#334155',
        chipTextColor: accent,
        chipBackgroundColor: hexToRgba(accent, 0.14),
        brandTextColor: '#ffffff',
        footerTextColor: '#e2e8f0',
        urlTextColor: '#ffffff',
      };
    case 'outline':
      return {
        backgroundColor: '#fcfdff',
        backgroundImage: `linear-gradient(135deg, ${hexToRgba(accent, 0.08)}, rgba(255,255,255,0) 65%)`,
        panelBackgroundColor: '#ffffff',
        headingColor: '#0f172a',
        secondaryTextColor: '#475569',
        chipTextColor: accent,
        chipBackgroundColor: hexToRgba(accent, 0.08),
        brandTextColor: accent,
        footerTextColor: '#475569',
        urlTextColor: accent,
      };
    case 'night':
      return {
        backgroundColor: '#0f172a',
        backgroundImage: page.background,
        panelBackgroundColor: 'rgba(15,23,42,0.94)',
        headingColor: '#f8fafc',
        secondaryTextColor: '#cbd5e1',
        chipTextColor: '#93c5fd',
        chipBackgroundColor: 'rgba(255,255,255,0.10)',
        brandTextColor: '#ffffff',
        footerTextColor: '#cbd5e1',
        urlTextColor: '#ffffff',
      };
    case 'soft':
      return {
        backgroundColor: '#eef4fe',
        backgroundImage: `radial-gradient(circle at 90% 0%, ${hexToRgba(accent, 0.18)} 0%, rgba(255,255,255,0) 55%)`,
        panelBackgroundColor: 'rgba(255,255,255,0.94)',
        headingColor: '#1e293b',
        secondaryTextColor: '#5b6b84',
        chipTextColor: accent,
        chipBackgroundColor: hexToRgba(accent, 0.1),
        brandTextColor: '#1e293b',
        footerTextColor: '#5b6b84',
        urlTextColor: accent,
      };
    case 'clean':
    default:
      return {
        backgroundColor: '#0b1220',
        backgroundImage: defaultGlow,
        panelBackgroundColor: 'rgba(255,255,255,0.97)',
        headingColor: '#0f172a',
        secondaryTextColor: '#475569',
        chipTextColor: accent,
        chipBackgroundColor: hexToRgba(accent, 0.14),
        brandTextColor: '#ffffff',
        footerTextColor: '#94a3b8',
        urlTextColor: '#ffffff',
      };
  }
}

/** TipOgModel → 共有カードモデル。チップカードは TIP 円 + 見出し + ピル。 */
export function tipModelToCard(m: TipOgModel): OgCardModel {
  const ja = m.locale === 'ja';
  // sub ('JPYC で応援 · ガス不要') をピルに分解する。
  const chips = m.sub.split(' · ');
  // 見出しから名前の頭文字を採る ('山田太郎 さんへ' / 'Tip Alice')。汎用見出しは 'TIP'。
  const generic = ja ? 'チップを送る' : 'Send a tip';
  const initial =
    m.heading === generic
      ? 'TIP'
      : firstGrapheme(ja ? m.heading : m.heading.replace(/^Tip /, ''));
  return {
    accent: m.color,
    heading: m.heading,
    chips,
    initial,
    footer: m.footer,
    url: m.url,
    brand: m.brand,
    ...(m.theme ? { themeStyle: tipOgThemeStyle(m.color, m.theme) } : {}),
  };
}

// プロフ (@handle) カードの入力 (KV レコード由来・route が解決して渡す)。
export interface HandleOgInput {
  handle: string; // normalize 済み ('alice')
  name?: string;
  color?: string;
  bio?: string;
  tokenLabels: string[]; // methods 由来の表示トークン ['JPYC'] / ['JPYC','USDC']
  locale: TipOgLocale;
}

/** @handle プロフィールカードの描画モデル (純関数・単体テスト対象)。 */
export function buildHandleOgModel(input: HandleOgInput): OgCardModel {
  const ja = input.locale === 'ja';
  const name = displayName(input.name);
  const heading = name ?? `@${input.handle}`;
  const bioClean = input.bio ? stripControlChars(input.bio).trim() : '';
  const bio =
    bioClean.length === 0 ? undefined : truncateGraphemes(bioClean, OG_BIO_DISPLAY_MAX);
  const tokens =
    input.tokenLabels.length > 0 ? input.tokenLabels.join(' / ') : 'JPYC';
  const chips = ja
    ? [`${tokens} で応援`, 'ガス不要']
    : [`Support with ${tokens}`, 'No gas'];
  const color =
    input.color && COLOR_PATTERN.test(input.color)
      ? input.color
      : OG_DEFAULT_COLOR;
  return {
    accent: color,
    heading,
    handleLine: `@${input.handle}`,
    bio,
    chips,
    initial: firstGrapheme(name ?? input.handle).toUpperCase(),
    footer: ja ? 'ウォレットで直接受け取り' : 'Straight to your wallet',
    url: 'open-pay.jp',
    brand: 'OpenPay',
  };
}

/** @handle ページの generateMetadata 用 og:image 相対パス。 */
export function buildHandleOgImageUrl(
  handle: string,
  locale: TipOgLocale,
): string {
  const q = new URLSearchParams();
  q.set('h', handle);
  q.set('locale', locale);
  return `/api/og/handle?${q.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// モバイルオーダー店舗カード (storefront 公開 @handle 用)。
// 店舗ページ (open-pay.jp/@shop) を SNS に貼ったとき、link-in-bio のプロフカードではなく
// 「スマホでメニューを見て JPYC で注文」を訴求する店舗カードを出す。page.tsx の
// generateMetadata と /api/og/handle が storefront 公開時にこちらへ分岐する。
// ─────────────────────────────────────────────────────────────────────────────

export interface StorefrontOgInput {
  handle: string; // normalize 済み ('yamada')
  shopName?: string;
  tagline?: string; // 店名の下のひとこと (任意)
  locale: TipOgLocale;
}

/** storefront 公開 @handle の OG カード描画モデル (純関数・単体テスト対象)。 */
export function buildStorefrontOgModel(input: StorefrontOgInput): OgCardModel {
  const ja = input.locale === 'ja';
  const name = displayName(input.shopName) ?? `@${input.handle}`;
  const tagClean = input.tagline ? stripControlChars(input.tagline).trim() : '';
  const bio =
    tagClean.length === 0 ? undefined : truncateGraphemes(tagClean, OG_BIO_DISPLAY_MAX);
  return {
    accent: OG_DEFAULT_COLOR,
    heading: name,
    handleLine: `@${input.handle}`,
    bio,
    chips: ja
      ? ['スマホで注文', 'JPYC で支払い']
      : ['Order on your phone', 'Pay in JPYC'],
    initial: firstGrapheme(input.shopName ?? input.handle).toUpperCase(),
    footer: ja ? 'メニューを見てそのまま注文' : 'Browse the menu and order',
    url: 'open-pay.jp',
    brand: 'OpenPay',
  };
}

export interface StorefrontMetaFacts {
  handle: string; // normalize 済み ('yamada')。shopName 欠落時の表示フォールバック。
  shopName?: string;
  tagline?: string;
}

/** storefront 公開 @handle の generateMetadata 用 title / description (locale 別)。
 *  shopName 欠落時は OG カード (buildStorefrontOgModel) と同じく @handle へフォールバックし、
 *  カードと meta の見出しを一致させる。 */
export function buildStorefrontMeta(
  facts: StorefrontMetaFacts,
  locale: TipOgLocale,
): { title: string; description: string } {
  const ja = locale === 'ja';
  const name = displayName(facts.shopName) ?? `@${facts.handle}`;
  const tagClean = facts.tagline ? stripControlChars(facts.tagline).trim() : '';
  const tag = tagClean.length > 0 ? truncateGraphemes(tagClean, 60) : '';
  if (ja) {
    const title = `${name} のモバイルオーダー — OpenPay`;
    const base = `${name} はスマホでメニューを見て注文・JPYC で決済できます。`;
    return { title, description: tag ? `${tag}｜${base}` : base };
  }
  const title = `${name} — Mobile Order on OpenPay`;
  const base = `Browse ${name}'s menu and order from your phone, paying in JPYC.`;
  return { title, description: tag ? `${tag} — ${base}` : base };
}
