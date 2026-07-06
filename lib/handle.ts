// @handle 恒久クリエイターリンク (open-pay.jp/@alice) の純関数。
//
// handle の正規化・形式検証・予約語判定と、保存設定 (PublishableTipConfig) ↔ TipParams /
// tip クエリの相互変換を集約する。KV / SIWE には依存しない (= 単体テスト可能)。サーバ側の
// KV 操作は lib/handleStore.ts、API は app/api/handle/*、解決ページは [locale]/[handle]。
//
// セキュリティ前提:
//   - handle は ASCII 小文字英数字 + `_` のみ (homograph / IDN を排除)。
//   - 設定の意味的妥当性は既存の parseTipParams を再利用して担保 (token/chain/gasless 整合)。
//   - 予約語 = 既存ルート名 + locale + ブランド系 (成りすまし/混同の一次防御)。

import { type Address } from 'viem';
import {
  TOKEN_SYMBOLS,
  DEFAULT_CHAIN_FOR_SYMBOL,
  type TokenSymbol,
} from '@/lib/tokens';
import type { ChainSlug } from '@/lib/chains';
import { buildTipPath, parseTipParams, type TipParams } from '@/lib/url';
import {
  validateStorefrontParts,
  validateOrderConfig,
  type StorefrontParts,
  type MobileOrderConfig,
} from '@/lib/mobileOrder';

// 1 wallet が保有できる handle の上限 (squatting 抑制・D2)。
export const MAX_HANDLES_PER_WALLET = 3;

// @handle プロフィール (link-in-bio) の上限。乱用・肥大化抑制。
export const MAX_PROFILE_LINKS = 6;
export const MAX_BIO_LEN = 160;
export const MAX_LINK_LABEL_LEN = 40;
export const MAX_LINK_URL_LEN = 512;
export const MAX_AVATAR_URL_LEN = 512;
// SNS アイコンリンク (URL のみ保存・アイコンは lib/socialLinks がドメイン判定) の上限。
export const MAX_SOCIAL_LINKS = 6;
// 1 handle が公開できる受取方法の上限 (token 2 × chain 数の現実的な上限)。
export const MAX_RECEIVE_METHODS = 6;

// 形式: ASCII 小文字英数字 + アンダースコア、3〜30 文字。
export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;

// 予約語: 既存ルート名 + locale + ブランド/紛らわしい語。handle namespace は `@` 接頭辞で
// static route と分離されるため衝突防止というより成りすまし/混同の一次防御。
export const RESERVED_HANDLES: ReadonlySet<string> = new Set<string>([
  // 既存ルート / 特殊パス (全 top-level route 名を網羅 = handle が route を shadow しない)
  'api', 'og', '_next', 'admin', 'billing', 'checkout', 'create',
  'disclaimer', 'discovery', 'experimental', 'explore', 'guide', 'history',
  'kit', 'news', 'order', 'orders', 'pay', 'privacy', 'scan', 'terms', 'tip',
  'tokutei',
  // locale
  'ja', 'en',
  // ブランド / 役割 (成りすまし防止)
  'openpay', 'open_pay', 'official', 'support', 'help', 'admin_',
  'moderator', 'mod', 'staff', 'team', 'root', 'system', 'security',
  'jpyc', 'usdc', 'wallet', 'account', 'login', 'logout', 'signin',
  'signout', 'settings', 'dashboard', 'about', 'contact', 'home', 'www',
  'app',
]);

// URL のパスセグメントは `@` が `%40` にエンコードされて届くことがある (Next.js は
// dynamic route param を自動デコードしない)。`@` 接頭辞の判定や normalize の前に一度だけ
// 安全にデコードする。不正な `%` シーケンスは decode せず raw を返す (どのみち後段の
// `@`/形式チェックで弾かれる)。冪等: `@alice` / `alice` はそのまま返る。
export function decodeHandleSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// 先頭 `@` を除去し小文字化・trim。URL segment ('@alice') / 入力どちらも受ける。
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export function isValidHandleFormat(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

export function isReserved(handle: string): boolean {
  return RESERVED_HANDLES.has(handle);
}

export type HandleValidation =
  | { ok: true; handle: string }
  | { ok: false; reason: 'format' | 'reserved' };

// 正規化 + 形式 + 予約語をまとめて判定。API / availability / dashboard が共有する。
export function validateHandle(raw: string): HandleValidation {
  const handle = normalizeHandle(raw);
  if (!isValidHandleFormat(handle)) return { ok: false, reason: 'format' };
  if (isReserved(handle)) return { ok: false, reason: 'reserved' };
  return { ok: true, handle };
}

// 保存するチップ設定 (TipParams の JSON 化シェイプ。to は serializable な string)。
export interface PublishableTipConfig {
  to: string;
  token: TokenSymbol;
  chain?: ChainSlug;
  name?: string;
  message?: string;
  color?: string;
  presets?: string[];
  thanks?: string;
  thanksUrl?: string;
  webhook?: string;
  crossChain?: boolean;
}

// @handle が公開する1つの受取方法 (支払者が選ぶ)。全方法は同一受取アドレス (config.to)
// に着金する。JPYC は Polygon/Kaia に同アドレスで存在、USDC cross-chain も同アドレス宛。
export interface HandleReceiveMethod {
  token: TokenSymbol;
  chain: ChainSlug;
  // USDC のみ意味あり (cross-chain 受取の許可)。JPYC では無視。
  crossChain?: boolean;
}

// link-in-bio の外部リンク。url は https のみ (javascript:/data:/http: を排除)。
export interface HandleLink {
  label: string;
  url: string;
}

// @handle プロフィール (link-in-bio)。tip パラメータではないので config の sibling。
export interface HandleProfile {
  bio?: string;
  avatar?: string; // https URL (ホスティングはしない)
  // SNS プロフィール URL (https のみ)。アイコンは表示側がドメインから自動判定
  // (lib/socialLinks)。platform は保存しない (判定更新で既存データも追従)。
  socials?: string[];
  links?: HandleLink[];
}

// @handle 専用の保存 tip 設定。PublishableTipConfig (単一 token+chain) を
// 「共有受取アドレス + 受取方法の集合」へ一般化したもの。presets は token 別。
export interface HandleTipConfig {
  to: string;
  name?: string;
  message?: string;
  color?: string;
  thanks?: string;
  thanksUrl?: string;
  webhook?: string;
  methods: HandleReceiveMethod[]; // 1..N
  presets?: Partial<Record<TokenSymbol, string[]>>;
}

// 既定の受取方法 (ユーザ決定): JPYC Polygon / JPYC Kaia。
// USDC (cross-chain) はビルダーから提供終了 (着金チェーンを選べず Base 固定になるため)。
// 必要ならチップタブで個別に作成しリンク集へ追加する運用。既存レコードの usdc method は
// 検証/公開ページとも後方互換で受け続ける (ビルダーで更新すると外れる)。
export const DEFAULT_RECEIVE_METHODS: readonly HandleReceiveMethod[] = [
  { token: 'jpyc', chain: 'polygon' },
  { token: 'jpyc', chain: 'kaia' },
] as const;

export interface HandleRecord {
  owner: string; // 所有 wallet (checksum address)
  config: HandleTipConfig;
  profile?: HandleProfile;
  // モバイルオーダー店舗 (open-pay.jp/@shop = 固定店舗 URL)。店舗固有部分 (menu/chain/mode) のみ
  // 保存し、identity (受取先/店名/アイコン/SNS) は config/profile から合成 (handleStorefrontConfig)。
  storefront?: StorefrontParts;
  createdAt: number;
  updatedAt: number;
}

/**
 * handle レコード + 保存済み storefront → 顧客向け MobileOrderConfig (無ければ null)。
 * identity は handle 由来: receiver=config.to / shopName=config.name||@handle /
 * avatar=profile.avatar / socials=profile.socials。最終検証は validateOrderConfig に委譲
 * (storefront と公開ページの単一情報源)。受取先などが不正なら null。
 */
export function handleStorefrontConfig(
  record: HandleRecord,
  handle: string,
): MobileOrderConfig | null {
  const sf = record.storefront;
  if (!sf) return null;
  // ブランディングは storefront (ビルダー由来) を優先し、無ければ @handle 側へフォールバック。
  // 受取先 (receiver) は @handle が権威 (config.to)。
  return validateOrderConfig({
    receiver: record.config.to,
    chain: sf.chain,
    chains: sf.chains, // 受取チェーン集合 (2 件以上で注文ページに選択 UI)
    shopName: sf.shopName || record.config.name?.trim() || `@${handle}`,
    tagline: sf.tagline, // 店名下のひとこと (ビルダー由来のみ・任意・validateOrderConfig が再検証)
    accent: record.config.color, // テーマ色 = @handle のプロフィール色を店舗ページにも適用 (validateOrderConfig が再検証)
    avatar: sf.avatar ?? record.profile?.avatar,
    cover: sf.cover, // 店舗カバー画像 (storefront 専用・validateOrderConfig が再検証)
    mode: sf.mode,
    feePayer: sf.feePayer,
    socials: sf.socials ?? record.profile?.socials ?? [],
    menu: sf.menu,
    // 店舗情報 (任意)。storefront に保存された値をそのまま公開ページへ (validateOrderConfig が再検証)。
    address: sf.address,
    hours: sf.hours,
    phone: sf.phone,
    acceptingOrders: sf.acceptingOrders,
    dineIn: sf.dineIn, // 提供形態 (店内ならテーブル番号入力・validateOrderConfig が再検証)
  });
}

// config → TipParams (TipForm / OGP に渡す)。to は保存時に検証済みなので Address とみなす。
export function configToTipParams(config: PublishableTipConfig): TipParams {
  return { ...config, to: config.to as Address };
}

// config → tip クエリ (parseTipParams で再検証するため。buildTipPath と対称)。
export function configToSearchParams(
  config: PublishableTipConfig,
): URLSearchParams {
  const path = buildTipPath(configToTipParams(config));
  const qi = path.indexOf('?');
  return new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
}

// 検証済み TipParams → 保存 config (to を string 化)。reserve 時に parseTipParams を
// 通した結果を正規形として保存するために使う。
export function tipParamsToConfig(params: TipParams): PublishableTipConfig {
  return { ...params, to: params.to };
}

export type ValidatedConfig =
  | { ok: true; config: PublishableTipConfig }
  | { ok: false; error: string };

// API が受け取った任意の config を、既存 parseTipParams で意味的に検証して正規化する。
// to/token/chain/gasless 整合・sanitize はすべて parseTipParams に委譲 (tip URL と同一規則)。
// 不正は error を返す (throw しない)。保存するのは parse 済みの正規形。
export function validateTipConfig(raw: unknown): ValidatedConfig {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'config required' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.to !== 'string' || typeof r.token !== 'string') {
    return { ok: false, error: 'to and token are required' };
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const candidate: PublishableTipConfig = {
    to: r.to,
    token: r.token as TokenSymbol,
    chain: typeof r.chain === 'string' ? (r.chain as ChainSlug) : undefined,
    name: str(r.name),
    message: str(r.message),
    color: str(r.color),
    presets: Array.isArray(r.presets)
      ? r.presets.filter((p): p is string => typeof p === 'string')
      : undefined,
    thanks: str(r.thanks),
    thanksUrl: str(r.thanksUrl),
    webhook: str(r.webhook),
    crossChain: typeof r.crossChain === 'boolean' ? r.crossChain : undefined,
  };
  // configToSearchParams + parseTipParams で tip URL と全く同じ検証を通す。
  const parsed = parseTipParams(candidate.to, configToSearchParams(candidate));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, config: tipParamsToConfig(parsed.params) };
}

// 受取方法 + 共有設定 → 単一 PublishableTipConfig (検証 / TipForm 描画の橋渡し)。
// presets は token 別なので該当 token のリストを選ぶ。crossChain は USDC のみ。
export function methodToPublishableConfig(
  config: HandleTipConfig,
  method: HandleReceiveMethod,
): PublishableTipConfig {
  return {
    to: config.to,
    token: method.token,
    chain: method.chain,
    name: config.name,
    message: config.message,
    color: config.color,
    presets: config.presets?.[method.token],
    thanks: config.thanks,
    thanksUrl: config.thanksUrl,
    webhook: config.webhook,
    crossChain: method.token === 'usdc' ? method.crossChain : undefined,
  };
}

export type ValidatedHandleConfig =
  | { ok: true; config: HandleTipConfig }
  | { ok: false; error: string };

// @handle のマルチ方法 tip 設定を検証する。各方法を PublishableTipConfig に展開して既存
// validateTipConfig (= parseTipParams 委譲) を通すため、token/chain/gasless 整合・sanitize は
// tip URL と完全に同一規則。gasless 非対応や不正な方法は除外し、有効方法が 0 なら error。
// 共有 identity (to/name/message/color/thanks…) は最初の有効方法の正規化結果を採用する。
export function validateHandleTipConfig(raw: unknown): ValidatedHandleConfig {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'config required' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.to !== 'string') {
    return { ok: false, error: 'to is required' };
  }
  const rawMethods = Array.isArray(r.methods) ? r.methods : [];
  if (rawMethods.length === 0) {
    return { ok: false, error: 'at least one receive method is required' };
  }
  if (rawMethods.length > MAX_RECEIVE_METHODS) {
    return { ok: false, error: 'too many receive methods' };
  }
  const presetsIn =
    r.presets && typeof r.presets === 'object' && !Array.isArray(r.presets)
      ? (r.presets as Record<string, unknown>)
      : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const shared = {
    name: str(r.name),
    message: str(r.message),
    color: str(r.color),
    thanks: str(r.thanks),
    thanksUrl: str(r.thanksUrl),
    webhook: str(r.webhook),
  };

  const seen = new Set<string>();
  const methods: HandleReceiveMethod[] = [];
  const presetsOut: Partial<Record<TokenSymbol, string[]>> = {};
  let canonical: PublishableTipConfig | null = null;

  for (const m of rawMethods) {
    if (typeof m !== 'object' || m === null) continue;
    const mm = m as Record<string, unknown>;
    if (typeof mm.token !== 'string' || typeof mm.chain !== 'string') continue;
    const token = mm.token as TokenSymbol;
    const tokenPresets = Array.isArray(presetsIn[token])
      ? (presetsIn[token] as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        )
      : undefined;
    const candidate: PublishableTipConfig = {
      to: r.to,
      token,
      chain: mm.chain as ChainSlug,
      ...shared,
      presets: tokenPresets,
      crossChain: typeof mm.crossChain === 'boolean' ? mm.crossChain : undefined,
    };
    // 既存 tip URL と全く同じ検証 (gasless 非対応の (token,chain) はここで弾かれる)。
    const parsed = validateTipConfig(candidate);
    if (!parsed.ok) continue;
    const pc = parsed.config;
    const key = `${pc.token}:${pc.chain ?? ''}`;
    if (seen.has(key)) continue; // 同 token+chain は dedupe
    seen.add(key);
    methods.push({
      token: pc.token,
      chain: pc.chain as ChainSlug,
      crossChain: pc.token === 'usdc' ? pc.crossChain : undefined,
    });
    if (pc.presets && pc.presets.length > 0) presetsOut[pc.token] = pc.presets;
    if (!canonical) canonical = pc; // 最初の有効方法 = 正規化済み identity の源
  }

  if (!canonical || methods.length === 0) {
    return { ok: false, error: 'no valid receive method' };
  }
  const config: HandleTipConfig = {
    to: canonical.to,
    name: canonical.name,
    message: canonical.message,
    color: canonical.color,
    thanks: canonical.thanks,
    thanksUrl: canonical.thanksUrl,
    webhook: canonical.webhook,
    methods,
    presets: Object.keys(presetsOut).length > 0 ? presetsOut : undefined,
  };
  return { ok: true, config };
}

function isHttpsUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'https:';
}

export type ValidatedProfile =
  | { ok: true; profile: HandleProfile }
  | { ok: false; error: string };

// link-in-bio プロフィールの厳格検証 (書き込み経路)。https 限定・本数/長さ上限。
// 全フィールド空なら {} (= profile 無し扱い)。不正は error (黙ってドロップしない)。
export function validateProfile(raw: unknown): ValidatedProfile {
  if (raw === undefined || raw === null) return { ok: true, profile: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid profile' };
  }
  const r = raw as Record<string, unknown>;
  const profile: HandleProfile = {};

  if (r.bio !== undefined && r.bio !== null) {
    if (typeof r.bio !== 'string') return { ok: false, error: 'bio must be string' };
    const bio = r.bio.trim();
    if (bio.length > MAX_BIO_LEN) return { ok: false, error: 'bio too long' };
    if (bio) profile.bio = bio;
  }

  if (r.avatar !== undefined && r.avatar !== null && r.avatar !== '') {
    if (typeof r.avatar !== 'string') {
      return { ok: false, error: 'avatar must be string' };
    }
    const avatar = r.avatar.trim();
    if (avatar) {
      if (avatar.length > MAX_AVATAR_URL_LEN) {
        return { ok: false, error: 'avatar url too long' };
      }
      if (!isHttpsUrl(avatar)) {
        return { ok: false, error: 'avatar must be an https url' };
      }
      profile.avatar = avatar;
    }
  }

  if (r.socials !== undefined && r.socials !== null) {
    if (!Array.isArray(r.socials)) {
      return { ok: false, error: 'socials must be an array' };
    }
    if (r.socials.length > MAX_SOCIAL_LINKS) {
      return { ok: false, error: 'too many socials' };
    }
    const socials: string[] = [];
    for (const s of r.socials) {
      if (typeof s !== 'string') {
        return { ok: false, error: 'invalid social url' };
      }
      const url = s.trim();
      if (!url) return { ok: false, error: 'social url is required' };
      if (url.length > MAX_LINK_URL_LEN) {
        return { ok: false, error: 'social url too long' };
      }
      if (!isHttpsUrl(url)) {
        return { ok: false, error: 'social url must be https' };
      }
      socials.push(url);
    }
    if (socials.length > 0) profile.socials = socials;
  }

  if (r.links !== undefined && r.links !== null) {
    if (!Array.isArray(r.links)) return { ok: false, error: 'links must be an array' };
    if (r.links.length > MAX_PROFILE_LINKS) {
      return { ok: false, error: 'too many links' };
    }
    const links: HandleLink[] = [];
    for (const l of r.links) {
      if (typeof l !== 'object' || l === null) {
        return { ok: false, error: 'invalid link' };
      }
      const ll = l as Record<string, unknown>;
      if (typeof ll.label !== 'string' || typeof ll.url !== 'string') {
        return { ok: false, error: 'invalid link' };
      }
      const label = ll.label.trim();
      const url = ll.url.trim();
      if (!label) return { ok: false, error: 'link label is required' };
      if (label.length > MAX_LINK_LABEL_LEN) {
        return { ok: false, error: 'link label too long' };
      }
      if (url.length > MAX_LINK_URL_LEN) {
        return { ok: false, error: 'link url too long' };
      }
      if (!isHttpsUrl(url)) {
        return { ok: false, error: 'link url must be https' };
      }
      links.push({ label, url });
    }
    if (links.length > 0) profile.links = links;
  }

  return { ok: true, profile };
}

const STRING_KEYS = [
  'name',
  'message',
  'color',
  'thanks',
  'thanksUrl',
  'webhook',
] as const;

// token 別 presets を構造のみ検証 (旧形 = 単一 string[] / 新形 = token→string[])。
function normalizeStoredPresets(
  raw: unknown,
  fallbackToken: TokenSymbol,
): Partial<Record<TokenSymbol, string[]>> | undefined {
  if (Array.isArray(raw)) {
    // 旧 single-config: presets は単一 token のリスト → その token に割当。
    const arr = raw.filter((p): p is string => typeof p === 'string');
    return arr.length > 0 ? { [fallbackToken]: arr } : undefined;
  }
  if (raw && typeof raw === 'object') {
    const pin = raw as Record<string, unknown>;
    const out: Partial<Record<TokenSymbol, string[]>> = {};
    for (const tok of TOKEN_SYMBOLS) {
      if (Array.isArray(pin[tok])) {
        const arr = (pin[tok] as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        );
        if (arr.length > 0) out[tok] = arr;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

// KV JSON の config を HandleTipConfig へ構造検証 + 旧 single-config を migration。
// 新形 = { to, methods:[{token,chain,crossChain?}], presets:{token→[]} }。
// 旧形 = { to, token, chain?, crossChain?, presets:[] } → methods:[1件] へ畳む。
// 意味的整合 (gasless 等) は呼出側が methodToPublishableConfig + parseTipParams で再検証する。
function normalizeStoredConfig(raw: unknown): HandleTipConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.to !== 'string') return null;
  for (const k of STRING_KEYS) {
    if (c[k] !== undefined && typeof c[k] !== 'string') return null;
  }

  let methods: HandleReceiveMethod[];
  let presetFallbackToken: TokenSymbol;

  if (Array.isArray(c.methods)) {
    const parsed: HandleReceiveMethod[] = [];
    for (const m of c.methods) {
      if (typeof m !== 'object' || m === null) return null;
      const mm = m as Record<string, unknown>;
      if (typeof mm.token !== 'string' || typeof mm.chain !== 'string') {
        return null;
      }
      if (mm.crossChain !== undefined && typeof mm.crossChain !== 'boolean') {
        return null;
      }
      parsed.push({
        token: mm.token as TokenSymbol,
        chain: mm.chain as ChainSlug,
        crossChain: mm.crossChain as boolean | undefined,
      });
    }
    if (parsed.length === 0) return null;
    methods = parsed;
    presetFallbackToken = parsed[0].token;
  } else if (typeof c.token === 'string') {
    // 旧 single-config を migration。
    if (c.chain !== undefined && typeof c.chain !== 'string') return null;
    if (c.crossChain !== undefined && typeof c.crossChain !== 'boolean') {
      return null;
    }
    const token = c.token as TokenSymbol;
    const chain = (
      typeof c.chain === 'string' ? c.chain : DEFAULT_CHAIN_FOR_SYMBOL[token]
    ) as ChainSlug;
    methods = [
      {
        token,
        chain,
        crossChain: typeof c.crossChain === 'boolean' ? c.crossChain : undefined,
      },
    ];
    presetFallbackToken = token;
  } else {
    return null;
  }

  return {
    to: c.to,
    name: c.name as string | undefined,
    message: c.message as string | undefined,
    color: c.color as string | undefined,
    thanks: c.thanks as string | undefined,
    thanksUrl: c.thanksUrl as string | undefined,
    webhook: c.webhook as string | undefined,
    methods,
    presets: normalizeStoredPresets(c.presets, presetFallbackToken),
  };
}

// KV JSON の profile を寛容に読む (読み取り経路)。壊れたフィールドは個別に落とし、
// 有効な分だけ返す (profile の破損で @handle の tip 全体が落ちないようにする)。書込側の
// validateProfile は厳格 (error) だが、読込側は best-effort で可用性を優先する。
function parseStoredProfile(raw: unknown): HandleProfile | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const profile: HandleProfile = {};
  if (typeof r.bio === 'string') {
    const bio = r.bio.trim();
    if (bio) profile.bio = bio.slice(0, MAX_BIO_LEN);
  }
  if (typeof r.avatar === 'string') {
    const avatar = r.avatar.trim();
    if (avatar && avatar.length <= MAX_AVATAR_URL_LEN && isHttpsUrl(avatar)) {
      profile.avatar = avatar;
    }
  }
  if (Array.isArray(r.socials)) {
    const socials: string[] = [];
    for (const s of r.socials) {
      if (socials.length >= MAX_SOCIAL_LINKS) break;
      if (typeof s !== 'string') continue;
      const url = s.trim();
      if (!url || url.length > MAX_LINK_URL_LEN || !isHttpsUrl(url)) continue;
      socials.push(url);
    }
    if (socials.length > 0) profile.socials = socials;
  }
  if (Array.isArray(r.links)) {
    const links: HandleLink[] = [];
    for (const l of r.links) {
      if (links.length >= MAX_PROFILE_LINKS) break;
      if (typeof l !== 'object' || l === null) continue;
      const ll = l as Record<string, unknown>;
      if (typeof ll.label !== 'string' || typeof ll.url !== 'string') continue;
      const label = ll.label.trim();
      const url = ll.url.trim();
      if (!label || url.length > MAX_LINK_URL_LEN || !isHttpsUrl(url)) continue;
      links.push({ label: label.slice(0, MAX_LINK_LABEL_LEN), url });
    }
    if (links.length > 0) profile.links = links;
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}

// KV JSON → HandleRecord の型ガード。config は構造のみ検証 + 旧形 migration、profile は
// 寛容に読む (token/chain の意味的整合は呼出側が parseTipParams で再検証する)。malformed は null。
export function parseHandleRecord(json: string | null): HandleRecord | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.owner !== 'string' ||
    typeof rec.createdAt !== 'number' ||
    typeof rec.updatedAt !== 'number'
  ) {
    return null;
  }
  const config = normalizeStoredConfig(rec.config);
  if (!config) return null;
  const profile = parseStoredProfile(rec.profile);
  // storefront も寛容に読む (壊れていれば店舗無し扱い・@handle の tip/profile は落とさない)。
  // 検証規則は mobileOrder と単一情報源 (validateStorefrontParts)。
  const storefront = validateStorefrontParts(rec.storefront);
  const record: HandleRecord = {
    owner: rec.owner,
    config,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (profile) record.profile = profile;
  if (storefront) record.storefront = storefront;
  return record;
}

export function serializeHandleRecord(record: HandleRecord): string {
  return JSON.stringify(record);
}
