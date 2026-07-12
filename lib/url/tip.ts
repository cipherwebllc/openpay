// /tip/[address] クエリ仕様:
//   token   ("jpyc" | "usdc")        必須
//   chain   ChainSlug (任意、規則は /pay と同じ)
//   name    (任意, 表示名 60 文字まで切詰)
//   message (任意, 説明文 200 文字まで切詰)
//   color   (任意, "#rrggbb" 形式)
//   preset  (任意, "100|☕ コーヒー1杯,500,1000|🍰 ケーキ" カンマ区切り、最大 6 件)
//
// Tip widget は gas=customer 固定 (preset セマンティクス: クリエイターが preset 額から運営手数料控除後を受け取る、ファンが gas を上乗せ支払い)。
import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';
import { removeControlChars } from '../sanitize';
import { isHandleTheme, type HandleTheme } from '../handleThemeKey';
import {
  isJpycChainSlug,
  type ChainSlug,
  type JpycChainSlug,
} from '../chains';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  deploymentForSlug,
  isGaslessSupported,
  isValidTokenSymbol,
  symbolHasDeployment,
  type TokenSymbol,
} from '../tokens';
import {
  DECIMAL_PATTERN,
  resolveChainSlugParam,
  sanitizeText,
  sanitizeUrl,
  type SearchParamsLike,
} from './shared';

// ---------------------------------------------------------------------------
// /tip/[address] helpers
// ---------------------------------------------------------------------------

export type TipParams = {
  to: Address;
  token: TokenSymbol;
  // chain slug (PayParams と同じ規則)。省略時は token の default。
  chain?: ChainSlug;
  name?: string;
  message?: string;
  color?: string;
  theme?: HandleTheme;
  presets?: string[];
  // 送信成功時に表示するサンキューメッセージ (200 文字まで)
  thanks?: string;
  // 送信成功時に表示するリンク URL (例: 限定 Discord 招待 / Patreon ページ)
  thanksUrl?: string;
  // 送信成功時に POST する webhook URL
  webhook?: string;
  // cross-chain 受信を許可するかの flag (Circle Gateway / CCTP V2 経由)。
  // default true (creator 側で許可、fan が target chain 以外で USDC を持っている
  // 時に TipForm が代替 path を提示する)。false 時のみ URL に `crossChain=false`
  // として出力 (default URL は不変、既存 embed snippet との互換性維持)。
  // USDC のみ意味があり、JPYC では TipForm が無視する。
  crossChain?: boolean;
};

const TIP_NAME_MAX = 60;
const TIP_MESSAGE_MAX = 200;
const TIP_THANKS_MAX = 200;
// preset の最大件数。URL builder/parser と generator UI / settings hook の
// 単一 source of truth (重複定義を避ける)。
export const TIP_PRESET_MAX = 6;
// preset ラベルは Unicode コードポイント単位で最大 12 文字。絵文字の surrogate pair を
// 途中で切らず、URL builder/parser と generator settings が同じ上限を参照する。
export const TIP_PRESET_LABEL_MAX = 12;
// qrcode.react が長い URL で throw しないための Tip 共有 QR 上限。generator と URL 長
// フェンステストで共有し、ラベル追加後もガード内に収まることを固定する。
export const QR_MAX_URL_LEN = 1200;
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export type ParsedTipPreset = {
  amount: string;
  label?: string;
};

export function sanitizeTipPresetLabel(
  raw: string,
  options: { trim?: boolean } = {},
): string | undefined {
  // `|` は構文 delimiter のためラベル本文から除去。sanitizeText と同じ制御文字除去・trim
  // を通した後、要件どおり UTF-16 code unit ではなく Unicode code point で切り詰める。
  const withoutDelimiter = raw.replace(/\|/g, '');
  const cleaned =
    options.trim === false
      ? removeControlChars(withoutDelimiter)
      : sanitizeText(withoutDelimiter, withoutDelimiter.length);
  if (!cleaned) return undefined;
  return [...cleaned].slice(0, TIP_PRESET_LABEL_MAX).join('') || undefined;
}

// preset 要素の唯一の構文パーサ。`金額` と additive な `金額|ラベル` を同じ入口で
// 正規化し、TipForm / URL builder / URL parser の解釈ずれを防ぐ。
export function parseTipPreset(
  raw: string,
  options: { trimAmount?: boolean } = {},
): ParsedTipPreset | undefined {
  const separator = raw.indexOf('|');
  const amountRaw = separator === -1 ? raw : raw.slice(0, separator);
  // URL parser は従来どおり前後空白を許容する。builder は trimAmount=false を渡し、
  // 旧 builder が空白付き金額を reject していた挙動を維持する。
  const amount = options.trimAmount === false ? amountRaw : amountRaw.trim();
  if (!DECIMAL_PATTERN.test(amount) || Number(amount) <= 0) return undefined;
  const label =
    separator === -1
      ? undefined
      : sanitizeTipPresetLabel(raw.slice(separator + 1));
  return label ? { amount, label } : { amount };
}

export function formatTipPreset(preset: ParsedTipPreset): string {
  return preset.label ? `${preset.amount}|${preset.label}` : preset.amount;
}

function normalizePresets(
  values: readonly string[],
  options: { trimAmount?: boolean } = {},
): string[] | undefined {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const parsed = parseTipPreset(value, options);
    if (!parsed || seen.has(parsed.amount)) continue;
    seen.add(parsed.amount);
    normalized.push(formatTipPreset(parsed));
    if (normalized.length >= TIP_PRESET_MAX) break;
  }
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizePresets(raw: string): string[] | undefined {
  // カンマ区切り。空白を許容、不正トークンは捨て、上限件数で切る。
  return normalizePresets(raw.split(','));
}

export function buildTipPath(params: TipParams): string {
  const sp = new URLSearchParams();
  sp.set('token', params.token);
  if (params.chain && params.chain !== DEFAULT_CHAIN_FOR_SYMBOL[params.token]) {
    sp.set('chain', params.chain);
  }
  if (params.name) {
    const v = sanitizeText(params.name, TIP_NAME_MAX);
    if (v) sp.set('name', v);
  }
  if (params.message) {
    const v = sanitizeText(params.message, TIP_MESSAGE_MAX);
    if (v) sp.set('message', v);
  }
  if (params.color && COLOR_PATTERN.test(params.color)) {
    sp.set('color', params.color.toLowerCase());
  }
  // clean は「テーマ無し=従来描画と完全一致」(lib/handleTheme 設計原則) のため URL には
  // 載せない = 生成 URL を正準・最短に保ち、テーマ導入前の URL と同一形を維持する。
  if (isHandleTheme(params.theme) && params.theme !== 'clean') {
    sp.set('theme', params.theme);
  }
  if (params.presets && params.presets.length > 0) {
    const valid = normalizePresets(params.presets, { trimAmount: false });
    if (valid) sp.set('preset', valid.join(','));
  }
  if (params.thanks) {
    const v = sanitizeText(params.thanks, TIP_THANKS_MAX);
    if (v) sp.set('thanks', v);
  }
  if (params.thanksUrl) {
    const v = sanitizeUrl(params.thanksUrl);
    if (v) sp.set('thanksUrl', v);
  }
  if (params.webhook) {
    const v = sanitizeUrl(params.webhook);
    if (v) sp.set('webhook', v);
  }
  // PayParams と同型: default (undefined / true) は URL に出さず旧 embed と互換、
  // false (= creator が cross-chain 拒否) を明示するときだけ出力。
  if (params.crossChain === false) {
    sp.set('crossChain', 'false');
  }
  return `/tip/${params.to}?${sp.toString()}`;
}

export function buildTipUrl(origin: string, params: TipParams): string {
  return `${origin}${buildTipPath(params)}`;
}

export type ParsedTipParams =
  | { ok: true; params: TipParams }
  | { ok: false; error: string };

export function parseTipParams(
  addressParam: string,
  searchParams: SearchParamsLike,
): ParsedTipParams {
  if (!addressParam) {
    return { ok: false, error: '宛先アドレスが指定されていません' };
  }
  if (!isAddress(addressParam)) {
    return { ok: false, error: '宛先アドレスが不正です' };
  }
  const token = searchParams.get('token');
  if (!token || !isValidTokenSymbol(token)) {
    return { ok: false, error: 'token は jpyc または usdc を指定してください' };
  }
  const chainRaw = searchParams.get('chain');
  const chainResult = resolveChainSlugParam(chainRaw, token);
  if (!chainResult.ok) {
    return { ok: false, error: chainResult.error };
  }
  const chainSlug = chainResult.slug;
  if (!symbolHasDeployment(token, chainSlug)) {
    return {
      ok: false,
      error: `${token} は ${chainSlug} に対応していません`,
    };
  }
  // Tip widget は gas=customer 固定 (常に gasless) なので、(token, chain) が
  // gasless 非対応なら tip 自体が成立しない → reject。例: buyer-only chain の USDC。
  if (!isGaslessSupported(deploymentForSlug(token, chainSlug))) {
    return {
      ok: false,
      error: `${token} on ${chainSlug} は tip widget 非対応です (gasless mode 必須のため)`,
    };
  }

  const name = searchParams.get('name');
  const message = searchParams.get('message');
  const color = searchParams.get('color');
  const theme = searchParams.get('theme');
  const preset = searchParams.get('preset');
  const thanks = searchParams.get('thanks');
  const thanksUrl = searchParams.get('thanksUrl');
  const webhook = searchParams.get('webhook');
  const crossChainRaw = searchParams.get('crossChain');

  const sanitizedColor =
    color && COLOR_PATTERN.test(color) ? color.toLowerCase() : undefined;

  // PayParams と同仕様: 明示的 "false" のみ false、それ以外 (未指定 / "true" /
  // 不明値) は default の true として扱う。既存 embed snippet は影響なし。
  const crossChain: boolean = crossChainRaw !== 'false';

  return {
    ok: true,
    params: {
      to: getAddress(addressParam),
      token,
      chain: chainSlug,
      name: name ? sanitizeText(name, TIP_NAME_MAX) : undefined,
      message: message ? sanitizeText(message, TIP_MESSAGE_MAX) : undefined,
      color: sanitizedColor,
      ...(isHandleTheme(theme) ? { theme } : {}),
      presets: preset ? sanitizePresets(preset) : undefined,
      thanks: thanks ? sanitizeText(thanks, TIP_THANKS_MAX) : undefined,
      thanksUrl: thanksUrl ? sanitizeUrl(thanksUrl) : undefined,
      webhook: webhook ? sanitizeUrl(webhook) : undefined,
      crossChain,
    },
  };
}

// ---------------------------------------------------------------------------
// /tip native (POL / KAIA) — ネイティブトークンの応援 (Tip)
// ---------------------------------------------------------------------------
//
// ERC20 (jpyc/usdc) の TipForm とは別系統。ネイティブ送金は approval / relay /
// gasless が無く、送り手が自分のガス (POL/KAIA) を払うだけで OpenPay は徴収も
// 負担もしない。`TokenSymbol` に pol/kaia を足すと deployment/fee 全体へ波及する
// ため、native は token とは独立した別パラメタとして扱う。
//
// URL: /tip/{address}?native=polygon|kaia (&name &message &color &preset)
//   native = チェーン slug (polygon=POL / kaia=KAIA)。native があれば NativeTipForm を
//            描画し、token パラメタは無視する (tip page で分岐)。
export type NativeTipParams = {
  to: Address;
  // ネイティブ POL / KAIA を持つ chain (= JpycChainSlug: polygon | kaia)。
  chain: JpycChainSlug;
  name?: string;
  message?: string;
  color?: string;
  presets?: string[];
};

export type ParsedNativeTipParams =
  | { ok: true; params: NativeTipParams }
  | { ok: false; error: string };

export function parseNativeTipParams(
  addressParam: string,
  searchParams: SearchParamsLike,
): ParsedNativeTipParams {
  if (!addressParam || !isAddress(addressParam)) {
    return { ok: false, error: '宛先アドレスが不正です' };
  }
  const native = searchParams.get('native');
  if (!native || !isJpycChainSlug(native)) {
    return {
      ok: false,
      error: 'native は polygon または kaia を指定してください',
    };
  }
  const name = searchParams.get('name');
  const message = searchParams.get('message');
  const color = searchParams.get('color');
  const preset = searchParams.get('preset');
  const nativePresets = preset
    ? sanitizePresets(preset)?.map((entry) => parseTipPreset(entry)!.amount)
    : undefined;
  const sanitizedColor =
    color && COLOR_PATTERN.test(color) ? color.toLowerCase() : undefined;
  return {
    ok: true,
    params: {
      to: getAddress(addressParam),
      chain: native,
      name: name ? sanitizeText(name, TIP_NAME_MAX) : undefined,
      message: message ? sanitizeText(message, TIP_MESSAGE_MAX) : undefined,
      color: sanitizedColor,
      // ラベル UI は ERC20 TipForm 専用。native は従来の金額配列へ明示的に落とす。
      presets: nativePresets,
    },
  };
}

// 通貨ごとの既定 preset (URL に preset 指定がない時に使う)。
// tip 文脈で違和感のない常用額レンジを起点に置く。クリエイターは
// TipEmbedGenerator で任意の preset を上書き可能、ファンも custom amount で
// 100 JPYC / 1 USDC のようなカジュアル tip を送れる。
export const DEFAULT_TIP_PRESETS: Record<TokenSymbol, string[]> = {
  jpyc: ['300', '1000', '3000'],
  usdc: ['5', '20', '50'],
};
