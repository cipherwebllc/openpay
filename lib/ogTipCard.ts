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
};
const BOTH_TOKENS_LABEL = 'JPYC / USDC';

function normalizeLocale(raw: string | null | undefined): TipOgLocale {
  return raw === 'en' ? 'en' : 'ja';
}

// 制御文字を除去し、表示上限で truncate (… 付き)。空なら undefined。
function displayName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = stripControlChars(raw).trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > OG_NAME_DISPLAY_MAX
    ? `${cleaned.slice(0, OG_NAME_DISPLAY_MAX)}…`
    : cleaned;
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
  },
  locale: TipOgLocale,
): string {
  const q = new URLSearchParams();
  q.set('to', address);
  if (params.native) q.set('native', params.native);
  else if (params.token) q.set('token', params.token);
  if (params.name) q.set('name', params.name);
  if (params.color) q.set('color', params.color);
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
