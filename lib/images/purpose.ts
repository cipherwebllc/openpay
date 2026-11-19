// 画像のアップロード (POST /api/images/upload) の、ブラウザと server で共有する定数と型。秘密や env を読まない
// (client の bundle に入る)。server だけの設定は lib/images/config.ts、Blob の操作は lib/images/blobStore.ts。
//
// 置き場は Vercel Blob の public store。保存する値は今と同じ「https の画像 URL の文字列」で、アップロードは
// その URL を作る手段を足すだけ (商品・プロフの保存の API と形は変えない)。

/** 画像の用途。path の 1 段 (`v1/<ownerKey>/<purpose>/<id>.<ext>`) になる。PR 1 で使うのは product だけ。 */
export const IMAGE_PURPOSES = ['product', 'avatar', 'cover', 'link', 'preset', 'storefront'] as const;
export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];

export function isImagePurpose(value: unknown): value is ImagePurpose {
  return typeof value === 'string' && (IMAGE_PURPOSES as readonly string[]).includes(value);
}

/**
 * 用途ごとの長辺 (px)。ブラウザの前処理 (lib/images/prepare.ts) がこの大きさまで縮める (拡大はしない)。
 * 表紙とギャラリー (product)・カバーは 1280、アバターと店のアイコン (storefront) は 512、リンクの小さな画像は 320、
 * レジの商品 (preset) は 800。
 */
export const IMAGE_MAX_EDGE: Record<ImagePurpose, number> = {
  product: 1280,
  cover: 1280,
  avatar: 512,
  storefront: 512,
  link: 320,
  preset: 800,
};

/**
 * モバイル注文の店のカバー (横長・注文ページのヘッダーの背景) の長辺。店のアイコンとカバーは同じ用途 (storefront・path の 1 段は
 * 1 つ) で、前処理の長辺だけを変える (アイコンは IMAGE_MAX_EDGE.storefront = 512)。
 */
export const STOREFRONT_COVER_MAX_EDGE = 1280;

/** 1 枚の上限 (server が本文をここまでしか読まない・ブラウザはこの内側に収める)。 */
export const IMAGE_UPLOAD_MAX_BYTES = 1024 * 1024;

/** 受け取る形式。ブラウザは JPEG・PNG・WebP を選ばせ、この 2 つのどちらかに描き直して送る (SVG は受けない)。 */
export const IMAGE_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export type ImageUploadMimeType = (typeof IMAGE_UPLOAD_MIME_TYPES)[number];

/** 画像を選ぶ欄の accept。 */
export const IMAGE_FIELD_ACCEPT = 'image/jpeg,image/png,image/webp';

export const IMAGE_UPLOAD_ENDPOINT = '/api/images/upload';

/** route が返す固定の code (応答の `error`)。 */
export const IMAGE_UPLOAD_ERROR_CODES = [
  'not_found',
  'cross_site_request',
  'rate_limited',
  'unauthenticated',
  'session_storage_unavailable',
  'forbidden',
  'not_configured',
  'invalid_purpose',
  'unsupported_media_type',
  'payload_too_large',
  'invalid_body',
  'invalid_image',
  'image_limit',
  'storage_unavailable',
  'upload_failed',
] as const;
export type ImageUploadErrorCode = (typeof IMAGE_UPLOAD_ERROR_CODES)[number];

export function isImageUploadErrorCode(value: unknown): value is ImageUploadErrorCode {
  return typeof value === 'string' && (IMAGE_UPLOAD_ERROR_CODES as readonly string[]).includes(value);
}

/** ウォレットごとに置いておける枚数。これ以上は 409 image_limit (消す手段は PR 3 の一覧)。 */
export const IMAGE_OWNER_MAX_IMAGES = 200;
/** 1 日 (UTC) の回数: ウォレットごと・IP ごと・全体。 */
export const IMAGE_UPLOAD_DAILY_PER_WALLET = 30;
export const IMAGE_UPLOAD_DAILY_PER_IP = 60;
export const IMAGE_UPLOAD_DAILY_GLOBAL = 200;
