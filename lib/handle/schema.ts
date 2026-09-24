// @handle の保存 schema 層 (browser-safe)。保存 record (HandleRecord) とその構成要素
// (tip 設定・受取方法・profile・リンク) の型、profile の上限と enum、フィールド helper を置く。
// 厳格な書き込み検証 (profile / tipConfig) と tolerant な保存済み読み出し (record) の共通の土台。
// 1 モジュールだけが使う検証用の型・定数はそのモジュールに置く (ここを寄せ集めにしない)。
import type { TokenSymbol } from '@/lib/tokens';
import type { ChainSlug } from '@/lib/chains';
import type { StorefrontParts } from '@/lib/mobileOrder';
import type { HandleTheme } from '@/lib/handleThemeKey';

// @handle プロフィール (link-in-bio) の上限。乱用・肥大化抑制。
// 20 = lit.link 級のリンク集を収める実用上限 (見出し行と共有)。技術制約ではなく体験の上限:
// 最悪ケース (20 本 × label40+url512+imageUrl512) でも record は ~24KB と
// KV の余裕内・描画/OG 影響なし。
// 6 → 20 引き上げ (2026-07-29 user 要望・見出し行の導入でリスト長の整理が可能になったため)。
export const MAX_PROFILE_LINKS = 20;
export const MAX_BIO_LEN = 160;
export const MAX_LINK_LABEL_LEN = 40;
export const MAX_LINK_URL_LEN = 512;
export const MAX_AVATAR_URL_LEN = 512;
export const MAX_COVER_URL_LEN = MAX_AVATAR_URL_LEN;
export const HANDLE_FONTS = ['sans', 'serif', 'rounded'] as const;
export type HandleFont = (typeof HANDLE_FONTS)[number];
export const HANDLE_LINK_LAYOUTS = ['list', 'grid'] as const;
export type HandleLinkLayout = (typeof HANDLE_LINK_LAYOUTS)[number];

export function isHandleFont(value: unknown): value is HandleFont {
  return HANDLE_FONTS.some((font) => font === value);
}

export function isHandleLinkLayout(value: unknown): value is HandleLinkLayout {
  return HANDLE_LINK_LAYOUTS.some((layout) => layout === value);
}

export const MAX_LINK_IMAGE_URL_LEN = 512;
// 外部 iframe の同時読込・ページ重量を抑える profile 単位の上限。server 保存時に enforce。
export const MAX_PROFILE_EMBEDS = 3;
// SNS アイコンリンク (URL のみ保存・アイコンは lib/socialLinks がドメイン判定) の上限。
// SNS アイコン行の上限。対応 22 プラットフォームに対し 6 は窮屈 (user 指摘)。10 なら
// モバイル幅でも 2 行以内に収まり、record サイズも +~5KB 上限で問題なし。
export const MAX_SOCIAL_LINKS = 10;

// @handle が公開する1つの受取方法 (支払者が選ぶ)。全方法は同一受取アドレス (config.to)
// に着金する。JPYC は Polygon/Kaia に同アドレスで存在、USDC cross-chain も同アドレス宛。
export interface HandleReceiveMethod {
  token: TokenSymbol;
  chain: ChainSlug;
  // USDC のみ意味あり (cross-chain 受取の許可)。JPYC では無視。
  crossChain?: boolean;
}

// link-in-bio の外部リンク。url は https のみ (javascript:/data:/http: を排除)。
// 既存レコード/送信 payload のバイト列を維持するため、通常リンクには kind を付けない。
export interface HandleRegularLink {
  kind?: never;
  label: string;
  url: string;
  // 先頭に表示する絵文字 (任意・最大 2 code points)。テキストとして描画 (HTML 解釈なし)。
  emoji?: string;
  // 「注目」= 少し大きく強調するリンク (プロフィール全体で最大 1 本・保存時に enforce)。
  featured?: boolean;
  // リンク先を示す小画像 (任意・https URL のみ・最大 512 文字)。
  // 未指定なら従来どおり絵文字を表示する。
  imageUrl?: string;
  // 対応済み provider URL だけを埋め込みカードとして描画する。
  embed?: true;
  // Audius の公開 URL には track ID が無いため、保存時に server が解決した値だけを保持する。
  // client payload の値は route 層で除去・再導出する。
  embedResolved?: HandleEmbedResolved;
}

export interface HandleEmbedResolved {
  provider: 'audius';
  kind: 'track';
  id: string;
}

// リンク一覧内の非インタラクティブな区切り。url / featured は構造上も持たない。
export interface HandleHeading {
  kind: 'heading';
  label: string;
  emoji?: string;
}

export type HandleLink = HandleRegularLink | HandleHeading;

// @handle プロフィール (link-in-bio)。tip パラメータではないので config の sibling。
export interface HandleProfile {
  bio?: string;
  avatar?: string; // https URL (ホスティングはしない)
  cover?: string; // https URL (ホスティングはしない)
  font?: HandleFont;
  linkLayout?: HandleLinkLayout;
  // SNS プロフィール URL (https のみ)。アイコンは表示側がドメインから自動判定
  // (lib/socialLinks)。platform は保存しない (判定更新で既存データも追従)。
  socials?: string[];
  links?: HandleLink[];
  // 着せ替えテーマ (enum のみ・自由 CSS/画像アップロードなし)。未設定/不正は clean 扱い。
  theme?: HandleTheme;
}

// 絵文字入力の正規化: trim + 最大 2 code points。空/超過は undefined (link 自体は残す)。
// code point 単位で数える (絵文字 ZWJ 連結や補助面文字を割らない)。
export function sanitizeEmoji(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const cps = [...trimmed];
  if (cps.length > 2) return undefined;
  return trimmed;
}

// @handle 専用の保存 tip 設定。PublishableTipConfig (単一 token+chain) を
// 「共有受取アドレス + 受取方法の集合」へ一般化したもの。presets は token 別。
export interface HandleTipConfig {
  to: string;
  name?: string;
  message?: string;
  color?: string;
  theme?: HandleTheme;
  thanks?: string;
  thanksUrl?: string;
  webhook?: string;
  methods: HandleReceiveMethod[]; // 1..N
  presets?: Partial<Record<TokenSymbol, string[]>>;
}

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

export function isHttpsUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'https:';
}
