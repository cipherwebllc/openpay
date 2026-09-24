// @handle 恒久クリエイターリンク (open-pay.jp/@alice) の純関数の facade。
// 実装は lib/handle/ 配下の 6 モジュールに分割 (R13):
//   normalize — handle 名の正規化・形式/予約語の判定・1 wallet あたりの claim 上限
//   tipConfig — 保存チップ設定 ↔ TipParams / tip クエリの相互変換と書き込み時の検証
//   embeds    — 埋め込み対応リンクの provider URL 解析と allowlist 済み iframe URL の再構築
//   profile   — link-in-bio プロフィールの厳格な書き込み検証
//   record    — 保存済み record の tolerant な読み出し・直列化と storefront 合成
//   schema    — 上記が共有する保存 record / tip 設定 / profile の型・上限・フィールド helper
// 公開 API は分割前と完全に同一。利用側の import と vi.mock は必ず `@/lib/handle` を通す
// (`lib/handle/*` の deep import は eslint.config.mjs が禁止)。lib/handle/* はこの facade を
// import しない。`@/lib/handle` が常にこのファイルへ解決されるよう lib/handle/index.ts は置かない。
//
// KV / SIWE には依存しない (= 単体テスト可能・client bundle に入る)。サーバ側の KV 操作は
// lib/handleStore.ts、API は app/api/handle/*、解決ページは [locale]/[handle]。
//
// セキュリティ前提:
//   - handle は ASCII 小文字英数字 + `_` のみ (homograph / IDN を排除)。
//   - 設定の意味的妥当性は既存の parseTipParams を再利用して担保 (token/chain/gasless 整合)。
//   - 予約語 = 既存ルート名 + locale + ブランド系 (成りすまし/混同の一次防御)。

export {
  MAX_HANDLES_PER_WALLET,
  HANDLE_PATTERN,
  RESERVED_HANDLES,
  decodeHandleSegment,
  normalizeHandle,
  isValidHandleFormat,
  isReserved,
  validateHandle,
} from './handle/normalize';
export type { HandleValidation } from './handle/normalize';

export {
  MAX_RECEIVE_METHODS,
  CLEARABLE_HANDLE_TIP_FIELDS,
  DEFAULT_RECEIVE_METHODS,
  configToTipParams,
  configToSearchParams,
  tipParamsToConfig,
  validateTipConfig,
  methodToPublishableConfig,
  validateHandleTipConfig,
} from './handle/tipConfig';
export type {
  PublishableTipConfig,
  ClearableHandleTipField,
  HandleTipConfigUpdate,
  ValidatedConfig,
  ValidatedHandleConfig,
} from './handle/tipConfig';

export {
  isAudiusHandleEmbedUrl,
  extractHandleEmbed,
  isHandleEmbedUrl,
} from './handle/embeds';
export type { HandleEmbed } from './handle/embeds';

export { validateProfile } from './handle/profile';
export type { ValidatedProfile } from './handle/profile';

export {
  handleStorefrontConfig,
  parseHandleRecord,
  serializeHandleRecord,
} from './handle/record';

// sanitizeEmoji / isHttpsUrl は lib/handle/* 内部の helper なので facade からは出さない。
export {
  MAX_PROFILE_LINKS,
  MAX_BIO_LEN,
  MAX_LINK_LABEL_LEN,
  MAX_LINK_URL_LEN,
  MAX_AVATAR_URL_LEN,
  MAX_COVER_URL_LEN,
  HANDLE_FONTS,
  HANDLE_LINK_LAYOUTS,
  isHandleFont,
  isHandleLinkLayout,
  MAX_LINK_IMAGE_URL_LEN,
  MAX_PROFILE_EMBEDS,
  MAX_SOCIAL_LINKS,
} from './handle/schema';
export type {
  HandleFont,
  HandleLinkLayout,
  HandleReceiveMethod,
  HandleRegularLink,
  HandleEmbedResolved,
  HandleHeading,
  HandleLink,
  HandleProfile,
  HandleTipConfig,
  HandleRecord,
} from './handle/schema';
